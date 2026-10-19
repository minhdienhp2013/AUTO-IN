import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../../../backend/core/model.js';
import type { WordReviewSnapshot } from '../../../backend/core/word-review-source.js';
import { createWordReviewPreviewService, type PreparedWordReviewPreview } from '../../../backend/composition/word-review-preview.js';

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

test('composition accepts the current native Word producer manifest and retains a private review preview', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'autoin-word-preview-producer-'));
  const root = join(scratch, 'artifacts');
  const fakePython = join(scratch, 'fake-python');
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  await writeFile(fakePython, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[process.argv.indexOf('--artifact-root') + 1];
let raw = '';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const source = Buffer.from(input.private_bytes.source_base64, 'base64');
  const sourceHash = hash(source);
  const folderName = 'doc-native001';
  const folder = path.join(root, folderName);
  fs.mkdirSync(folder, { mode: 0o700 });
  const sourceName = 'source-000-' + sourceHash + '.docx';
  const sourceRef = folderName + '/' + sourceName;
  const pageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pageRef = folderName + '/' + sourceHash.slice(0, 16) + '-0-p1.png';
  fs.writeFileSync(path.join(folder, sourceName), source, { mode: 0o400 });
  fs.writeFileSync(path.join(folder, pageRef.split('/')[1]), pageBytes, { mode: 0o600 });
  const settings = Object.fromEntries(Object.entries(input.request_data.documents[0]).filter(([key]) => key !== 'artifact_name'));
  const settingsHash = hash(canonical(settings));
  const renderer = { engine: 'microsoft_word_com', version: 'test-mock' };
  const previews = [{ ref: pageRef, sha256: hash(pageBytes), bytes: pageBytes.length }];
  const manifest = {
    schema: 'ai3.native_word_preview.v1', shop_id: input.shop_id, order_id: input.order_id,
    active_revision: input.active_revision, request_hash: input.request_hash,
    files: [{ source_artifact_ref: sourceRef, file_sha256: sourceHash, size_bytes: source.length,
      settings_sha256: settingsHash, render_method: 'word_com_native_preview_only',
      document_pages: 1, printed_faces: 1, physical_sheets: 1 }],
    source: input.source, input_manifest: input.manifest, previews,
    paper_plan: [{ document_pages: 1, printed_faces: 1, physical_sheets: 1 }],
    counts: { document_pages: 1, printed_faces: 1, physical_sheets: 1, requires_price_confirmation: false },
    evidence_kind: 'windows_word_com_preview_only', renderer_identity: renderer,
    settings_sha256: settingsHash, ready: false, allowed_to_print: false,
    requires_staff_review: true, physical_print_verified: false
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(folder, 'manifest.json'), manifestBytes, { mode: 0o600 });
  const result = {
    schema: 'ai3.native_word_review_cli.v1', preview_schema: 'ai3.native_word_preview.v1',
    status: 'REVIEW_REQUIRED', reason_code: 'WORD_FONT_AND_RICOH_LAYOUT_UNVERIFIED',
    source_format: 'DOCX', print_source_format: 'DOCX', shop_id: input.shop_id, order_id: input.order_id,
    active_revision: input.active_revision, request_hash: input.request_hash,
    source_sha256: sourceHash, source_size_bytes: source.length,
    input_manifest_sha256: input.manifest.sha256, artifact_ref: folderName + '/manifest.json',
    manifest_sha256: hash(manifestBytes), settings_sha256: settingsHash,
    preview_artifacts: [{ artifact_ref: pageRef, sha256: hash(pageBytes), size_bytes: pageBytes.length }],
    document_pages: 1, printed_faces: 1, physical_sheets: 1,
    requires_price_confirmation: false, renderer_identity: renderer, native_word_verified: true,
    ready: false, allowed_to_print: false, allowed_to_simulate: false,
    requires_staff_review: true, physical_print_verified: false
  };
  process.stdout.write(JSON.stringify(result) + '\\n');
});
`);
  await chmod(fakePython, 0o700);
  try {
    const service = createWordReviewPreviewService({ artifactRoot: root, pythonExecutable: fakePython });
    const prepared = await service.prepare(snapshot());
    assert.equal(prepared.projection.status, 'REVIEW_REQUIRED');
    assert.equal(prepared.projection.ready, false);
    assert.equal(prepared.projection.allowed_to_print, false);
    assert.equal(prepared.projection.requires_staff_review, true);
    assert.ok(prepared.private_work_dir);
    await service.remember(prepared);
    assert.equal(await service.find(prepared.shop_id, prepared.order_id, prepared.revision), prepared);
    assert.deepEqual(await service.readPage(prepared, 1), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await service.clearOrder(prepared.shop_id, prepared.order_id);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('clearing an order does not evict a replacement remembered during asynchronous cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoin-word-preview-race-'));
  await chmod(root, 0o700);
  const service = createWordReviewPreviewService({ artifactRoot: root });
  const source = snapshot();
  const createPrepared = async (name: string): Promise<PreparedWordReviewPreview> => {
    const workDir = join(root, `word-review-${name}`);
    await mkdir(workDir, { mode: 0o700 });
    return {
      projection: {
        schema: 'ai0.word_review_preview.v1', shop_id: source.shop_id, order_id: source.order_id,
        revision: source.active_revision, request_hash: source.request_hash,
        source_sha256: source.source.sha256, manifest_sha256: source.manifest.sha256,
        status: 'REVIEW_REQUIRED', pages: [], ready: false, allowed_to_print: false,
        requires_staff_review: true, physical_print_verified: false
      },
      shop_id: source.shop_id, order_id: source.order_id, revision: source.active_revision,
      request_hash: source.request_hash, source_sha256: source.source.sha256,
      source_manifest_sha256: source.manifest.sha256, private_work_dir: workDir,
      private_bundle_ref: `doc-${name}/manifest.json`,
      private_pages: [{ artifact_ref: `doc-${name}/page-1.png`, sha256: 'a'.repeat(64), size_bytes: 1, index: 1 }],
      expires_at: Date.now() + 60_000
    };
  };
  const pathExists = async (path: string) => stat(path).then(() => true, () => false);

  try {
    const original = await createPrepared('original');
    const replacement = await createPrepared('replacement');
    await service.remember(original);

    const clearing = service.clearOrder(source.shop_id, source.order_id);
    await service.remember(replacement);
    await clearing;

    assert.equal(await service.find(source.shop_id, source.order_id, source.active_revision), replacement);
    assert.equal(await pathExists(replacement.private_work_dir!), true);
    assert.equal(await pathExists(original.private_work_dir!), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discarding an old failed read preserves a newer preview for the same revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoin-word-preview-discard-'));
  await chmod(root, 0o700);
  const service = createWordReviewPreviewService({ artifactRoot: root });
  const source = snapshot();
  const createPrepared = async (name: string): Promise<PreparedWordReviewPreview> => {
    const workDir = join(root, `word-review-${name}`);
    await mkdir(workDir, { mode: 0o700 });
    return {
      projection: {
        schema: 'ai0.word_review_preview.v1', shop_id: source.shop_id, order_id: source.order_id,
        revision: source.active_revision, request_hash: source.request_hash,
        source_sha256: source.source.sha256, manifest_sha256: source.manifest.sha256,
        status: 'REVIEW_REQUIRED', pages: [], ready: false, allowed_to_print: false,
        requires_staff_review: true, physical_print_verified: false
      },
      shop_id: source.shop_id, order_id: source.order_id, revision: source.active_revision,
      request_hash: source.request_hash, source_sha256: source.source.sha256,
      source_manifest_sha256: source.manifest.sha256, private_work_dir: workDir,
      private_bundle_ref: `doc-${name}/manifest.json`,
      private_pages: [{ artifact_ref: `doc-${name}/page-1.png`, sha256: 'b'.repeat(64), size_bytes: 1, index: 1 }],
      expires_at: Date.now() + 60_000
    };
  };
  const pathExists = async (path: string) => stat(path).then(() => true, () => false);

  try {
    const stale = await createPrepared('stale');
    const current = await createPrepared('current');
    await service.remember(stale);
    const readEntry = await service.find(source.shop_id, source.order_id, source.active_revision);
    assert.equal(readEntry, stale);
    await service.remember(current);
    await service.discard(readEntry!);

    assert.equal(await service.find(source.shop_id, source.order_id, source.active_revision), current);
    assert.equal(await pathExists(current.private_work_dir!), true);
    assert.equal(await pathExists(stale.private_work_dir!), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
