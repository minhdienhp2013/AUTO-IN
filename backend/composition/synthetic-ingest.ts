import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqlPool } from '../storage/database.js';
import { assertStaff, DomainError, type Principal } from '../core/model.js';

/** Synthetic-only staff import. NEVER equate this with downloading verified OA bytes. */
export interface SyntheticArtifactScope { shop_id: string; oa_id: string }
export interface SyntheticArtifactInput {
  event_id: string;
  filename: string;
  content_base64: string;
}
interface InboundRow {
  payload_json: { kind?: unknown; filename?: unknown; customer_id?: unknown; conversation_id?: unknown };
  customer_id: string;
  conversation_id: string;
}
interface StoredProof {
  artifact_ref: string; sha256: string; manifest_ref: string; manifest_sha256: string;
}
const maxBytes = 600 * 1024;
const extensions = new Set(['pdf','png','jpg','jpeg','tif','tiff','webp','bmp','doc','docx','xls','xlsx','csv','zip']);
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const fail = (code: string, status = 422): never => {
  throw new DomainError(code, 'Synthetic document import rejected', status);
};
function parseInput(input: unknown): { eventId: string; filename: string; bytes: Buffer; suffix: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_INPUT');
  const data = input as Partial<SyntheticArtifactInput>;
  if (typeof data.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.event_id) ||
      typeof data.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(data.filename) ||
      typeof data.content_base64 !== 'string' ||
      data.content_base64.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.content_base64))
    return fail('INVALID_ARTIFACT_UPLOAD');
  const suffix = data.filename.split('.').at(-1)?.toLowerCase() ?? '';
  if (!extensions.has(suffix)) return fail('UNSUPPORTED_ARTIFACT_FORMAT');
  const bytes = Buffer.from(data.content_base64, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== data.content_base64)
    return fail('INVALID_ARTIFACT_UPLOAD');
  return { eventId: data.event_id, filename: data.filename, bytes, suffix };
}
async function durableFile(filename: string, content: Buffer): Promise<void> {
  const handle = await open(filename, 'wx', 0o400);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}
/** Called only after AI1 session authentication and bound to the server's fixture OA. */
export async function ingestSyntheticArtifact(
  pool: SqlPool, artifactRoot: string, scope: SyntheticArtifactScope,
  actor: Principal, input: unknown
): Promise<{ status: 'registered' | 'existing'; kind: 'synthetic_fixture'; sha256: string; preview_trusted: false }> {
  assertStaff(actor);
  if (actor.shop_id !== scope.shop_id) return fail('FORBIDDEN', 403);
  const file = parseInput(input);
  const settings = await pool.query<{ mode: string }>('SELECT mode FROM core_shop_settings WHERE shop_id=$1', [scope.shop_id]);
  if (settings.rows[0]?.mode !== 'simulation') return fail('SIMULATION_REQUIRED', 409);
  const found = await pool.query<InboundRow>(
    'SELECT payload_json,customer_id,conversation_id FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',
    [scope.oa_id, file.eventId]
  );
  const event = found.rows[0];
  if (!event || !['file', 'image'].includes(String(event.payload_json.kind)) ||
      event.payload_json.filename !== file.filename ||
      event.payload_json.customer_id !== event.customer_id ||
      event.payload_json.conversation_id !== event.conversation_id)
    return fail('VERIFIED_EVENT_NOT_FOUND', 404);
  const digest = hash(file.bytes);
  const previous = await pool.query<StoredProof>(
    'SELECT artifact_ref,sha256,manifest_ref,manifest_sha256 FROM ai0_inbound_document_artifacts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
    [scope.shop_id, scope.oa_id, file.eventId]
  );
  if (previous.rows[0]) {
    if (previous.rows[0].sha256 !== digest) return fail('ARTIFACT_IMMUTABLE', 409);
    return { status: 'existing', kind: 'synthetic_fixture', sha256: digest, preview_trusted: false };
  }
  if (!artifactRoot) return fail('ARTIFACT_ROOT_NOT_CONFIGURED', 503);
  const rootInfo = await lstat(artifactRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o022))
    return fail('UNSAFE_ARTIFACT_ROOT', 503);
  const directory = await mkdtemp(join(artifactRoot, 'doc-'));
  const prefix = directory.split(/[\\/]/).at(-1)!;
  try {
    const source = 'source-000-' + digest + '.' + file.suffix;
    await durableFile(join(directory, source), file.bytes);
    const manifest = Buffer.from(JSON.stringify({
      schema: 'ai3.upload_snapshot.v1',
      files: [{ source_artifact_ref: prefix + '/' + source, file_sha256: digest, size_bytes: file.bytes.length }]
    }));
    await durableFile(join(directory, 'manifest.json'), manifest);
    const saved = await pool.query<{ artifact_ref: string }>(
      'INSERT INTO ai0_inbound_document_artifacts ' +
      '(shop_id,oa_id,event_id,conversation_id,customer_id,artifact_ref,sha256,manifest_ref,manifest_sha256) ' +
      'SELECT $1,$2,e.event_id,e.conversation_id,e.customer_id,$4,$5,$6,$7 ' +
      'FROM zalo_inbound_events e JOIN core_shop_settings s ON s.shop_id=$1 ' +
      'WHERE e.oa_id=$2 AND e.event_id=$3 AND s.mode=\'simulation\' ' +
      'AND e.payload_json->>\'kind\' IN (\'file\',\'image\') AND e.payload_json->>\'filename\'=$8 ' +
      'ON CONFLICT (shop_id,oa_id,event_id) DO NOTHING RETURNING artifact_ref',
      [scope.shop_id,scope.oa_id,file.eventId,prefix+'/'+source,digest,prefix+'/manifest.json',hash(manifest),file.filename]
    );
    if (saved.rowCount === 1) return { status: 'registered', kind: 'synthetic_fixture', sha256: digest, preview_trusted: false };
    // A simultaneous import won. Recheck immutable content, never replace its proof.
    const raced = await pool.query<StoredProof>(
      'SELECT artifact_ref,sha256,manifest_ref,manifest_sha256 FROM ai0_inbound_document_artifacts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
      [scope.shop_id,scope.oa_id,file.eventId]
    );
    if (raced.rows[0]?.sha256 !== digest) return fail('ARTIFACT_IMMUTABLE', 409);
    return { status: 'existing', kind: 'synthetic_fixture', sha256: digest, preview_trusted: false };
  } finally {
    // Registered artifacts must remain immutable: only remove the losing scratch directory.
    const row = await pool.query<{ artifact_ref: string }>(
      'SELECT artifact_ref FROM ai0_inbound_document_artifacts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
      [scope.shop_id,scope.oa_id,file.eventId]).catch(() => null);
    // On database uncertainty, retain private bytes for manual reconciliation;
    // NEVER risk deleting a snapshot whose transaction may have committed.
    if (row && row.rows[0]?.artifact_ref?.split('/')[0] !== prefix)
      await rm(directory, {recursive:true,force:true});
  }
}
