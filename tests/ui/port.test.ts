import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, DemoPrintPort, HttpPrintPort, makeMutation, mapOrder } from '../../web/src/api.ts';
import { demoOrders } from '../../web/src/fixtures.ts';
import { coreDetail } from './core-fixtures.ts';

const assertFault = async (fn:()=>Promise<unknown>,code:string) => assert.rejects(fn, (err:unknown) => err instanceof ApiFault && err.code === code);
test('demo approval requires acknowledged short deposit and never marks printed',async()=>{
 const port = new DemoPrintPort();const o=await port.getOrder('MD-260001');
 await assertFault(()=>port.mutate(o,'approve',{},'approval-1'),'DEPOSIT_ACK');
 const result=await port.mutate(o,'approve',{acknowledge_deposit_shortage:true},'approval-2');
 assert.equal(result.order_state,'approved');assert.equal(result.print_state,'NOT_SENT');
 assert.equal(result.audit[0].action,'DEMO_APPROVE');
});
test('idempotency repeats same result and rejects same key with another payload',async()=>{
 const port = new DemoPrintPort();const o=await port.getOrder('MD-260001');
 const first=await port.mutate(o,'payment',{amount_vnd:10000,direction:'received',method:'cash'},'payment-1');
 const again=await port.mutate(o,'payment',{amount_vnd:10000,direction:'received',method:'cash'},'payment-1');
 assert.equal(again.received_vnd,first.received_vnd);
 await assertFault(()=>port.mutate(o,'payment',{amount_vnd:12000,direction:'received',method:'cash'},'payment-1'),'IDEMPOTENCY_CONFLICT');
});
test('stale revision fails, no optimistic mutation',async()=>{
 const port=new DemoPrintPort();const stale=await port.getOrder('MD-260001');
 await port.mutate(stale,'quote',{amount_vnd:120000,deposit_required_vnd:0,significant_cost:false},'q-1');
 // quote changes quote revision, not order revision; model remains pending AI0 contract.
 const old={...stale,revision:stale.revision-1};
 await assertFault(()=>port.mutate(old,'payment',{amount_vnd:1000,direction:'received',method:'cash'},'pay-stale'),'STALE_REVISION');
});
test('demo refuses to record real delivery from simulated done or unknown',async()=>{
 const port=new DemoPrintPort();const simulated=await port.getOrder('MD-260004');
 await assertFault(()=>port.mutate(simulated,'delivery',{physical_sheets:1},'d-1'),'NOT_VERIFIED');
 const unknown=await port.getOrder('MD-260003');
 await assertFault(()=>port.mutate(unknown,'manual',{},'m-1'),'PRINT_UNCERTAIN');
});
test('demo network loss surfaces error, not stale success data',async()=>{
 const port=new DemoPrintPort();port.setNetwork(false);
 await assertFault(()=>port.listOrders(),'NETWORK');
 await assertFault(()=>port.mutate(demoOrders[0],'approve',{acknowledge_deposit_shortage:true},'a-1'),'NETWORK');
});
test('HTTP approval sends correct AI1 envelope and reloads read model',async()=>{
 const calls: Array<{url:string,opts:RequestInit}> = [];
 const fetcher = async (url:RequestInfo|URL,opts?:RequestInit):Promise<Response> => {
   calls.push({url:String(url),opts:opts??{}});
   if (String(url).endsWith('/approvals')) return new Response(JSON.stringify({order_id:'order-ai1',job_id:'job-ai1'}),{status:200,headers:{'Content-Type':'application/json'}});
   return new Response(JSON.stringify(coreDetail()),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 const order={...demoOrders[0],order_id:'order-ai1'};
 const result=await port.mutate(order,'approve',{acknowledge_deposit_shortage:true,quote_revision:2},'unique-approve');
 assert.equal(result.order_id,'order-ai1');
 assert.equal(calls.length,2);assert.equal(calls[0].opts.credentials,'same-origin');
 assert.equal(new Headers(calls[0].opts.headers).get('Idempotency-Key'),'unique-approve');
 assert.match(String(calls[0].opts.body),/"expected_revision":3/);
 assert.match(String(calls[0].opts.body),/"acknowledge_deposit_shortage":true/);
});
test('http port 401, 403, 409, 503 never substitutes demo',async()=>{
 for(const status of [401,403,409,503]) {
  const fetcher=async()=>new Response(JSON.stringify({error:{code:'ERR',message:'API failed',current_revision:9}}),{status});
  const port=new HttpPrintPort('',fetcher as typeof fetch);
  await assertFault(()=>port.getOrder('anything'),'ERR');
 }
});
test('late shop A 401 cannot clear shop B credentials or order data',async()=>{
 let resolveShopA!:(value:Response)=>void;
 const shopAResponse=new Promise<Response>(resolve=>{resolveShopA=resolve;});
 const requests:Array<{url:string,authorization:string|null}> = [];
 const fetcher=async(url:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const path=String(url);
  const authorization=new Headers(init?.headers).get('Authorization');
  requests.push({url:path,authorization});
  if(path.endsWith('/api/v1/auth/login')){
   const body=JSON.parse(String(init?.body));
   return new Response(JSON.stringify({token:`token-${body.shop_id}`,principal:{id:'staff',shop_id:body.shop_id}}),
    {status:200,headers:{'Content-Type':'application/json'}});
  }
  if(path.endsWith('/api/v1/auth/me')){
   const shop=authorization==='Bearer token-shop-A'?'shop-A':'shop-B';
   return new Response(JSON.stringify({principal:{id:`staff-${shop}`,shop_id:shop,role:'staff',verified:true}}),
    {status:200,headers:{'Content-Type':'application/json'}});
  }
  if(path.endsWith('/api/v1/orders')&&authorization==='Bearer token-shop-A')return shopAResponse;
  if(path.endsWith('/api/v1/orders')&&authorization==='Bearer token-shop-B'){
   return new Response(JSON.stringify({orders:[{id:'order-from-shop-B',active_revision:1}]}),
    {status:200,headers:{'Content-Type':'application/json'}});
  }
  throw new Error('Unexpected synthetic request');
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 await port.login('shop-A','staff','secret-A');
 const staleA=port.listOrders();
 await port.login('shop-B','staff','secret-B');
 resolveShopA(new Response(JSON.stringify({error:{code:'EXPIRED'}}),
  {status:401,headers:{'Content-Type':'application/json'}}));
 await assertFault(()=>staleA,'STALE_SESSION_RESPONSE');
 assert.equal(port.authenticatedShopId(),'shop-B');
 const orders=await port.listOrders();
 assert.deepEqual(orders.map(order=>order.order_id),['order-from-shop-B']);
 assert.ok(requests.some(request=>request.url.endsWith('/api/v1/orders')&&
  request.authorization==='Bearer token-shop-A'));
});
test('current-session 401 clears the bearer and authenticated shop',async()=>{
 let denyOrders=false;
 const fetcher=async(url:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const path=String(url);
  if(path.endsWith('/api/v1/auth/login'))return new Response(JSON.stringify({token:'token-current',principal:{id:'staff',shop_id:'shop-current'}}),
   {status:200,headers:{'Content-Type':'application/json'}});
  if(path.endsWith('/api/v1/auth/me'))return new Response(JSON.stringify({principal:{id:'staff-current',shop_id:'shop-current',role:'staff',verified:true}}),
   {status:200,headers:{'Content-Type':'application/json'}});
  if(path.endsWith('/api/v1/orders')&&denyOrders){
   assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer token-current');
   return new Response(JSON.stringify({error:{code:'EXPIRED'}}),{status:401,headers:{'Content-Type':'application/json'}});
  }
  return new Response(JSON.stringify({orders:[]}),{status:200,headers:{'Content-Type':'application/json'}});
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 await port.login('shop-current','staff','secret');
 assert.equal(port.authenticatedShopId(),'shop-current');
 denyOrders=true;
 await assertFault(()=>port.listOrders(),'EXPIRED');
 assert.equal(port.authenticatedShopId(),null);
 await assertFault(()=>port.loadCurrentShopCode(),'UNAUTHENTICATED');
});
test('untrusted JSON defaults to UNKNOWN, not NOT_SENT or trusted preview',()=>{
 const parsed=mapOrder({order_id:'abc',revision:1,documents:[{filename:'x.pdf',preview_url:'https://example.com/fake.png'}]});
 assert.equal(parsed.print_state,'UNKNOWN');
 assert.equal(parsed.documents[0].preview_trusted,false);
 assert.deepEqual(makeMutation(parsed,{},'k').expected_revision,1);
});
