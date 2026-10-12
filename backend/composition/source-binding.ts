import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DomainError } from '../core/model.js';
import type { SqlPool } from '../storage/database.js';
import { verifiedSyntheticSource } from './inbound-draft.js';

type LinkedDraft = { oa_id: string; event_id: string; customer_id: string; conversation_id: string | null };
const fail = (): never => { throw new DomainError(
  'REGISTERED_SOURCE_UNVERIFIED','Registered inbound file needs human review',409); };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Only invoked for requests pointing to a private AI0 synthetic snapshot.
 * Native/manual processor tests with ordinary local fixture filenames remain independent. */
export async function verifyBoundSourceForPlan(
  pool: SqlPool, scope: {shop_id:string;order_id:string}, requestData: unknown,
  inputRoot: string, artifactRoot: string,
  artifactRef: string, expectedManifestSha: string
): Promise<void> {
  if (!requestData || typeof requestData !== 'object' || Array.isArray(requestData)) return fail();
  const documents=(requestData as {documents?:unknown}).documents;
  if (!Array.isArray(documents) || documents.length!==1 ||
      !documents[0] || typeof documents[0]!=='object' || Array.isArray(documents[0]))
    return fail();
  const ref=(documents[0] as {artifact_name?:unknown}).artifact_name;
  if (typeof ref!=='string' || !/^doc-[A-Za-z0-9_-]{6,64}\/source-000-[a-f0-9]{64}\./.test(ref))
    return fail();
  const rows=await pool.query<LinkedDraft>(
    'SELECT d.oa_id,d.event_id,o.customer_id,o.conversation_id '+
    'FROM ai0_inbound_artifact_drafts d '+
    'JOIN core_orders o ON o.id=d.order_id AND o.shop_id=d.shop_id '+
    'WHERE d.shop_id=$1 AND d.order_id=$2 AND d.status=\'CREATED\'',
    [scope.shop_id,scope.order_id]);
  const linked=rows.rows[0];
  if (!linked || !linked.conversation_id) return fail();
  const frozen=await verifiedSyntheticSource(pool,inputRoot,
    {shop_id:scope.shop_id,oa_id:linked.oa_id},linked.event_id);
  if (frozen.customer_id!==linked.customer_id ||
      frozen.conversation_id!==linked.conversation_id ||
      ref!==frozen.artifact_ref) return fail();
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(artifactRef) ||
      artifactRef.includes('..') || !/^[a-f0-9]{64}$/.test(expectedManifestSha))
    return fail();
  const target=resolve(artifactRoot,artifactRef);
  if (!target.startsWith(resolve(artifactRoot)+sep)) return fail();
  let fd;
  let raw:Buffer;
  try {
    fd=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    const st=await fd.stat();
    if (!st.isFile() || st.size<1 || st.size>256*1024) return fail();
    raw=await fd.readFile();
  } catch { return fail(); }
  finally { await fd?.close(); }
  if (sha(raw)!==expectedManifestSha) return fail();
  let manifest:unknown;
  try {manifest=JSON.parse(raw.toString('utf8'));} catch {return fail();}
  if (!manifest || typeof manifest!=='object' || Array.isArray(manifest)) return fail();
  const obj=manifest as {schema?:unknown;files?:unknown};
  const items=obj.files;
  const file=Array.isArray(items)?items[0] as {file_sha256?:unknown}|undefined:undefined;
  // ZIP expands to multiple sources; it needs a separate reviewed binding.
  if (obj.schema!=='ai3.document_bridge.v1' ||
      !Array.isArray(items) || items.length!==1 ||
      file?.file_sha256!==frozen.sha256) return fail();
}
