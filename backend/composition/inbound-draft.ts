import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { assertStaff, canonical, DomainError, type Principal } from '../core/model.js';
import type { OrderService } from '../core/service.js';
import type { SqlPool } from '../storage/database.js';
import type { SyntheticArtifactScope } from './synthetic-ingest.js';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const sourcePattern = /^doc-[A-Za-z0-9_-]{6,64}\/source-000-([a-f0-9]{64})\.(pdf|png|jpg|jpeg|tif|tiff|webp|bmp|doc|docx|xls|xlsx|csv|zip)$/;
const fail = (code: string, status = 409): never => {
  throw new DomainError(code, 'Synthetic inbound source needs staff review', status);
};
interface RegisteredRow {
  artifact_ref: string; sha256: string; manifest_ref: string; manifest_sha256: string;
  customer_id: string; conversation_id: string;
  event_customer: string; event_conversation: string;
  payload_json: { kind?: unknown; filename?: unknown; customer_id?: unknown; conversation_id?: unknown };
}
interface DraftState { status: string; order_id: string | null; settings_sha256: string }
interface DraftSettings { event_id: string; paper: 'A4' | 'A3'; copies: number; duplex: boolean }
export interface SyntheticDraftResult {
  status: 'created' | 'existing';
  order_id: string; revision: 1; requires_customer_confirmation: true;
  preview_trusted: false;
}
function parseSettings(input: unknown): DraftSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_DRAFT_SETTINGS',422);
  const i=input as Record<string,unknown>;
  if (Object.keys(i).sort().join(',') !== 'copies,duplex,event_id,paper' ||
      typeof i.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(i.event_id) ||
      (i.paper !== 'A4' && i.paper !== 'A3') ||
      !Number.isSafeInteger(i.copies) || (i.copies as number)<1 || (i.copies as number)>20 ||
      typeof i.duplex !== 'boolean') return fail('INVALID_DRAFT_SETTINGS',422);
  return {event_id:i.event_id,paper:i.paper,copies:i.copies as number,duplex:i.duplex};
}
async function checkedRead(root: string, ref: string, max: number): Promise<Buffer> {
  const parts=ref.split('/');
  const directory=parts[0], name=parts[1];
  if (parts.length!==2 || !directory || !name ||
      !/^doc-[A-Za-z0-9_-]{6,64}$/.test(directory) ||
      !/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) return fail('UNTRUSTED_SOURCE_REF');
  const rootPath=resolve(root);
  const target=resolve(rootPath, ref);
  if (!target.startsWith(rootPath+sep)) return fail('UNTRUSTED_SOURCE_REF');
  const rootStat=await lstat(rootPath).catch(()=>null);
  const dirStat=await lstat(resolve(rootPath,directory)).catch(()=>null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode&0o022) ||
      !dirStat?.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode&0o022))
    return fail('UNTRUSTED_ARTIFACT_STORAGE',503);
  let fd;
  try {
    fd=await open(target, constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await fd.stat();
    if (!stat.isFile() || stat.size<1 || stat.size>max) return fail('UNTRUSTED_SOURCE_BYTES');
    const data=await fd.readFile();
    if (data.length!==stat.size) return fail('UNTRUSTED_SOURCE_BYTES');
    return data;
  } catch { return fail('SOURCE_UNAVAILABLE'); }
  finally { await fd?.close(); }
}
/** Authenticates both the server-owned PG index and its frozen source/manifest.
 * Does not trust webhook file_ref, customer identifiers from the caller, or filename metadata. */
