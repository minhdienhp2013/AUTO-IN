'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {createCoreModule}=require(path.join(root,'core/factory.js'));
const noopPool={connect:async()=>({query:async()=>({rows:[],rowCount:0}),release(){}}),query:async()=>({rows:[],rowCount:0})};
const principal={id:'customer-verified',shop_id:'demo-shop',customer_id:'c123',role:'customer',verified:true};
const agent={id:'agent-verified',shop_id:'demo-shop',printer_ids:['RMP7000'],role:'print_agent',verified:true};
function capture() {
 const routes=new Map();
 return {routes,registrar:{get(path,handler){routes.set(`GET ${path}`,handler)},post(path,handler){routes.set(`POST ${path}`,handler)}}};
}
function reply(){let status=200,payload;const r={code(n){status=n;return r},send(x){payload=x;return x}};return {r,inspect:()=>({status,payload})};}
test('factory requires PostgreSQL port and trusted resolvers; no test principal at runtime',()=>{
 assert.throws(()=>createCoreModule({pool:null}),e=>e.code==='POSTGRES_REQUIRED');
 const module=createCoreModule({pool:noopPool});
 assert.equal(typeof module.service.claim,'function');
 assert.equal(typeof module.auth.login,'function');
 assert.throws(()=>module.registerRoutes(capture().registrar,null),e=>e.code==='VERIFIED_IDENTITY_PORTS_REQUIRED');
});
test('V1 factory requires and forwards the server-owned evidence verifier; legacy mode remains available',()=>{
 const evidence={read_verified:async()=>null};
 const v1=createCoreModule({pool:noopPool,mode:'v1',evidence});
 assert.equal(v1.service.evidence,evidence,'Core must receive the exact factory-injected verifier');
 assert.throws(()=>createCoreModule({pool:noopPool,mode:'v1'}),e=>e.code==='PRINT_EVIDENCE_NOT_CONFIGURED');
 assert.throws(()=>createCoreModule({pool:noopPool,mode:'v1',evidence:{}}),e=>e.code==='PRINT_EVIDENCE_NOT_CONFIGURED');
 assert.throws(()=>createCoreModule({pool:noopPool,evidence}),e=>e.code==='V1_MODE_REQUIRED');
 assert.equal(typeof createCoreModule({pool:noopPool}).service.claim,'function');
});
test('factory registers one complete AI1 route set with fail-closed customer and print agent ports',async()=>{
 const mod=createCoreModule({pool:noopPool});
 const {routes,registrar}=capture();
 mod.registerRoutes(registrar,{
   resolveVerifiedCustomer:async()=>({...principal,verified:false}),
   resolvePrintAgent:async()=>({...agent,printer_ids:[]})
 });
 assert.ok(routes.has('POST /api/v1/orders/:order_id/confirmations'));
 assert.ok(routes.has('POST /internal/v1/print-jobs/claim'));
 assert.ok(routes.has('POST /api/v1/conversations/:conversation_id/handover'));
 assert.ok(routes.has('POST /api/v1/conversations/:conversation_id/return-to-ai'));
 const customerReply=reply();
 await routes.get('POST /api/v1/orders/:order_id/confirmations')({headers:{},params:{order_id:'order'},body:{}},customerReply.r);
 assert.equal(customerReply.inspect().status,403);
 assert.equal(customerReply.inspect().payload.error.code,'CUSTOMER_VERIFICATION_REQUIRED');
 const agentReply=reply();
 await routes.get('POST /internal/v1/print-jobs/claim')({headers:{},body:{printer_id:'RMP7000'}},agentReply.r);
 assert.equal(agentReply.inspect().status,403);
 assert.equal(agentReply.inspect().payload.error.code,'AGENT_VERIFICATION_REQUIRED');
});
test('rejects resolvers that return client-asserted principal or missing shop scopes',async()=>{
 const mod=createCoreModule({pool:noopPool});
 const {routes,registrar}=capture();
 mod.registerRoutes(registrar,{resolveVerifiedCustomer:async()=>({...principal,shop_id:''}),resolvePrintAgent:async()=>({...agent,shop_id:''})});
 const cases=[['POST /api/v1/orders/:order_id/confirmations',{headers:{},params:{order_id:'x'},body:{}},'CUSTOMER_VERIFICATION_REQUIRED'],
 ['POST /internal/v1/print-jobs/claim',{headers:{},body:{printer_id:'RMP7000'}},'AGENT_VERIFICATION_REQUIRED']];
 for(const [route,request,code] of cases){const output=reply();await routes.get(route)(request,output.r);assert.equal(output.inspect().payload.error.code,code)}
});
