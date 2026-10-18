import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { canonical, DomainError } from '../core/model.js';
import type { PdfReviewSourceScope, TrustedPdfReviewBytes, TrustedPdfReviewSourceReader } from '../core/pdf-review-source.js';
import type { SqlConnection } from '../storage/database.js';
import type { SyntheticArtifactScope } from './synthetic-ingest.js';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const sourceRef = /^doc-[A-Za-z0-9_-]{6,64}\/source-000-([a-f0-9]{64})\.pdf$/;
const orderId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const deny = () => new DomainError('PDF_SOURCE_NOT_VERIFIED', 'Nguồn PDF chưa được liên kết an toàn với đơn hiện hành', 409);

interface PrintRequestDocument {
  artifact_name: string;
  copies: number;
  duplex: boolean;
  paper: 'A4' | 'A3';
}
interface RegisteredPdfRow {
  event_id: string;
  artifact_ref: string;
  sha256: string;
  manifest_ref: string;
  manifest_sha256: string;
  customer_id: string;
  conversation_id: string;
  draft_status: string;
  draft_order_id: string | null;
  draft_settings_sha256: string;
  draft_completed_at: string | null;
  order_id: string;
  order_customer: string;
  order_conversation: string | null;
  active_revision: number;
  request_hash: string;
  request_data: unknown;
  initial_request_data: unknown;
  adoption_request_data: unknown;
  event_customer: string;
  event_conversation: string;
  payload_json: { kind?: unknown; filename?: unknown; customer_id?: unknown; conversation_id?: unknown };
  proposal_order_id: string | null;
  proposal_oa_id: string | null;
  proposal_customer: string | null;
  proposal_conversation: string | null;
  adoption_actor_id: string | null;
  adoption_payload_sha256: string | null;
  adoption_response: unknown;
  adoption_completed_at: string | null;
}

function parsePrintRequest(value: unknown): PrintRequestDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).sort().join(',') !== 'documents' || !Array.isArray(request.documents) || request.documents.length !== 1)
    return null;
  const document = request.documents[0];
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  const item = document as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'artifact_name,copies,duplex,paper' ||
      typeof item.artifact_name !== 'string' || !sourceRef.test(item.artifact_name) ||
      !Number.isSafeInteger(item.copies) || (item.copies as number) < 1 || (item.copies as number) > 999 ||
      typeof item.duplex !== 'boolean' || (item.paper !== 'A4' && item.paper !== 'A3')) return null;
  return { artifact_name: item.artifact_name, copies: item.copies as number,
    duplex: item.duplex, paper: item.paper };
}

function isSuggestionForEvent(value: unknown, eventId: string, conversationId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.source === 'zalo_ai_suggestion' && request.conversation_id === conversationId &&
    Array.isArray(request.event_ids) && request.event_ids.length === 1 && request.event_ids[0] === eventId;
}

function verifyOriginBinding(row: RegisteredPdfRow): boolean {
  const source = sourceRef.exec(row.artifact_ref);
  const storedSettingsHash = row.draft_settings_sha256?.trim();
  if (!source || source[1] !== row.sha256?.trim() || !digest.test(storedSettingsHash ?? '') ||
      !row.draft_completed_at || row.draft_status !== 'CREATED' || row.draft_order_id !== row.order_id)
    return false;

  const first = parsePrintRequest(row.initial_request_data);
  if (first?.artifact_name === row.artifact_ref) {
    // Direct staff-created draft: independently recompute the immutable
    // draft/source settings hash persisted before Core created revision 1.
    const binding = sha(canonical({ request_data: row.initial_request_data,
      customer_id: row.order_customer, conversation_id: row.order_conversation, sha256: row.sha256.trim() }));
    return binding === storedSettingsHash;
  }

  // AI2 suggestion adoption must pass through the explicit completed receipt.
  // Later Core revisions may change settings, but the source remains anchored
  // to revision 2 and every current revision must still name this exact ref.
  if (row.active_revision < 2 || !row.order_conversation ||
      !isSuggestionForEvent(row.initial_request_data, row.event_id, row.order_conversation)) return false;
  const adopted = parsePrintRequest(row.adoption_request_data);
  if (!adopted || adopted.artifact_name !== row.artifact_ref ||
      row.proposal_order_id !== row.order_id || row.proposal_oa_id === null ||
      row.proposal_customer !== row.order_customer || row.proposal_conversation !== row.order_conversation ||
      !row.adoption_actor_id || !row.adoption_completed_at || !digest.test(row.adoption_payload_sha256?.trim() ?? ''))
    return false;
  const expectedSettingsHash = sha(canonical({ request_data: row.adoption_request_data,
    customer_id: row.order_customer, conversation_id: row.order_conversation, sha256: row.sha256.trim() }));
  const expectedReceiptHash = sha(canonical({ order_id: row.order_id, event_id: row.event_id,
    paper: adopted.paper, copies: adopted.copies, duplex: adopted.duplex }));
  const response = row.adoption_response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  const receipt = response as Record<string, unknown>;
  return expectedSettingsHash === storedSettingsHash && expectedReceiptHash === row.adoption_payload_sha256?.trim() &&
    Object.keys(receipt).sort().join(',') === 'order_id,preview_trusted,requires_customer_confirmation,revision,status' &&
    receipt.status === 'adopted' && receipt.order_id === row.order_id && receipt.revision === 2 &&
    receipt.requires_customer_confirmation === true && receipt.preview_trusted === false;
}

