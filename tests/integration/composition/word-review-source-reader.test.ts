import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, chmod, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../../../backend/core/model.js';
import type { SqlConnection } from '../../../backend/storage/database.js';
import { createSyntheticWordReviewSourceReader } from '../../../backend/composition/word-review-source.js';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const shop = 'shop-word';
const oa = 'oa-word';
const order = '00000000-0000-4000-8000-000000000011';
const customer = 'customer-word';
const conversation = 'conversation-word';
const sourceBytes = Buffer.from('PK\x03\x04 synthetic Word package fixture');

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'autoin-word-source-'));
  await chmod(root, 0o700);
  const folder = 'doc-word123';
  const dir = join(root, folder);
  await mkdir(dir, { mode: 0o700 });
  const artifactRef = `${folder}/source-000-${sha(sourceBytes)}.docx`;
  const manifestRef = `${folder}/manifest.json`;
  const requestData = { documents: [{ artifact_name: artifactRef, copies: 1, duplex: false, paper: 'A4' }] };
  const uploadManifest = Buffer.from(JSON.stringify({ schema: 'ai3.upload_snapshot.v1', files: [
    { source_artifact_ref: artifactRef, file_sha256: sha(sourceBytes), size_bytes: sourceBytes.length }
  ] }));
  await writeFile(join(root, artifactRef), sourceBytes, { mode: 0o400 });
  await writeFile(join(root, manifestRef), uploadManifest, { mode: 0o400 });
  const row: Record<string, unknown> = {
    event_id: 'evt-word', artifact_ref: artifactRef, sha256: sha(sourceBytes), manifest_ref: manifestRef,
    manifest_sha256: sha(uploadManifest), customer_id: customer, conversation_id: conversation,
    draft_status: 'CREATED', draft_order_id: order,
    draft_settings_sha256: sha(canonical({ request_data: requestData, customer_id: customer,
      conversation_id: conversation, sha256: sha(sourceBytes) })),
    draft_completed_at: '2026-10-18T00:00:00Z', order_id: order, order_customer: customer,
    order_conversation: conversation, active_revision: 1, request_hash: sha(canonical(requestData)),
    request_data: requestData, initial_request_data: requestData, adoption_request_data: null,
    event_customer: customer, event_conversation: conversation,
    payload_json: { kind: 'file', filename: 'source.docx', customer_id: customer, conversation_id: conversation },
    proposal_order_id: null, proposal_oa_id: null, proposal_customer: null, proposal_conversation: null,
    adoption_actor_id: null, adoption_payload_sha256: null, adoption_response: null, adoption_completed_at: null,
    ...overrides
  };
  const db = { async query(sql: string) {
    assert.match(sql, /r\.request_hash=\$5 AND r\.request_data=\$6::jsonb/);
    return { rows: [row], rowCount: 1 };
  } } as unknown as SqlConnection;
  const scope = { shop_id: shop, order_id: order, active_revision: Number(row.active_revision),
    request_hash: String(row.request_hash), request_data: row.request_data };
  const reader = createSyntheticWordReviewSourceReader(root, { shop_id: shop, oa_id: oa });
  return { root, row, scope, reader, db, artifactRef, manifestRef, requestData };
}

test('simulation Word reader binds a completed direct draft to current request and exact DOCX bytes', async () => {
  const f = await fixture();
  try {
    const result = await f.reader.read_registered(f.db, f.scope);
    assert.ok(result);
    assert.equal(result.source.artifact_ref, f.artifactRef);
    assert.deepEqual(Buffer.from(result.source.bytes), sourceBytes);
    const manifest = JSON.parse(Buffer.from(result.manifest.bytes).toString('utf8'));
    assert.equal(manifest.schema, 'ai0.word_review_manifest.v1');
    assert.equal(manifest.source.artifact_ref, f.artifactRef);
    assert.equal(manifest.source.sha256, sha(sourceBytes));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('simulation Word reader rejects mismatched provenance and changed private bytes', async () => {
  const f = await fixture({ draft_completed_at: null });
  try {
    assert.equal(await f.reader.read_registered(f.db, f.scope), null);
    f.row.draft_completed_at = '2026-10-18T00:00:00Z';
    f.row.customer_id = 'other-customer';
    assert.equal(await f.reader.read_registered(f.db, f.scope), null);
    f.row.customer_id = customer;
    await chmod(join(f.root, f.artifactRef), 0o600);
    await writeFile(join(f.root, f.artifactRef), Buffer.from('changed'), { mode: 0o400 });
    await assert.rejects(f.reader.read_registered(f.db, f.scope), error =>
      !!error && typeof error === 'object' && 'code' in error && error.code === 'WORD_SOURCE_NOT_VERIFIED');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('simulation Word reader requires the completed adoption receipt for suggestion-backed orders', async () => {
  const base = await fixture();
  const adoptedRequest = { documents: [{ artifact_name: base.artifactRef, copies: 2, duplex: true, paper: 'A3' }] };
  const suggestion = { source: 'zalo_ai_suggestion', conversation_id: conversation, event_ids: ['evt-word'] };
  base.row.active_revision = 2;
  base.row.request_hash = sha(canonical(adoptedRequest));
  base.row.request_data = adoptedRequest;
  base.row.initial_request_data = suggestion;
  base.row.adoption_request_data = adoptedRequest;
  base.row.draft_settings_sha256 = sha(canonical({ request_data: adoptedRequest, customer_id: customer,
    conversation_id: conversation, sha256: sha(sourceBytes) }));
  base.row.proposal_order_id = order;
  base.row.proposal_oa_id = oa;
  base.row.proposal_customer = customer;
  base.row.proposal_conversation = conversation;
  base.row.adoption_actor_id = 'staff-word';
  base.row.adoption_payload_sha256 = sha(canonical({ order_id: order, event_id: 'evt-word',
    paper: 'A3', copies: 2, duplex: true }));
  base.row.adoption_response = { status: 'adopted', order_id: order, revision: 2,
    requires_customer_confirmation: true, preview_trusted: false };
  base.row.adoption_completed_at = '2026-10-18T00:01:00Z';
  base.scope.active_revision = 2;
  base.scope.request_hash = String(base.row.request_hash);
  base.scope.request_data = adoptedRequest;
  try {
    assert.ok(await base.reader.read_registered(base.db, base.scope));
    base.row.adoption_response = null;
    assert.equal(await base.reader.read_registered(base.db, base.scope), null);
  } finally { await rm(base.root, { recursive: true, force: true }); }
});
