import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, HttpPrintPort, mapCoreOrderDetail } from '../../web/src/api.ts';
import { coreDetail } from './core-fixtures.ts';
const response = (value: unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const fault = (code:string)=>(err:unknown)=>err instanceof ApiFault&&err.code===code;

test('live handover refuses missing generation without calling backend', async()=>{
 let requests=0;
 const port=new HttpPrintPort('',(async()=>{requests++;return response({})}) as typeof fetch);
 const order=mapCoreOrderDetail(coreDetail());
 await assert.rejects(()=>port.mutate(order,'handover',{},'key'),fault('GENERATION_UNVERIFIED'));
 assert.equal(requests,0);
});
test('handover and return bind to generation, require server receipt and do not retry',async()=>{
 const requests:Array<{path:string,body:Record<string,unknown>}>=[];
 const port=new HttpPrintPort('',(async(url:RequestInfo|URL,options?:RequestInit)=>{
   const body=JSON.parse(String(options?.body)) as Record<string,unknown>;
   requests.push({path:String(url),body});
   return response({conversation_id:'conv-01',status:requests.length===1?'HUMAN':'AI',generation:4+requests.length,claimed_by:requests.length===1?'staff-01':null});
 }) as typeof fetch);
 const order=mapCoreOrderDetail(coreDetail());
 const withGeneration={...order,conversation_id:'conv-01',conversation_generation:4,conversation_claimed_by:null};
 const handover=await port.mutate(withGeneration,'handover',{},'claim-01');
 assert.equal(handover.conversation_generation,5);assert.equal(handover.conversation_state,'staff');
 assert.equal(requests[0].body.expected_generation,4);
 assert.equal(requests[0].body.idempotency_key,'claim-01');
 const returned=await port.mutate(handover,'return_to_ai',{},'return-01');
 assert.equal(returned.conversation_generation,6);assert.equal(returned.conversation_state,'ai');
 assert.equal(requests[1].body.expected_generation,5);assert.equal(requests.length,2);
});
test('403/409/network in handover require user to refresh, never retry',async()=>{
 const order={...mapCoreOrderDetail(coreDetail()),conversation_id:'c-1',conversation_generation:1};
 for(const [status,code] of [[403,'FORBIDDEN'],[409,'STALE_REVISION']] as const){
  let requests=0;
  const port=new HttpPrintPort('',(async()=>{requests++;return response({error:{code,message:'Phải tải lại'}} ,status)}) as typeof fetch);
  await assert.rejects(()=>port.mutate(order,'handover',{},'key'),fault(code));assert.equal(requests,1);
 }
 let requests=0;
 const port=new HttpPrintPort('',(async()=>{requests++;throw Error('offline')}) as typeof fetch);
 await assert.rejects(()=>port.mutate(order,'handover',{},'key'),fault('NETWORK'));
 assert.equal(requests,1);
});