export async function verifiedSyntheticSource(
  pool: SqlPool, root: string, scope: SyntheticArtifactScope, eventId: string
): Promise<{ customer_id: string; conversation_id: string; artifact_ref: string; sha256: string }> {
  if (!root || !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)) return fail('INVALID_EVENT_ID',422);
  const row=(await pool.query<RegisteredRow>(
    'SELECT a.artifact_ref,a.sha256,a.manifest_ref,a.manifest_sha256,'+
    'a.customer_id,a.conversation_id,e.customer_id AS event_customer,'+
    'e.conversation_id AS event_conversation,e.payload_json '+
    'FROM ai0_inbound_document_artifacts a '+
    'JOIN zalo_inbound_events e ON e.oa_id=a.oa_id AND e.event_id=a.event_id '+
    'JOIN core_shop_settings s ON s.shop_id=a.shop_id '+
    'WHERE a.shop_id=$1 AND a.oa_id=$2 AND a.event_id=$3 AND s.mode=\'simulation\'',
    [scope.shop_id,scope.oa_id,eventId])).rows[0];
  if (!row || !row.customer_id || !row.conversation_id ||
      row.customer_id!==row.event_customer || row.conversation_id!==row.event_conversation ||
      !['file','image'].includes(String(row.payload_json?.kind)) ||
      row.payload_json.customer_id!==row.customer_id ||
      row.payload_json.conversation_id!==row.conversation_id ||
      !digestPattern.test(row.sha256) || !digestPattern.test(row.manifest_sha256))
    return fail('REGISTERED_SOURCE_NOT_FOUND',404);
  const match=sourcePattern.exec(row.artifact_ref);
  if (!match || match[1]!==row.sha256 ||
      row.manifest_ref!==row.artifact_ref.split('/')[0]+'/manifest.json' ||
      typeof row.payload_json.filename!=='string' ||
      !row.payload_json.filename.toLowerCase().endsWith('.'+match[2])) return fail('UNTRUSTED_SOURCE_REF');
  const manifestBytes=await checkedRead(root,row.manifest_ref,256*1024);
  if (hash(manifestBytes)!==row.manifest_sha256) return fail('SOURCE_MANIFEST_CHANGED');
  let decoded:unknown;
  try {decoded=JSON.parse(manifestBytes.toString('utf8'));}
  catch {return fail('UNTRUSTED_SOURCE_MANIFEST');}
  if (!decoded || typeof decoded!=='object' || Array.isArray(decoded))
    return fail('UNTRUSTED_SOURCE_MANIFEST');
  const m=decoded as {schema?:unknown;files?:unknown};
  const entry=Array.isArray(m.files) ? m.files[0] as Record<string,unknown> | undefined : undefined;
  if (m.schema!=='ai3.upload_snapshot.v1' || !Array.isArray(m.files) ||
      m.files.length!==1 || !entry || entry.source_artifact_ref!==row.artifact_ref ||
      entry.file_sha256!==row.sha256 ||
      typeof entry.size_bytes!=='number' || !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes<1 || entry.size_bytes>25*1024*1024)
    return fail('UNTRUSTED_SOURCE_MANIFEST');
  const source=await checkedRead(root,row.artifact_ref,25*1024*1024);
  if (source.length!==entry.size_bytes || hash(source)!==row.sha256)
    return fail('SOURCE_HASH_MISMATCH');
  return {customer_id:row.customer_id,conversation_id:row.conversation_id,
    artifact_ref:row.artifact_ref,sha256:row.sha256};
}

/** Explicit staff decision only; never an AI-generated/customer-confirmed order.
 * The durable PENDING reservation is intentional: ambiguity goes to a human,
 * and never causes automatic creation of a second draft after a crash. */
export async function createSyntheticInboundDraft(
  pool: SqlPool, service: Pick<OrderService,'createDraft'>, root: string,
  scope: SyntheticArtifactScope, actor: Principal, untrustedInput: unknown
): Promise<SyntheticDraftResult> {
  assertStaff(actor);
  if (actor.shop_id!==scope.shop_id) return fail('FORBIDDEN',403);
  const settings=parseSettings(untrustedInput);
  const source=await verifiedSyntheticSource(pool,root,scope,settings.event_id);
  const request_data={documents:[{artifact_name:source.artifact_ref,copies:settings.copies,
    duplex:settings.duplex,paper:settings.paper}]};
  const settingsHash=hash(canonical({request_data,customer_id:source.customer_id,
    conversation_id:source.conversation_id,sha256:source.sha256}));
  const inserted=await pool.query(
    'INSERT INTO ai0_inbound_artifact_drafts '+
    '(shop_id,oa_id,event_id,actor_id,settings_sha256) '+
    'SELECT $1,$2,$3,$4,$5 FROM core_shop_settings WHERE shop_id=$1 AND mode=\'simulation\' '+
    'ON CONFLICT (shop_id,oa_id,event_id) DO NOTHING RETURNING event_id',
    [scope.shop_id,scope.oa_id,settings.event_id,actor.id,settingsHash]);
  if (inserted.rowCount!==1) {
    const current=(await pool.query<DraftState>(
      'SELECT status,order_id,settings_sha256 FROM ai0_inbound_artifact_drafts '+
      'WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
      [scope.shop_id,scope.oa_id,settings.event_id])).rows[0];
    if (!current) return fail('DRAFT_RESERVATION_UNAVAILABLE');
    if (current.settings_sha256!==settingsHash) return fail('DRAFT_SETTINGS_CONFLICT');
    if (current.status!=='CREATED' || !current.order_id)
      return fail('DRAFT_PENDING_NEEDS_HUMAN');
    return {status:'existing',order_id:current.order_id,revision:1,
      requires_customer_confirmation:true,preview_trusted:false};
  }
  // AI1 records its own staff actor and idempotency, not an invented AI identity.
  // If this call fails, PENDING remains and needs explicit manual reconciliation.
  const result=await service.createDraft(actor,{
    customer_id:source.customer_id,conversation_id:source.conversation_id,
    request_data,idempotency_key:'synthetic:'+hash(scope.shop_id+':'+scope.oa_id+':'+settings.event_id)
  });
  const stored=await pool.query(
    'UPDATE ai0_inbound_artifact_drafts SET status=\'CREATED\',order_id=$4,completed_at=now() '+
    'WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3 AND status=\'PENDING\' AND order_id IS NULL',
    [scope.shop_id,scope.oa_id,settings.event_id,result.order_id]);
  if (stored.rowCount!==1) return fail('DRAFT_RECONCILIATION_REQUIRED');
  return {status:'created',order_id:result.order_id,revision:1,
    requires_customer_confirmation:true,preview_trusted:false};
}
