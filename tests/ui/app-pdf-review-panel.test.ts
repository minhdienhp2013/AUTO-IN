import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
const documentRowsStart = appSource.indexOf('{selectedOrder.documents.map(d=>{');
const documentRowsEnd = appSource.indexOf('{selectedOrder.documents.length===0', documentRowsStart);
const documentRows = appSource.slice(documentRowsStart, documentRowsEnd);

test('live PDF document rows mount only a NOT_WIRED staff review panel for the current order snapshot', () => {
  assert.notEqual(documentRowsStart, -1);
  assert.notEqual(documentRowsEnd, -1);
  assert.match(appSource, /import \{ PdfReviewPanel \} from '\.\/pdf-review-panel\.ts';/);
  assert.match(documentRows, /const format=d\.format\.trim\(\)\.toUpperCase\(\);[\s\S]*?const isPdf=format==='PDF';/);
  assert.match(documentRows, /const authenticatedStaff=Boolean\(session&&\['staff','owner'\]\.includes\(session\.role\)\);/);
  assert.match(documentRows, /!useDemo && authenticatedStaff && isPdf && <PdfReviewPanel/);
  assert.match(documentRows, /identity=\{\{shopId:'',orderId:selectedOrder\.order_id,revision:selectedOrder\.revision,requestHash:selectedOrder\.request_hash,/);
  assert.match(documentRows, /sourceSha256:'',manifestSha256:'',authenticatedStaff/);
  assert.match(documentRows, /state=\{\{status:'NOT_WIRED'\}\}/);
  assert.doesNotMatch(documentRows, /projection\s*:/);
});

test('PDF rows suppress legacy per-document preview URLs while retaining the verified gallery', () => {
  assert.match(documentRows, /isPdf\s*\?\s*<p className="inline-warning" data-testid="pdf-preview-source-gated">/);
  assert.match(documentRows, /không dùng URL preview cũ theo file/);
  assert.match(documentRows, /: <Preview url=\{d\.preview_url\} trusted=\{d\.preview_trusted\}\/?>/);
  assert.match(appSource, /<VerifiedPreviewGallery[\s\S]*?port=\{port\} order=\{selectedOrder\}/);
  assert.match(appSource, /port\.loadVerifiedPreviewPages\(order\)/);
});
