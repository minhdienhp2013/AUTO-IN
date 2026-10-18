import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../../../backend/core/model.js';
import type { PdfReviewSourceScope } from '../../../backend/core/pdf-review-source.js';
import type { SqlConnection } from '../../../backend/storage/database.js';
import { createSyntheticPdfReviewSourceReader } from '../../../backend/composition/pdf-review-source.js';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const shop = 'pdf-source-shop';
const oa = 'pdf-source-oa';
const customer = 'pdf-source-customer';
const conversation = 'pdf-source-conversation';
const order = '30fe1011-df23-4b91-8e84-d7f44de5ae98';
const event = 'pdf-source-event';

function draftRequest(ref: string) {
  return { documents: [{ artifact_name: ref, copies: 2, duplex: true, paper: 'A4' as const }] };
}

function directRow(rootName: string, pdf: Buffer) {
  const sourceHash = sha(pdf);
  const ref = `${rootName}/source-000-${sourceHash}.pdf`;
  const manifestRef = `${rootName}/manifest.json`;
  const requestData = draftRequest(ref);
  const settingsHash = sha(canonical({ request_data: requestData, customer_id: customer,
    conversation_id: conversation, sha256: sourceHash }));
  const requestHash = sha(canonical(requestData));
  const originalManifest = Buffer.from(JSON.stringify({ schema: 'ai3.upload_snapshot.v1', files: [{
    source_artifact_ref: ref, file_sha256: sourceHash, size_bytes: pdf.length
  }] }));
  return {
    event_id: event, artifact_ref: ref, sha256: sourceHash, manifest_ref: manifestRef,
    manifest_sha256: sha(originalManifest), customer_id: customer, conversation_id: conversation,
    draft_status: 'CREATED', draft_order_id: order, draft_settings_sha256: settingsHash,
    draft_completed_at: new Date().toISOString(), order_id: order, order_customer: customer,
    order_conversation: conversation, active_revision: 1, request_hash: requestHash,
    request_data: requestData, initial_request_data: requestData, adoption_request_data: null,
    event_customer: customer, event_conversation: conversation,
    payload_json: { kind: 'file', filename: 'original.pdf', customer_id: customer, conversation_id: conversation },
    proposal_order_id: null, proposal_oa_id: null, proposal_customer: null, proposal_conversation: null,
    adoption_actor_id: null, adoption_payload_sha256: null, adoption_response: null, adoption_completed_at: null,
    originalManifest, pdf
  };
}

function mockDb(row: Record<string, unknown>): SqlConnection {
  return {
    async query<T>(sql: string, args: unknown[] = []) {
      assert.match(sql, /d\.completed_at IS NOT NULL/);
      assert.match(sql, /r\.request_hash=\$5 AND r\.request_data=\$6::jsonb/);
      assert.equal(args[0], shop);
      assert.equal(args[1], oa);
      return { rows: [row as T], rowCount: 1 };
    },
    release() {}
  };
}

