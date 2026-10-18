import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource=await readFile(new URL('../../web/src/App.tsx',import.meta.url),'utf8');
function componentSource(name:string,nextName:string):string {
  const start=appSource.indexOf(`function ${name}(`);
  const end=appSource.indexOf(`function ${nextName}(`,start);
  assert.notEqual(start,-1,`${name} component exists`);
  assert.notEqual(end,-1,`${nextName} component boundary exists`);
  return appSource.slice(start,end);
}
const word=componentSource('WordReviewClient','PdfReviewClient');
const pdf=componentSource('PdfReviewClient','VerifiedPreviewGallery');
const gallery=componentSource('VerifiedPreviewGallery','Preview');

test('Word and PDF preview effects hide stale identity and revoke page URLs on cleanup or API error',()=>{
  for(const [name,source] of [['Word',word],['PDF',pdf]] as const){
    assert.match(source,/requestKey=\[identity\.shopId,session\.actor_id,session\.role,order\.order_id,order\.revision,order\.request_hash\]/,`${name} identity includes account and revision`);
    assert.match(source,/state=\{current\?state:\{status:'LOADING'\}\}/,`${name} hides a response for the previous identity`);
    assert.match(source,/\[apiHealthy,[\s\S]*?order\.revision,onUnauthorized,port,requestKey,session\.actor_id,session\.role\]/,`${name} reloads when API/auth/revision changes`);
    assert.match(source,/catch\(error=>\{\s*owned\.forEach\(url=>URL\.revokeObjectURL\(url\)\);owned\.length=0;[\s\S]*?setPageObjectUrls\(\[\]\)/,`${name} error revokes URLs and clears prior pages`);
    assert.match(source,/return\(\)=>\{cancelled=true;owned\.forEach\(url=>URL\.revokeObjectURL\(url\)\);\}/,`${name} cleanup revokes URLs`);
  }
});

test('verified gallery binds Blob URLs to staff/shop/order identity and API health',()=>{
  assert.match(appSource,/VerifiedPreviewGallery key=\{`\$\{port\.authenticatedShopId\(\)\?\?''\}:\$\{session\?\.actor_id\?\?''\}:\$\{session\?\.role\?\?''\}:\$\{selectedOrder\.order_id\}:\$\{selectedOrder\.revision\}:\$\{selectedOrder\.request_hash\}`\}/);
  assert.match(gallery,/requestKey=\[shopId,actorId,actorRole,order\.order_id,order\.revision,order\.request_hash\]/);
  assert.match(gallery,/\[apiHealthy,authenticatedStaff,actorId,actorRole,shopId,port,order\.detail_loaded,order\.order_id,order\.revision,order\.request_hash,requestKey,session\?\.actor_id,session\?\.role\]/);
  assert.match(gallery,/if\(!authenticatedStaff\|\|!apiHealthy\|\|!shopId\|\|order\.detail_loaded!==true\)[\s\S]*?setStatus\('unavailable'\)/);
  assert.match(gallery,/const revokeOwned=\(\)=>\{owned\.splice\(0\)\.forEach\(url=>URL\.revokeObjectURL\(url\)\);\}/);
  assert.match(gallery,/\.catch\(\(\)=>\{\s*revokeOwned\(\);\s*if\(!cancelled\)\{setFacts\(\[\]\);setUrls\(\[\]\);setStatus\('unavailable'\);\}\s*\}\)/);
  assert.match(gallery,/return\(\)=>\{\s*cancelled=true;\s*revokeOwned\(\);\s*\};/);
  assert.match(gallery,/const current=identityCurrent&&authenticatedStaff&&apiHealthy/);
  assert.match(gallery,/const visibleUrls=current\?urls:\[\]/);
  assert.match(gallery,/visibleUrls\.map\(\(url,index\).*?<img[^>]+src=\{url\}/s);
});
