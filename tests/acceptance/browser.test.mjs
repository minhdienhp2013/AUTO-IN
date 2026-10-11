import test from 'node:test';
import assert from 'node:assert/strict';
// Requires AI4 real web and Playwright; viewport emulation != physical iPhone evidence.
const missing=!process.env.AUTOIN_WEB_URL;
async function open(fn){
 const {chromium}=await import('playwright').catch(()=>{throw Error('Playwright missing: request AI0 to install root deps');});
 const b=await chromium.launch({headless:true});
 try{
  const ctx=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await ctx.newPage();await page.goto(process.env.AUTOIN_WEB_URL);
  await fn(page);
 }finally{await b.close();}
}
test('UI: simulation/demo banner on mobile',{skip:missing&&'WEB URL MISSING: NOT RUN'},()=>open(async page=>{
 const el=page.getByTestId('operation-mode-banner');
 assert.equal(await el.isVisible(),true);
 assert.match((await el.innerText()).toLowerCase(),/simulation|demo|mô phỏng/);
}));
test('UI: anonymous cannot approve or send real print',{skip:missing&&'WEB URL MISSING: NOT RUN'},()=>open(async page=>{
 for(const key of ['approve-print-action','send-real-print-action']){
  const el=page.getByTestId(key);
  assert.ok(await el.count()===0||!(await el.isEnabled()));
 }
}));
test('UI: 390px viewport has no horizontal overflow',{skip:missing&&'WEB URL MISSING: NOT RUN'},()=>open(async page=>{
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);
}));
