import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
const documentRowsStart = appSource.indexOf('{selectedOrder.documents.map(d=>{');
const documentRowsEnd = appSource.indexOf('{selectedOrder.documents.length===0', documentRowsStart);
const documentRows = appSource.slice(documentRowsStart, documentRowsEnd);

test('PDF document rows mount the staff client for the current order snapshot only', () => {
  assert.notEqual(documentRowsStart, -1);
  assert.notEqual(documentRowsEnd, -1);
  assert.match(appSource, /import \{ parsePdfReviewPreview, PdfReviewPanel,/);
  assert.match(documentRows, /const format=d\.format\.trim\(\)\.toUpperCase\(\);[\s\S]*?const isPdf=format==='PDF';/);
  assert.match(documentRows, /const authenticatedStaff=Boolean\(session&&\['staff','owner'\]\.includes\(session\.role\)\);/);
  assert.match(documentRows, /!useDemo && session && authenticatedStaff && isPdf && <PdfReviewClient/);
  assert.match(documentRows, /port=\{port\} order=\{selectedOrder\} session=\{session\} apiHealthy=\{apiHealthy\}/);
  assert.match(documentRows, /onUnauthorized=\{clearStaffSession\}/);
  assert.match(appSource, /port\.authenticatedShopId\(\)\?\?''/);
  assert.match(appSource, /order\.detail_loaded!==true/);
  assert.match(appSource, /port\.loadPdfReviewPreview\(order\)/);
  assert.match(appSource, /URL\.createObjectURL\(blob\)/);
  assert.match(appSource, /URL\.revokeObjectURL\(url\)/);
  assert.match(appSource, /state=\{current\?state:\{status:'LOADING'\}\}/);
  assert.doesNotMatch(documentRows, /state=\{\{status:'CURRENT'/);
});

test('PDF rows suppress legacy per-document preview URLs while retaining the verified gallery', () => {
  assert.match(documentRows, /isPdf\s*\?\s*<p className="inline-warning" data-testid="pdf-preview-source-gated">/);
  assert.match(documentRows, /không dùng URL preview cũ theo file/);
  assert.match(documentRows, /: <Preview url=\{d\.preview_url\} trusted=\{d\.preview_trusted\}\/?>/);
  assert.match(appSource, /<VerifiedPreviewGallery[\s\S]*?port=\{port\} order=\{selectedOrder\}/);
  assert.match(appSource, /port\.loadVerifiedPreviewPages\(order\)/);
});
