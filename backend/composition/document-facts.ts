import { spawn } from 'node:child_process';
import type pg from 'pg';
import type { Batch } from '../conversation/batch.js';
import type { DocumentFactsPort } from '../conversation/processor.js';
import type { DocumentFact } from '../conversation/rules.js';

interface ArtifactProof {
  artifact_ref: string;
  sha256: string;
  manifest_ref: string;
  manifest_sha256: string;
}
interface DocumentScope { shop_id: string; oa_id: string }
interface DocumentOptions { artifactRoot?: string; python?: string }

const unknown = (): DocumentFact => ({ kind: 'unknown', preview_trusted: false });
const kinds = new Set(['pdf', 'word', 'image', 'excel', 'unknown', 'zip']);

async function inspectWithAi3(batch: ArtifactProof[], root: string, python: string): Promise<DocumentFact[]> {
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(python, ['-m', 'workers.documents.fact_inspect',
      '--artifact-root', root, '--timeout-seconds', '45'], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, PYTHONPATH: process.cwd(), PYTHONNOUSERSITE: '1' }
    });
    const parts: Buffer[] = [];
    let length = 0, done = false;
    const timer = setTimeout(() => fail(), 50_000);
    const fail = () => { if (done) return; done = true; clearTimeout(timer);
      child.kill('SIGKILL'); reject(new Error('DOCUMENT_INSPECTION_UNAVAILABLE')); };
    child.stdout.on('data', (part: Buffer) => {
      length += part.length;
      if (length > 256 * 1024) fail(); else parts.push(part);
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', code => { if (done) return; done = true; clearTimeout(timer);
      if (code === 0 || code === 2) resolve(Buffer.concat(parts));
      else reject(new Error('DOCUMENT_INSPECTION_UNAVAILABLE'));
    });
    child.stdin.end(JSON.stringify({ batch }));
  });
  const result: unknown = JSON.parse(output.toString('utf8'));
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('DOCUMENT_INSPECTION_INVALID');
  const value = result as { schema?: unknown; status?: unknown; facts?: unknown };
  if (value.schema !== 'ai3.document_facts.v1' ||
      !['READY', 'NEEDS_HUMAN'].includes(String(value.status)) ||
      !Array.isArray(value.facts) || value.facts.length !== batch.length)
    throw new Error('DOCUMENT_INSPECTION_INVALID');
  return value.facts.map((fact: unknown) => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return unknown();
    const item = fact as DocumentFact;
    return kinds.has(item.kind) &&
      (item.preview_trusted === undefined || typeof item.preview_trusted === 'boolean') &&
      (item.count_inside === undefined || Number.isSafeInteger(item.count_inside)) ? item : unknown();
  });
}

/** Server DB binds each verified event to a private manifest and its independent SHA. */
export function createTrustedDocumentFactsPort(
  pool: pg.Pool, scope: DocumentScope, options: DocumentOptions = {}
): DocumentFactsPort {
  return { async inspect(batch: Batch): Promise<DocumentFact[]> {
    const events = batch.events.filter(event => event.kind !== 'text');
    if (!events.length) return [];
    if (events.length > 20 || !options.artifactRoot || events.some(event =>
      event.kind !== 'file' && event.kind !== 'image' || event.oa_id !== scope.oa_id))
      return events.map(unknown);
    const proofs: ArtifactProof[] = [];
    try {
      for (const event of events) {
        const result = await pool.query<ArtifactProof>(`
          SELECT a.artifact_ref,a.sha256,a.manifest_ref,a.manifest_sha256
          FROM ai0_inbound_document_artifacts a
          JOIN zalo_inbound_events e USING(oa_id,event_id)
          WHERE a.shop_id=$1 AND a.oa_id=$2 AND a.event_id=$3
            AND a.customer_id=$4 AND a.conversation_id=$5
            AND e.customer_id=$4 AND e.conversation_id=$5`,
        [scope.shop_id, scope.oa_id, event.event_id, event.customer_id, event.conversation_id]);
        const proof = result.rows[0];
        if (result.rows.length !== 1 || !proof) return events.map(unknown);
        proofs.push(proof);
      }
      return await inspectWithAi3(proofs, options.artifactRoot, options.python ?? 'python3');
    } catch {
      return events.map(unknown);
    }
  } };
}