function rejectDuplicateJsonKeys(text: string): void {
  let i = 0;
  const ws = () => { while (/[\u0009\u000a\u000d\u0020]/.test(text[i] ?? '')) i++; };
  const string = (): string => {
    const start = i++;
    let escaped = false;
    while (i < text.length) {
      const c = text[i++];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') {
        try { return JSON.parse(text.slice(start, i)) as string; } catch { throw deny(); }
      }
      if ((c ?? '') < ' ') throw deny();
    }
    throw deny();
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws(); const keys = new Set<string>();
      if (text[i] === '}') { i++; return; }
      while (true) {
        ws(); if (text[i] !== '"') throw deny();
        const key = string(); if (keys.has(key)) throw deny(); keys.add(key);
        ws(); if (text[i++] !== ':') throw deny(); value(); ws();
        const end = text[i++]; if (end === '}') return; if (end !== ',') throw deny();
      }
    }
    if (c === '[') {
      i++; ws(); if (text[i] === ']') { i++; return; }
      while (true) { value(); ws(); const end = text[i++]; if (end === ']') return; if (end !== ',') throw deny(); }
    }
    if (c === '"') { string(); return; }
    const literal = /^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(text.slice(i));
    if (literal) { i += literal[0].length; return; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (number) { i += number[0].length; return; }
    throw deny();
  };
  value(); ws(); if (i !== text.length) throw deny();
}

async function readPrivateFile(root: string, ref: string, maxBytes: number): Promise<Buffer> {
  const parts = ref.split('/');
  if (parts.length !== 2 || !/^doc-[A-Za-z0-9_-]{6,64}$/.test(parts[0] ?? '') ||
      !/^[A-Za-z0-9_.-]+$/.test(parts[1] ?? '') || (parts[1] ?? '').includes('..')) throw deny();
  const base = resolve(root);
  const directory = resolve(base, parts[0]!);
  const target = resolve(directory, parts[1]!);
  if (!directory.startsWith(base + sep) || !target.startsWith(directory + sep)) throw deny();
  const rootStat = await lstat(base).catch(() => null);
  const dirStat = await lstat(directory).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) ||
      !dirStat?.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077)) throw deny();
  let file;
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size < 1 || stat.size > maxBytes) throw deny();
    const bytes = await file.readFile();
    if (bytes.length !== stat.size) throw deny();
    return bytes;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw deny();
  } finally {
    await file?.close();
  }
}

/**
 * AI0-only source adapter for the simulation fixture registry. It never
 * downloads or infers Zalo media. Core supplies the current order/revision;
 * the adapter proves the event, draft/adoption, source bytes, and settings
 * against that revision before returning private bytes to the server worker.
 */
