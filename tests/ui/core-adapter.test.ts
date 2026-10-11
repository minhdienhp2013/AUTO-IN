import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, HttpPrintPort, mapCoreOrderDetail, mapOrderSummary } from '../../web/src/api.ts';
import { hasValidApprovalInputs } from '../../web/src/domain.ts';

import { coreDetail } from './core-fixtures.ts';

const json = (value:unknown,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const isFault = (code:string) => (error:unknown) => error instanceof ApiFault && error.code===code;

test('AI1 list mapper reads id/active_revision but cannot assume print/confirmation',()=>{
 const row=mapOrderSummary({id:'order-ai1',active_revision:3,customer_id:'c1',manual_lock:false,delivered_sheets:0});
 assert.equal(row.order_id,'order-ai1');assert.equal(row.revision,3);
 assert.equal(row.print_state,'UNKNOWN');assert.equal(row.confirmed_revision,null);
 assert.equal(hasValidApprovalInputs(row),false);
 assert.throws(()=>mapOrderSummary({id:'broken',active_revision:null}),isFault('INVALID_ORDER_SUMMARY'));
});
test('AI1 detail maps quote, active revision and plan without inventing preview/confirmation',()=>{
 const view=mapCoreOrderDetail(coreDetail());
 assert.equal(view.order_id,'order-ai1'); assert.equal(view.revision,3);assert.equal(view.request_hash,'req-hash');
 assert.equal(view.total_sheets,180); assert.equal(view.required_deposit_vnd,100000); assert.equal(view.received_vnd,45000);
 assert.equal(view.print_state,'NOT_SENT'); assert.equal(view.order_state,'draft');
 assert.equal(view.documents.length,0); assert.equal(view.confirmed_revision,null); assert.equal(hasValidApprovalInputs(view),false);
});
test('AI1 multiple jobs containing UNKNOWN never become verified by optimistic mapping',()=>{
 const d=coreDetail();d.jobs=[{id:'job-1',revision:3,state:'VERIFIED_DONE',printer_id:'RMP7000'},
  {id:'job-2',revision:3,state:'UNKNOWN',printer_id:'RMP7000'}] as typeof d.jobs;
 assert.equal(mapCoreOrderDetail(d).print_state,'UNKNOWN');
 assert.equal(mapCoreOrderDetail(d).job_id,'job-2');
 d.jobs=[{id:'job-3',revision:3,state:'SIMULATED_DONE',printer_id:'RMP7000'}] as typeof d.jobs;
 assert.equal(mapCoreOrderDetail(d).print_state,'SIMULATED_DONE');
});
test('login requires server-issued bearer and checks /me, token never sent in login URL',async()=>{
 const calls:Array<{url:string,authorization:string|null,body:string|undefined}>=[];
 const fetcher=async(url:RequestInfo|URL,opts?:RequestInit):Promise<Response>=>{
  const headers=new Headers(opts?.headers);
  calls.push({url:String(url),authorization:headers.get('Authorization'),body:opts?.body as string|undefined});
  if(String(url).endsWith('/login'))return json({token:'test-session-token',principal:{id:'employee-1',role:'staff',shop_id:'store-demo',verified:true}});
  if(String(url).endsWith('/me'))return json({principal:{id:'employee-1',role:'staff',shop_id:'store-demo',verified:true}});
  if(String(url).endsWith('/logout'))return json({ok:true});
  return json({orders:[{id:'order-ai1',active_revision:3,customer_id:'customer-01'}]});
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 await assert.rejects(()=>port.me(),isFault('UNAUTHENTICATED'));
 const session=await port.login('store-demo','staff-a','synthetic-password');
 assert.equal(session.actor_id,'employee-1');assert.equal(session.can_approve,true);
 assert.match(calls[0].body??'',/"shop_id":"store-demo"/);
 assert.equal(calls[0].authorization,null);assert.equal(calls[1].authorization,'Bearer test-session-token');
 assert.equal((await port.listOrders())[0].order_id,'order-ai1');
 await port.logout();
 await assert.rejects(()=>port.me(),isFault('UNAUTHENTICATED'));
 assert.equal(calls[3].authorization,'Bearer test-session-token');
 assert.ok(calls.every(c=>!c.url.includes('test-session-token')));
});
test('403 staff actor or unverified principal cannot receive privileged session',async()=>{
 const fetcher=async(url:RequestInfo|URL):Promise<Response>=>String(url).endsWith('/login')
  ?json({token:'tok',principal:{id:'not-trusted',role:'staff',shop_id:'s',verified:true}})
  :json({principal:{id:'bad',role:'customer',shop_id:'s',verified:true}});
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 await assert.rejects(()=>port.login('s','demo','pass'),isFault('INVALID_SESSION'));
 await assert.rejects(()=>port.me(),isFault('UNAUTHENTICATED'));
});
test('payment/quote/delivery are sent with AI1 field names and server reread',async()=>{
 const routes:string[]=[];const bodies:Record<string,unknown>[]=[];
 const fetcher=async(url:RequestInfo|URL,opts?:RequestInit):Promise<Response>=>{
  const u=String(url);routes.push(u);
  if(opts?.method==='POST'){bodies.push(JSON.parse(String(opts.body)) as Record<string,unknown>);
    return json(u.endsWith('/payments')?{payment_id:'payment-1',received_vnd:80000}:{order_id:'order-ai1'});}
  return json(coreDetail());
 };
 const port=new HttpPrintPort('',fetcher as typeof fetch);
 const view=mapCoreOrderDetail(coreDetail());
 await port.mutate(view,'quote',{amount_vnd:160000,deposit_required_vnd:100000,significant_cost:true},'quote-1');
 await port.mutate(view,'payment',{amount_vnd:35000,method:'bank_transfer',direction:'received'},'payment-1');
 await port.mutate(view,'delivery',{physical_sheets:10},'delivery-1');
 assert.equal(bodies[0].deposit_required_vnd,100000);assert.equal(bodies[0].significant_cost,true);
 assert.equal(bodies[1].direction,'received');assert.equal(bodies[1].method,'bank_transfer');
 assert.equal(bodies[2].physical_sheets,10);assert.equal(bodies[2].expected_revision,3);
 assert.ok(routes.filter(x=>x.endsWith('/order-ai1')).length>=3);
});
test('missing receipt and unsupported conversation routes fail closed',async()=>{
 const port=new HttpPrintPort('',(async()=>json({ok:true})) as typeof fetch);
 const o=mapCoreOrderDetail(coreDetail());
 await assert.rejects(()=>port.mutate(o,'approve',{acknowledge_deposit_shortage:true},'no-id'),isFault('INVALID_MUTATION_RECEIPT'));
 await assert.rejects(()=>port.mutate(o,'handover',{},'not-yet'),isFault('NOT_IMPLEMENTED'));
});
test('network failure on refresh or payment gives error and does not invent success',async()=>{
 const port=new HttpPrintPort('',(async()=>{throw Error('offline')}) as typeof fetch);
 await assert.rejects(()=>port.getOrder('order-ai1'),isFault('NETWORK'));
 await assert.rejects(()=>port.mutate(mapCoreOrderDetail(coreDetail()),'payment',{amount_vnd:1000,method:'cash',direction:'received'},'pay-1'),isFault('NETWORK'));
});

test('paper verification is a staff-inspected receipt for exactly one uncertain real job',async()=>{
 const d=coreDetail();d.jobs=[{id:'job-uncertain',revision:3,state:'SENT_UNVERIFIED',printer_id:'RMP7000'}] as typeof d.jobs;
 const order=mapCoreOrderDetail(d);const calls:Array<{url:string;body:Record<string,unknown>}>=[];
 const fetcher=async(url:RequestInfo|URL,options?:RequestInit):Promise<Response>=>{
  if (options?.method==='POST'){
   calls.push({url:String(url),body:JSON.parse(String(options.body)) as Record<string,unknown>});
   return json({job_id:'job-uncertain',state:'VERIFIED_DONE'});
  }
  const updated=coreDetail();updated.jobs=[{id:'job-uncertain',revision:3,state:'VERIFIED_DONE',printer_id:'RMP7000'}] as typeof updated.jobs;
  return json(updated);
 };
 const result=await new HttpPrintPort('',fetcher as typeof fetch).mutate(order,'verify_paper',{
   physical_sheets:180,evidence_kind:'staff_inspected',note:'Đã trực tiếp kiểm và đếm giấy'
 },'verify-1');
 assert.equal(calls[0].url,'/api/v1/print-jobs/job-uncertain/verify-paper');
 assert.equal(calls[0].body.evidence_kind,'staff_inspected');
 assert.equal(calls[0].body.physical_sheets,180);
 assert.equal(result.print_state,'VERIFIED_DONE');
});