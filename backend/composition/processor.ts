import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DomainError, type PrintPlan } from '../core/model.js';

type BridgeResult = {
  schema: string; status: 'READY' | 'NEEDS_HUMAN'; reason_code?: string;
  plan?: PrintPlan; content_settings_sha256?: string;
};
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function scopedRef(root: string, ref: string): string {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(ref) || ref.includes('..'))
    throw new DomainError('UNSAFE_ARTIFACT_REF', 'Invalid processor artifact', 422);
  const target = resolve(root, ref);
  if (!target.startsWith(resolve(root) + sep))
    throw new DomainError('UNSAFE_ARTIFACT_REF', 'Invalid processor artifact', 422);
  return target;
}
export interface ProcessorOptions {
  inputRoot: string; artifactRoot: string; python?: string; timeoutMs?: number;
}

/** Calls AI3 CLI with a bounded request/response; never invokes a print driver. */
export async function inspectDocumentRequest(
  requestData: unknown, expectedRequestHash: string, options: ProcessorOptions
): Promise<{ plan: PrintPlan; evidenceHash: string }> {
  if (!options.inputRoot || !options.artifactRoot || !/^[a-f0-9]{64}$/.test(expectedRequestHash))
    throw new DomainError('PROCESSOR_CONFIG_REQUIRED', 'Processor unavailable', 503);
  const input = Buffer.from(JSON.stringify({ request_data: requestData,
    expected_request_hash: expectedRequestHash }));
  if (input.length > 256 * 1024) throw new DomainError('PROCESSOR_INPUT_TOO_LARGE', 'Document request too large');
  const timeout = options.timeoutMs ?? 50_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 120_000)
    throw new DomainError('PROCESSOR_CONFIG_REQUIRED', 'Invalid processor timeout', 503);
  const output = await new Promise<Buffer>((resolveOutput, rejectOutput) => {
    const child = spawn(options.python ?? 'python3', ['-m', 'workers.documents.bridge',
      '--input-root', options.inputRoot, '--artifact-root', options.artifactRoot,
      '--timeout-seconds', String(Math.max(1, Math.floor((timeout - 500) / 1000)))],
    { stdio: ['pipe', 'pipe', 'ignore'], cwd: process.cwd(), env: {
      PATH: process.env.PATH, PYTHONPATH: process.cwd(), PYTHONNOUSERSITE: '1'
    } });
    const chunks: Buffer[] = [];
    let length = 0;
    let finished = false;
    const fail = () => { if (!finished) { finished = true; child.kill('SIGKILL');
      rejectOutput(new DomainError('PROCESSOR_UNAVAILABLE', 'Processor unavailable', 503, true)); } };
    const timer = setTimeout(fail, timeout);
    child.stdout.on('data', (part: Buffer) => { length += part.length;
      if (length > 256 * 1024) fail(); else chunks.push(part); });
    child.on('error', fail);
    child.on('close', (code) => { clearTimeout(timer);
      if (!finished) { finished = true;
        if (code === 0 || code === 2) resolveOutput(Buffer.concat(chunks)); else
          rejectOutput(new DomainError('PROCESSOR_UNAVAILABLE', 'Processor unavailable', 503, true));
      } });
    child.stdin.on('error', fail);
    child.stdin.end(input);
  });
  let value: BridgeResult;
  try { value = JSON.parse(output.toString('utf8')) as BridgeResult; }
  catch { throw new DomainError('PROCESSOR_UNVERIFIED', 'Processor result not verified', 503); }
  if (value.schema !== 'ai3.document_bridge.v1' || value.status !== 'READY' ||
      !value.plan?.ready || value.plan.request_hash !== expectedRequestHash ||
      !/^[a-f0-9]{64}$/.test(value.content_settings_sha256 ?? ''))
    throw new DomainError('PROCESSOR_NEEDS_HUMAN', 'Document needs staff review', 422);
  const manifest = scopedRef(options.artifactRoot, value.plan.artifact_ref);
  let raw: Buffer;
  try {
    const file = await open(manifest, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 256 * 1024) throw new Error('Invalid manifest');
      raw = await file.readFile();
    } finally { await file.close(); }
  }
  catch { throw new DomainError('PROCESSOR_UNVERIFIED', 'Processor artifact not available', 503); }
  if (raw.length > 256 * 1024) throw new DomainError('PROCESSOR_UNVERIFIED', 'Processor manifest too large', 503);
  let parsed: {request_hash?: string; content_settings_sha256?: string; files?: unknown[]};
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch { throw new DomainError('PROCESSOR_UNVERIFIED', 'Processor manifest invalid', 503); }
  if (parsed.request_hash !== expectedRequestHash ||
      parsed.content_settings_sha256 !== value.content_settings_sha256 ||
      !Array.isArray(parsed.files) || !parsed.files.length)
    throw new DomainError('PROCESSOR_UNVERIFIED', 'Processor evidence mismatch', 503);
  return { plan: value.plan, evidenceHash: sha(raw) };
}
