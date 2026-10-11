import test from 'node:test';
import assert from 'node:assert/strict';
// AI4 uses .mode-pill and .simulation-note; no imaginary data-testid needed.
// Chromium viewport emulation is NOT physical iPhone acceptance.
const absent=!process.env.AUTOIN_WEB_URL;
async function withPage(fn){
 const {chromium}=await import('playwright').catch(()=>{throw Error('Playwright missing: AI0 must install approved dependency');});
 const b=await chromium.launch({headless:true});
 try{
  const ctx=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await ctx.newPage();await page.goto(process.env.AUTOIN_WEB_URL,{waitUntil:'domcontentloaded'});
  await fn(page);
 }finally{await b.close();}
}
test('UI-01 mode always visible and demo explicitly labeled',{skip:absent&&'APP NOT RUNNING'},()=>withPage(async page=>{
 const label=page.locator('.mode-pill').first();
 assert.equal(await label.isVisible(),true);
 assert.ok((await label.innerText()).trim().length>0);
 if(process.env.AUTOIN_EXPECT_DEMO==='1') {
  assert.match(await label.innerText(),/mô phỏng|simulation|demo/i);
  const note=page.locator('.simulation-note').first();
  assert.equal(await note.isVisible(),true);
  assert.match(await note.innerText(),/không in|không gửi/i);
 }
}));
test('UI-02 anonymous session cannot approve',{skip:absent||process.env.AUTOIN_EXPECT_ANONYMOUS!=='1'?'AUTH MODE NOT VERIFIED':false},()=>withPage(async page=>{
 const approve=page.getByRole('button',{name:/Duyệt lệnh in/i});
 assert.ok(await approve.count()===0||!(await approve.isEnabled()));
}));
test('UI-03 iPhone-sized viewport does not overflow horizontally',{skip:absent&&'APP NOT RUNNING'},()=>withPage(async page=>{
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
 assert.equal(overflow,false);
}));
