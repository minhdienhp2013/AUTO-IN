import test from 'node:test';import assert from 'node:assert/strict';
const skip=!process.env.AUTOIN_WEB_URL&&'AI4 BROWSER SERVER NOT RUNNING';
async function viewport(width,height,fn){
 const {chromium}=await import('playwright').catch(()=>{throw Error('Playwright missing; AI4 must provide browser dependency')});
 const b=await chromium.launch({headless:true});
 try{const context=await b.newContext({viewport:{width,height},isMobile:width<600,hasTouch:width<600});
  const page=await context.newPage();await page.goto(process.env.AUTOIN_WEB_URL,{waitUntil:'domcontentloaded'});
  await fn(page)}finally{await b.close()}
}
async function assertMode(page){
 const mode=page.locator('.mode-pill').first();assert.equal(await mode.isVisible(),true);
 assert.ok((await mode.innerText()).trim().length>0);
 if(process.env.AUTOIN_EXPECT_DEMO==='1'){
  assert.match(await mode.innerText(),/mô phỏng|simulation|demo/i);
  const notice=page.locator('.simulation-note').first();assert.equal(await notice.isVisible(),true);
  assert.match(await notice.innerText(),/không in|không gửi/i)}
}
async function assertNoOverflow(page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false)}
test('UI-01 desktop 1440x900 renders safe mode',{skip},()=>viewport(1440,900,assertMode));
test('UI-02 mobile 390x844 renders safe mode',{skip},()=>viewport(390,844,assertMode));
test('UI-03 desktop has no horizontal overflow',{skip},()=>viewport(1440,900,assertNoOverflow));
test('UI-04 mobile has no horizontal overflow',{skip},()=>viewport(390,844,assertNoOverflow));
test('UI-05 anonymous session cannot approve',{skip:skip||process.env.AUTOIN_EXPECT_ANONYMOUS!=='1'?'AUTH MODE NOT VERIFIED':false},()=>viewport(390,844,async page=>{
 const approve=page.getByRole('button',{name:/Duyệt lệnh in/i});
 assert.ok(await approve.count()===0||!(await approve.isEnabled()))}));
