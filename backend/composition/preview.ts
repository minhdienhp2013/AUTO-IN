import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { SqlPool } from '../storage/database.js';
import { assertStaff, DomainError, type Principal } from '../core/model.js';

interface PlanProof {
  artifact_ref: string; manifest_sha256: string; request_hash: string;
  plan: { artifact_ref?: string; request_hash?: string; ready?: boolean } | null;
  active_revision: number;
}
interface PreviewEntry { ref?: unknown; sha256?: unknown; bytes?: unknown }
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const denied = (code: string, status = 409): never => {
  throw new DomainError(code, 'Verified preview is unavailable', status);
};
function checkedRef(root: string, ref: unknown, prefix?: string): string {
  if (typeof ref !== 'string' ||
      !/^doc-[A-Za-z0-9_-]{6,64}\/[A-Za-z0-9_.-]+$/.test(ref) ||
      ref.includes('..') || (prefix && ref.split('/')[0] !== prefix))
    return denied('UNTRUSTED_PREVIEW_REF');
  const path = resolve(root, ref);
  if (!path.startsWith(resolve(root) + sep)) return denied('UNTRUSTED_PREVIEW_REF');
  return path;
}
async function secureRead(root: string, ref: string, sizeLimit: number): Promise<Buffer> {
  const target = checkedRef(root, ref);
  const storage = await lstat(root).catch(() => null);
  const directory = await lstat(resolve(root, ref.split('/')[0]!)).catch(() => null);
  if (!storage?.isDirectory() || storage.isSymbolicLink() || (storage.mode & 0o022) ||
      !directory?.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022))
    return denied('UNTRUSTED_PREVIEW_STORAGE',503);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > sizeLimit)
      return denied('UNTRUSTED_PREVIEW_BYTES');
    const data = await handle.readFile();
    if (data.length !== stat.size) return denied('UNTRUSTED_PREVIEW_BYTES');
    return data;
  } catch { return denied('PREVIEW_NOT_AVAILABLE',404); }
  finally { await handle?.close(); }
}

/** Only server-anchored, AI3-rendered PNGs; never return original PDFs/documents. */
export async function loadVerifiedOrderPreview(
  pool: SqlPool, artifactRoot: string, actor: Principal,
  orderId: string, revision: number, previewIndex: number
): Promise<Buffer> {
  assertStaff(actor);
  if (!/^[a-f0-9-]{36}$/i.test(orderId) || !Number.isSafeInteger(revision) ||
      revision < 1 || !Number.isSafeInteger(previewIndex) ||
      previewIndex < 0 || previewIndex > 14) return denied('INVALID_PREVIEW_REQUEST',422);
  const result = await pool.query<PlanProof>(
    'SELECT e.artifact_ref,e.manifest_sha256,e.request_hash,r.plan,o.active_revision ' +
    'FROM ai0_verified_plan_manifests e ' +
    'JOIN core_orders o ON o.id=e.order_id AND o.shop_id=e.shop_id ' +
    'JOIN core_revisions r ON r.order_id=e.order_id AND r.revision=e.revision ' +
    'WHERE e.shop_id=$1 AND e.order_id=$2 AND e.revision=$3',
    [actor.shop_id,orderId,revision]
  );
  const proof = result.rows[0];
  if (!proof) return denied('PREVIEW_NOT_AVAILABLE',404);
  if (proof.active_revision !== revision || proof.plan?.ready !== true ||
      proof.plan.artifact_ref !== proof.artifact_ref ||
      proof.plan.request_hash !== proof.request_hash ||
      !/^[a-f0-9]{64}$/.test(proof.manifest_sha256))
    return denied('STALE_OR_UNVERIFIED_PREVIEW');
  const manifestBytes = await secureRead(artifactRoot,proof.artifact_ref,256*1024);
  if (digest(manifestBytes) !== proof.manifest_sha256)
    return denied('PREVIEW_MANIFEST_CHANGED');
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { return denied('PREVIEW_MANIFEST_INVALID'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    return denied('PREVIEW_MANIFEST_INVALID');
  const value = manifest as {schema?:unknown;request_hash?:unknown;previews?:unknown};
  if (value.schema !== 'ai3.document_bridge.v1' ||
      value.request_hash !== proof.request_hash || !Array.isArray(value.previews) ||
      value.previews.length < 1 || value.previews.length > 15)
    return denied('PREVIEW_MANIFEST_INVALID');
  const entry = value.previews[previewIndex] as PreviewEntry | undefined;
  const dir = proof.artifact_ref.split('/')[0]!;
  if (!entry || typeof entry.ref !== 'string' ||
      !entry.ref.endsWith('.png') || typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 8 || entry.bytes > 8*1024*1024)
    return denied('PREVIEW_NOT_AVAILABLE',404);
  checkedRef(artifactRoot,entry.ref,dir);
  const preview = await secureRead(artifactRoot,entry.ref,8*1024*1024);
  if (preview.length !== entry.bytes || digest(preview) !== entry.sha256 ||
      !preview.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    return denied('PREVIEW_BYTES_CHANGED');
  return preview;
}