async function privateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoin-pdf-source-'));
  const pdf = Buffer.from('%PDF-1.4\n% synthetic fixture\n');
  const rootName = `doc-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const directory = join(root, rootName);
  await mkdir(directory, { mode: 0o700 });
  const row = directRow(rootName, pdf);
  await writeFile(join(directory, 'manifest.json'), row.originalManifest, { mode: 0o400 });
  await writeFile(join(directory, `source-000-${sha(pdf)}.pdf`), pdf, { mode: 0o400 });
  await chmod(root, 0o700);
  return { root, row, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

test('simulation PDF reader binds one completed direct draft to exact source bytes and current request', async () => {
  const fixture = await privateFixture();
  try {
    const reader = createSyntheticPdfReviewSourceReader(fixture.root, { shop_id: shop, oa_id: oa });
    const scope: PdfReviewSourceScope = { shop_id: shop, order_id: order, active_revision: 1,
      request_hash: String(fixture.row.request_hash), request_data: fixture.row.request_data };
    const result = await reader.read_registered(mockDb(fixture.row), scope);
    assert.ok(result);
    assert.equal(result.source.artifact_ref, fixture.row.artifact_ref);
    assert.deepEqual(Buffer.from(result.source.bytes), fixture.row.pdf);
    assert.equal(result.manifest.ref, `${String(fixture.row.artifact_ref).split('/')[0]}/pdf-review-1-${scope.request_hash}.json`);
    const manifest = JSON.parse(Buffer.from(result.manifest.bytes).toString('utf8'));
    assert.deepEqual(manifest.source, { format: 'PDF', artifact_ref: fixture.row.artifact_ref,
      sha256: fixture.row.sha256, size_bytes: fixture.row.pdf.length });
  } finally { await fixture.cleanup(); }
});

test('simulation PDF reader rejects incomplete, mismatched, or changed provenance', async () => {
  const fixture = await privateFixture();
  try {
    const reader = createSyntheticPdfReviewSourceReader(fixture.root, { shop_id: shop, oa_id: oa });
    const scope: PdfReviewSourceScope = { shop_id: shop, order_id: order, active_revision: 1,
      request_hash: String(fixture.row.request_hash), request_data: fixture.row.request_data };
    const altered = (overrides: Record<string, unknown>) => ({ ...fixture.row, ...overrides });
    assert.equal(await reader.read_registered(mockDb(altered({ draft_completed_at: null })), scope), null);
    assert.equal(await reader.read_registered(mockDb(altered({ draft_order_id: randomUUID() })), scope), null);
    assert.equal(await reader.read_registered(mockDb(altered({ draft_settings_sha256: '0'.repeat(64) })), scope), null);
    assert.equal(await reader.read_registered(mockDb(altered({ event_customer: 'other-customer' })), scope), null);
    const changed = { ...fixture.row, artifact_ref: `${String(fixture.row.artifact_ref).split('/')[0]}/source-000-${'f'.repeat(64)}.pdf` };
    assert.equal(await reader.read_registered(mockDb(changed), scope), null);
    const wrongShop = createSyntheticPdfReviewSourceReader(fixture.root, { shop_id: 'other-shop', oa_id: oa });
    assert.equal(await wrongShop.read_registered(mockDb(fixture.row), scope), null);
  } finally { await fixture.cleanup(); }
});

test('simulation PDF reader requires the completed adoption receipt for AI2 suggestions', async () => {
  const fixture = await privateFixture();
  try {
    const adoptedRequest = fixture.row.request_data;
    const sourceHash = String(fixture.row.sha256);
    const suggestion = { source: 'zalo_ai_suggestion', conversation_id: conversation,
      event_ids: [event], request_text: 'in 2 bản' };
    const settingsHash = sha(canonical({ request_data: adoptedRequest, customer_id: customer,
      conversation_id: conversation, sha256: sourceHash }));
    const receiptHash = sha(canonical({ order_id: order, event_id: event, paper: 'A4', copies: 2, duplex: true }));
    const adoptionRow = { ...fixture.row, active_revision: 2,
      request_data: adoptedRequest, request_hash: sha(canonical(adoptedRequest)),
      initial_request_data: suggestion, adoption_request_data: adoptedRequest,
      draft_settings_sha256: settingsHash, proposal_order_id: order, proposal_oa_id: oa,
      proposal_customer: customer, proposal_conversation: conversation,
      adoption_actor_id: 'staff-1', adoption_payload_sha256: receiptHash,
      adoption_response: { status: 'adopted', order_id: order, revision: 2,
        requires_customer_confirmation: true, preview_trusted: false },
      adoption_completed_at: new Date().toISOString() };
    const reader = createSyntheticPdfReviewSourceReader(fixture.root, { shop_id: shop, oa_id: oa });
    const scope: PdfReviewSourceScope = { shop_id: shop, order_id: order, active_revision: 2,
      request_hash: String(adoptionRow.request_hash), request_data: adoptedRequest };
    assert.ok(await reader.read_registered(mockDb(adoptionRow), scope));
    assert.equal(await reader.read_registered(mockDb({ ...adoptionRow, adoption_completed_at: null }), scope), null);
    assert.equal(await reader.read_registered(mockDb({ ...adoptionRow,
      adoption_response: { ...adoptionRow.adoption_response as object, preview_trusted: true } }), scope), null);
  } finally { await fixture.cleanup(); }
});
