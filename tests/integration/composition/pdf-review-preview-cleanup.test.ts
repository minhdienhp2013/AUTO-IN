import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PdfReviewSnapshot } from '../../../backend/core/pdf-review-source.js';
import { canonical } from '../../../backend/core/model.js';
import { createPdfReviewPreviewService } from '../../../backend/composition/pdf-review-preview.js';

const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

test('PDF review timeout removes the invocation private work directory after child close', {
  timeout: 15_000
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'autoin-pdf-preview-cleanup-'));
  const artifactRoot = join(scratch, 'artifacts');
  const fakePython = join(scratch, 'fake-python');
  await mkdir(artifactRoot, { mode: 0o700 });
  await chmod(artifactRoot, 0o700);
  await writeFile(fakePython, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const index = process.argv.indexOf('--artifact-root');
const root = process.argv[index + 1];
const partial = path.join(root, 'doc-orphan');
fs.mkdirSync(partial, { mode: 0o700 });
fs.writeFileSync(path.join(partial, 'partial.bin'), 'private partial output', { mode: 0o600 });
setTimeout(() => process.exit(0), 30000);
`);
  await chmod(fakePython, 0o700);

  const source = Buffer.from('%PDF-1.7\nsynthetic source');
  const sourceRef = `doc-source/source-000-${digest(source)}.pdf`;
  const snapshot: PdfReviewSnapshot = {
    schema: 'ai0.pdf_review_source.v1',
    shop_id: 'cleanup-shop',
    order_id: 'cleanup-order',
    active_revision: 1,
    request_hash: 'a'.repeat(64),
    request_data: { documents: [{ artifact_name: sourceRef, copies: 1, duplex: false, paper: 'A4' }] },
    source: { format: 'PDF', artifact_ref: sourceRef, sha256: digest(source), size_bytes: source.length },
    manifest: { ref: 'doc-source/manifest.json', sha256: 'b'.repeat(64) },
    private_bytes: { source, manifest: Buffer.from('{}') }
  };
  const service = createPdfReviewPreviewService({ artifactRoot, pythonExecutable: fakePython, timeoutMs: 1_500 });
  try {
    const rejected = assert.rejects(service.prepare(snapshot),
      (error: unknown) => !!error && typeof error === 'object' &&
        (error as { code?: unknown }).code === 'PDF_PREVIEW_UNAVAILABLE');
    const deadline = Date.now() + 5_000;
    let partialObserved = false;
    while (Date.now() < deadline && !partialObserved) {
      const entries = await readdir(artifactRoot);
      for (const entry of entries) {
        const partial = join(artifactRoot, entry, 'doc-orphan', 'partial.bin');
        if (await stat(partial).then(info => info.isFile()).catch(() => false)) {
          partialObserved = true;
          break;
        }
      }
      if (!partialObserved) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(partialObserved, true, 'fake CLI must create partial private output before timeout');
    await rejected;
    assert.deepEqual(await readdir(artifactRoot), [], 'timeout must remove all invocation artifacts');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('PDF review keeps a successful invocation private and evicts its whole work directory', {
  timeout: 30_000
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'autoin-pdf-preview-success-'));
  const artifactRoot = join(scratch, 'artifacts');
  await mkdir(artifactRoot, { mode: 0o700 });
  await chmod(artifactRoot, 0o700);

  const source = await readFile(new URL('../../fixtures/public/load100/source.pdf', import.meta.url));
  const sourceHash = digest(source);
  const sourceRef = `doc-source/source-000-${sourceHash}.pdf`;
  const manifestRef = 'doc-source/manifest.json';
  const requestData = { documents: [{ artifact_name: sourceRef, copies: 1, duplex: false, paper: 'A4' }] };
  const requestHash = digest(canonical(requestData));
  const sourceAnchor = { format: 'PDF' as const, artifact_ref: sourceRef,
    sha256: sourceHash, size_bytes: source.length };
  const manifestBytes = Buffer.from(JSON.stringify({
    schema: 'ai0.pdf_review_manifest.v1', manifest_ref: manifestRef,
    shop_id: 'success-shop', order_id: 'success-order', active_revision: 1,
    request_hash: requestHash, source: sourceAnchor
  }));
  const snapshot: PdfReviewSnapshot = {
    schema: 'ai0.pdf_review_source.v1', shop_id: 'success-shop', order_id: 'success-order',
    active_revision: 1, request_hash: requestHash, request_data: requestData,
    source: sourceAnchor, manifest: { ref: manifestRef, sha256: digest(manifestBytes) },
    private_bytes: { source, manifest: manifestBytes }
  };
  const service = createPdfReviewPreviewService({ artifactRoot, timeoutMs: 20_000 });
  try {
    const prepared = await service.prepare(snapshot);
    assert.equal(prepared.projection.status, 'REVIEW_REQUIRED');
    assert.equal(prepared.projection.allowed_to_print, false);
    assert.ok(prepared.private_work_dir);
    assert.match(prepared.private_work_dir, /\/pdf-review-[A-Za-z0-9_-]+$/);
    const entries = await readdir(artifactRoot);
    assert.deepEqual(entries, [prepared.private_work_dir.split('/').at(-1)]);
    const page = await service.readPage(prepared, 0);
    assert.deepEqual(page.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await service.remember(prepared);
    await service.clearOrder(snapshot.shop_id, snapshot.order_id);
    assert.deepEqual(await readdir(artifactRoot), []);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
