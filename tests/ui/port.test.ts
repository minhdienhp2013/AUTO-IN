import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, DemoPrintPort, HttpPrintPort, makeMutation, mapOrder } from '../../web/src/api.ts';
import { demoOrders } from '../../web/src/fixtures.ts';

const assertFault = async (fn:()=>Promise<unknown>,code:string) => assert.rejects(fn, (err:unknown) => err instanceof ApiFault && err.code === code);
test('demo approval requires acknowledged short deposit and never marks printed',async()=>{
 const port = new DemoPrintPort();const o=await port.getOrder('MD-260001');
 await assertFault(()=>port.mutate(o,'approve',{},'approval-1'),'DEPOSIT_ACK');
 const result=await port.mutate(o,'approve',{deposit_shortfall_acknowledged:true},'approval-2');
 assert.equal(result.order_state,'approved');assert.equal(result.print_state,'NOT_SENT');
 assert.equal(result.audit[0].action,'DEMO_APPROVE');
});
test('idempotency repeats same result and rejects same key with another payload',async()=>{
 const port = new DemoPrintPort();const o=await port.getOrder('MD-260001');
 const first=await port.mutate(o,'payment',{amount_vnd:10000,method:'cash'},'payment-1');
 const again=await port.mutate(o,'payment',{amount_vnd:10000,method:'cash'},'payment-1');
 assert.equal(again.received_vnd,first.received_vnd);
 await assertFault(()=>port.mutate(o,'payment',{amount_vnd:12000,method:'cash'},'payment-1'),'IDEMPOTENCY_CONFLICT');
});
test('stale revision fails, no optimistic mutation',async()=>{
 const port=new DemoPrintPort();const stale=await port.getOrder('MD-260001');
 await port.mutate(stale,'quote',{amount_vnd:120000},'q-1');
 // quote changes quote revision, not order revision; model remains pending AI0 contract.
 const old={...stale,revision:stale.revision-1};
 await assertFault(()=>port.mutate(old,'payment',{amount_vnd:1000,method:'cash'},'pay-stale'),'STALE_REVISION');
});
test('demo refuses to record real delivery from simulated done or unknown',async()=>{
 const port=new DemoPrintPort();const simulated=await port.getOrder('MD-260004');
 await assertFault(()=>port.mutate(simulated,'delivery',{sheets:1},'d-1'),'NOT_VERIFIED');
 const unknown=await port.getOrder('MD-260003');
 await assertFault(()=>port.mutate(unknown,'manual',{},'m-1'),'PRINT_UNCERTAIN');
});
test('demo network loss surfaces error, not stale success data',async()=>{
 const port=new DemoPrintPort();port.setNetwork(false);
 await assertFault(()=>port.listOrders(),'NETWORK');
 await assertFault(()=>port.mutate(demoOrders[0],'approve',{deposit_shortfall_acknowledged:true},'a-1'),'NETWORK');
});
test('http port uses cookies and idempotency key, then reloads server state',async()=>{
 const calls: Array<{url:string,opts:RequestInit}> = [];
 const fetcher = async (url:RequestInfo|URL,opts?:RequestInit):Promise<Response> => {
   calls.push({url:String(url),opts:opts??{}});
   if (String(url).endsWith('/approvals')) return new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
   return new Response(JSON.stringify({order:demoOrders[0]}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 await port.mutate(demoOrders[0],'approve',{deposit_shortfall_acknowledged:true},'unique-approve');
 assert.equal(calls.length,2);assert.equal(calls[0].opts.credentials,'include');
 assert.equal(new Headers(calls[0].opts.headers).get('Idempotency-Key'),'unique-approve');
 assert.match(String(calls[0].opts.body),/"expected_revision":3/);
});
test('http port 401, 403, 409, 503 never substitutes demo',async()=>{
 for(const status of [401,403,409,503]) {
  const fetcher=async()=>new Response(JSON.stringify({error:{code:'ERR',message:'API failed',current_revision:9}}),{status});
  const port=new HttpPrintPort('',fetcher as typeof fetch);
  await assertFault(()=>port.getOrder('anything'),'ERR');
 }
});
test('untrusted JSON defaults to UNKNOWN, not NOT_SENT or trusted preview',()=>{
 const parsed=mapOrder({order_id:'abc',revision:1,documents:[{filename:'x.pdf',preview_url:'https://example.com/fake.png'}]});
 assert.equal(parsed.print_state,'UNKNOWN');
 assert.equal(parsed.documents[0].preview_trusted,false);
 assert.deepEqual(makeMutation(parsed,{},'k').expected_revision,1);
});