export function createSyntheticPdfReviewSourceReader(
  root: string, configured: SyntheticArtifactScope
): TrustedPdfReviewSourceReader {
  if (!root || !configured?.shop_id || !configured?.oa_id) throw new Error('PDF_REVIEW_SOURCE_CONFIG_REQUIRED');
  return {
    async read_registered(db: SqlConnection, scope: Readonly<PdfReviewSourceScope>): Promise<TrustedPdfReviewBytes | null> {
      const requested = parsePrintRequest(scope.request_data);
      if (!requested || scope.shop_id !== configured.shop_id || !orderId.test(scope.order_id) ||
          !Number.isSafeInteger(scope.active_revision) || scope.active_revision < 1 || !digest.test(scope.request_hash)) return null;
      const result = await db.query<RegisteredPdfRow>(
        'SELECT d.event_id,a.artifact_ref,btrim(a.sha256) AS sha256,a.manifest_ref,' +
        'btrim(a.manifest_sha256) AS manifest_sha256,a.customer_id,a.conversation_id,' +
        'd.status AS draft_status,d.order_id::text AS draft_order_id,btrim(d.settings_sha256) AS draft_settings_sha256,' +
        'd.completed_at::text AS draft_completed_at,o.id::text AS order_id,o.customer_id AS order_customer,' +
        'o.conversation_id AS order_conversation,o.active_revision,btrim(r.request_hash) AS request_hash,r.request_data,' +
        'r1.request_data AS initial_request_data,r2.request_data AS adoption_request_data,' +
        'e.customer_id AS event_customer,e.conversation_id AS event_conversation,e.payload_json,' +
        'p.order_id::text AS proposal_order_id,p.oa_id AS proposal_oa_id,p.customer_id AS proposal_customer,' +
        'p.conversation_id AS proposal_conversation,ar.actor_id AS adoption_actor_id,' +
        'btrim(ar.payload_sha256) AS adoption_payload_sha256,ar.response AS adoption_response,' +
        'ar.completed_at::text AS adoption_completed_at ' +
        'FROM ai0_inbound_artifact_drafts d ' +
        'JOIN ai0_inbound_document_artifacts a ON a.shop_id=d.shop_id AND a.oa_id=d.oa_id AND a.event_id=d.event_id ' +
        'JOIN zalo_inbound_events e ON e.oa_id=a.oa_id AND e.event_id=a.event_id ' +
        'JOIN core_shop_zalo_oa_registry z ON z.shop_id=d.shop_id AND z.oa_id=d.oa_id ' +
        'JOIN core_shop_settings s ON s.shop_id=d.shop_id AND s.mode=\'simulation\' ' +
        'JOIN core_orders o ON o.id=d.order_id AND o.shop_id=d.shop_id ' +
        'JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision ' +
        'JOIN core_revisions r1 ON r1.order_id=o.id AND r1.revision=1 ' +
        'LEFT JOIN core_revisions r2 ON r2.order_id=o.id AND r2.revision=2 ' +
        'LEFT JOIN core_ai_draft_proposals p ON p.shop_id=d.shop_id AND p.oa_id=d.oa_id AND p.order_id=o.id ' +
        'LEFT JOIN ai0_source_adoption_receipts ar ON ar.shop_id=d.shop_id AND ar.oa_id=d.oa_id AND ar.event_id=d.event_id ' +
        'WHERE d.shop_id=$1 AND d.oa_id=$2 AND d.order_id=$3::uuid AND d.status=\'CREATED\' ' +
        'AND d.completed_at IS NOT NULL AND o.active_revision=$4 AND r.revision=$4 ' +
        'AND r.request_hash=$5 AND r.request_data=$6::jsonb LIMIT 2',
        [scope.shop_id, configured.oa_id, scope.order_id, scope.active_revision, scope.request_hash,
          JSON.stringify(scope.request_data)]);
      if (result.rows.length !== 1) return null;
      const row = result.rows[0]!;
      const refMatch = sourceRef.exec(row.artifact_ref);
      if (!refMatch || requested.artifact_name !== row.artifact_ref || refMatch[1] !== row.sha256?.trim() ||
          !digest.test(row.sha256?.trim() ?? '') || !digest.test(row.manifest_sha256?.trim() ?? '') ||
          row.manifest_ref !== row.artifact_ref.split('/')[0] + '/manifest.json' ||
          !row.customer_id || !row.conversation_id || row.customer_id !== row.order_customer ||
          row.conversation_id !== row.order_conversation || row.customer_id !== row.event_customer ||
          row.conversation_id !== row.event_conversation || row.payload_json?.kind !== 'file' ||
          row.payload_json.customer_id !== row.customer_id || row.payload_json.conversation_id !== row.conversation_id ||
          typeof row.payload_json.filename !== 'string' || !row.payload_json.filename.toLowerCase().endsWith('.pdf') ||
          row.request_hash?.trim() !== scope.request_hash || !verifyOriginBinding(row)) return null;

      const originalManifest = await readPrivateFile(root, row.manifest_ref, 256 * 1024);
      if (sha(originalManifest) !== row.manifest_sha256.trim()) throw deny();
      let upload: unknown;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(originalManifest);
        rejectDuplicateJsonKeys(text);
        upload = JSON.parse(text);
      } catch { throw deny(); }
      if (!upload || typeof upload !== 'object' || Array.isArray(upload)) throw deny();
      const uploadRecord = upload as { schema?: unknown; files?: unknown };
      const file = Array.isArray(uploadRecord.files) && uploadRecord.files.length === 1
        ? uploadRecord.files[0] as Record<string, unknown> : null;
      if (Object.keys(uploadRecord as object).sort().join(',') !== 'files,schema' ||
          uploadRecord.schema !== 'ai3.upload_snapshot.v1' || !file || Array.isArray(file) ||
          Object.keys(file).sort().join(',') !== 'file_sha256,size_bytes,source_artifact_ref' ||
          file.source_artifact_ref !== row.artifact_ref || file.file_sha256 !== row.sha256.trim() ||
          !Number.isSafeInteger(file.size_bytes) || (file.size_bytes as number) < 1 ||
          (file.size_bytes as number) > 25 * 1024 * 1024) throw deny();

      const bytes = await readPrivateFile(root, row.artifact_ref, 25 * 1024 * 1024);
      if (bytes.length !== file.size_bytes || sha(bytes) !== row.sha256.trim() ||
          !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw deny();
      const manifestRef = row.artifact_ref.split('/')[0] + `/pdf-review-${scope.active_revision}-${scope.request_hash}.json`;
      const manifestBytes = Buffer.from(JSON.stringify({
        schema: 'ai0.pdf_review_manifest.v1', manifest_ref: manifestRef,
        shop_id: scope.shop_id, order_id: scope.order_id, active_revision: scope.active_revision,
        request_hash: scope.request_hash,
        source: { format: 'PDF', artifact_ref: row.artifact_ref, sha256: row.sha256.trim(), size_bytes: bytes.length }
      }));
      return { source: { artifact_ref: row.artifact_ref, bytes }, manifest: { ref: manifestRef, bytes: manifestBytes } };
    }
  };
}
