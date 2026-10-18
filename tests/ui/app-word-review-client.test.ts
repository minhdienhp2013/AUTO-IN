import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource=await readFile(new URL('../../web/src/App.tsx',import.meta.url),'utf8');
const apiSource=await readFile(new URL('../../web/src/api.ts',import.meta.url),'utf8');
const panelSource=await readFile(new URL('../../web/src/word-review-panel.ts',import.meta.url),'utf8');
const rowsStart=appSource.indexOf('{selectedOrder.documents.map(d=>{');
const rowsEnd=appSource.indexOf('{selectedOrder.documents.length===0',rowsStart);
const documentRows=appSource.slice(rowsStart,rowsEnd);
const clientStart=appSource.indexOf('function WordReviewClient(');
const clientEnd=appSource.indexOf('function PdfReviewClient(',clientStart);
const client=appSource.slice(clientStart,clientEnd);

test('current authenticated staff sees one Word client tied to the selected detail revision and hash',()=>{
  assert.notEqual(rowsStart,-1);assert.notEqual(rowsEnd,-1);assert.notEqual(clientStart,-1);assert.notEqual(clientEnd,-1);
  assert.match(appSource,/firstWordDocument=selectedOrder\?\.documents\.find\(d=>\['DOC','DOCX','WORD'\]\.includes\(d\.format\.trim\(\)\.toUpperCase\(\)\)\)/);
  assert.match(documentRows,/const isWord=\['DOC','DOCX','WORD'\]\.includes\(format\);/);
  assert.match(documentRows,/!useDemo && session && authenticatedStaff && isWord && d===firstWordDocument && <WordReviewClient/);
  assert.match(documentRows,/key=\{`\$\{selectedOrder\.order_id\}:\$\{selectedOrder\.revision\}:\$\{selectedOrder\.request_hash\}:\$\{session\.actor_id\}:\$\{session\.role\}`\}/);
  assert.match(client,/shopId:port\.authenticatedShopId\(\)\?\?''/);
  assert.match(client,/orderId:order\.order_id/);assert.match(client,/revision:order\.revision/);
  assert.match(client,/requestHash:order\.request_hash/);assert.match(client,/order\.detail_loaded!==true/);
  assert.match(client,/port\.loadWordReviewPreview\(order\)/);
  assert.match(client,/URL\.createObjectURL\(blob\)/);assert.match(client,/URL\.revokeObjectURL\(url\)/);
  assert.match(client,/return\(\)=>\{cancelled=true;owned\.forEach\(url=>URL\.revokeObjectURL\(url\)\);\}/);
  assert.match(client,/requestKey=\[identity\.shopId,session\.actor_id,session\.role,order\.order_id,order\.revision,order\.request_hash\]\.join\('\|'\)/);
  assert.match(client,/state=\{current\?state:\{status:'LOADING'\}\}/);
  assert.doesNotMatch(documentRows,/state=\{\{status:'CURRENT'/);
});

test('Word review uses scoped staff bearer, validates routes and bytes, and renders only revocable Blob URLs',()=>{
  assert.match(apiSource,/`\/api\/v1\/orders\/\$\{encodeURIComponent\(order_id\)\}\/revisions\/\$\{revision\}\/word-review-previews`/);
  assert.match(apiSource,/method:'POST',body:JSON\.stringify\(\{\}\),redirect:'error'/);
  assert.match(apiSource,/Authorization:`Bearer \$\{token\}`/);
  assert.match(apiSource,/credentials:'same-origin',cache:'no-store',redirect:'error'/);
  assert.match(apiSource,/globalThis\.crypto\.subtle\.digest\('SHA-256',bytes\)/);
  assert.match(panelSource,/e\('img', \{ src: verifiedPageObjectUrls\?\.\[index\]\?\.url/);
  assert.doesNotMatch(panelSource,/e\('img', \{ src: page\.url/);
  assert.match(panelSource,/URL\(loaded\.url\)\.protocol==='blob:'/);
  assert.doesNotMatch(panelSource,/<(?:button|form|input)\b/i);
});
