import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../../../backend/core/model.js';
import type { WordReviewSnapshot } from '../../../backend/core/word-review-source.js';
import { createWordReviewPreviewService } from '../../../backend/composition/word-review-preview.js';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

function snapshot(): WordReviewSnapshot {
  const sourceBytes = Buffer.from('synthetic invalid docx; this must stay held');
  const requestData = { documents: [{ artifact_name: 'source-000-' + sha(sourceBytes) + '.docx',
    copies: 1, duplex: false, paper: 'A4' }] };
  const requestHash = sha(canonical(requestData));
  const sourceRef = `doc-word123/source-000-${sha(sourceBytes)}.docx`;
  const manifestRef = 'doc-word123/word-review-1-input.json';
  const manifestBytes = Buffer.from(JSON.stringify({ schema: 'ai0.word_review_manifest.v1',
    manifest_ref: manifestRef, shop_id: 'shop-word', order_id: '00000000-0000-4000-8000-000000000011',
    active_revision: 1, request_hash: requestHash,
    source: { format: 'DOCX', artifact_ref: sourceRef, sha256: sha(sourceBytes), size_bytes: sourceBytes.length } }));
  const result = { schema: 'ai0.word_review_source.v1' as const, shop_id: 'shop-word',
    order_id: '00000000-0000-4000-8000-000000000011', active_revision: 1,
    request_hash: requestHash, request_data: requestData,
    source: { format: 'DOCX' as const, artifact_ref: sourceRef, sha256: sha(sourceBytes), size_bytes: sourceBytes.length },
    manifest: { ref: manifestRef, sha256: sha(manifestBytes) } } as WordReviewSnapshot;
  Object.defineProperty(result, 'private_bytes', { enumerable: false, value: {
    source: sourceBytes, manifest: manifestBytes
  } });
  return result;
}

test('native Word review CLI without a valid DOCX remains NEEDS_HUMAN and cleans its private work directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoin-word-preview-'));
  await chmod(root, 0o700);
  try {
    const service = createWordReviewPreviewService({ artifactRoot: root });
    const prepared = await service.prepare(snapshot());
    assert.equal(prepared.projection.schema, 'ai0.word_review_preview.v1');
    assert.equal(prepared.projection.status, 'NEEDS_HUMAN');
    assert.equal(prepared.projection.pages.length, 0);
    assert.equal(prepared.projection.ready, false);
    assert.equal(prepared.projection.allowed_to_print, false);
    assert.equal(prepared.projection.requires_staff_review, true);
    assert.equal(prepared.private_work_dir, null);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
