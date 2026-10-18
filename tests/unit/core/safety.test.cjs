const {test} = require('node:test');
const assert = require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const load=(m)=>require(path.join(root,m+'.js'));
const {assertStaff,assertOwner,assertAgent,assertPlan,checkRevision,printingAllowed,canonical,sha,shortage,dbSafeInteger,DomainError}=load('core/model');
const {passwordHash,passwordVerify}=load('core/auth');
const {OrderService}=load('core/service');
const owner={id:'user1',shop_id:'shop1',role:'owner',verified:true};
const staff={...owner,id:'user2',role:'staff'};
const agent={...owner,id:'print1',role:'print_agent'};
const fake={...owner,verified:false};
test('server-side roles forbid unauthenticated actors and owners-only action',()=>{
 assert.throws(()=>assertStaff(fake),e=>e.status===401);
 assert.throws(()=>assertStaff(agent),e=>e.status===403);
 assert.throws(()=>assertOwner(staff),e=>e.status===403);
 assert.doesNotThrow(()=>assertStaff(staff));assert.doesNotThrow(()=>assertOwner(owner));
});
test('revision protection and canonical request hash',()=>{
 assert.throws(()=>checkRevision(1,2),e=>e.status===409&&e.current_revision===2);
 assert.equal(sha(canonical({b:[1,2],a:'x'})),sha(canonical({a:'x',b:[1,2]})));
});
test('untrusted plan cannot be passed to approval',()=>{
 const hash=sha('request');
 assert.throws(()=>assertPlan({request_hash:hash,physical_sheets:151,document_pages:151,printed_faces:151,ready:false,printer_id:'RMP7000',artifact_ref:'x',verified_by:'processor'},hash),DomainError);
 assert.throws(()=>assertPlan({request_hash:hash,physical_sheets:151,document_pages:151,printed_faces:151,ready:true,status:'REVIEW_REQUIRED',printer_id:'RMP7000',artifact_ref:'x',verified_by:'processor'},hash),e=>e.code==='UNTRUSTED_PLAN');
 assert.throws(()=>assertPlan({request_hash:hash,physical_sheets:151,document_pages:151,printed_faces:151,ready:true,status:'NEEDS_HUMAN',printer_id:'RMP7000',artifact_ref:'x',verified_by:'processor'},hash),e=>e.code==='UNTRUSTED_PLAN');
 assert.throws(()=>assertPlan({request_hash:'bad',physical_sheets:151,document_pages:151,printed_faces:151,ready:true,printer_id:'RMP7000',artifact_ref:'x',verified_by:'processor'},hash),DomainError);
});
test('simulation still honors holidays, opening hours and manual lock',()=>{
 const now=new Date('2026-10-12T04:00:00.000Z'); // 11:00 Vietnam
 const s={shop_id:'s',mode:'simulation',printing_enabled:false,manual_lock:false,holiday_dates:[],open_at:'07:00',close_at:'21:30',timezone:'Asia/Ho_Chi_Minh'};
 assert.equal(printingAllowed(s,now),true);
 assert.equal(printingAllowed({...s,holiday_dates:['2026-10-12']},now),false);
 assert.equal(printingAllowed({...s,manual_lock:true},now),false);
 assert.equal(printingAllowed({...s,mode:'production'},now),false);
 assert.equal(printingAllowed({...s,mode:'safe'},now),false);
 assert.equal(printingAllowed({...s,open_at:'12:00'},now),false);
 assert.equal(shortage(80000,30000),50000);
});
test('password hashing creates unique salts and validates credentials',async()=>{
 const x=await passwordHash('an-exceptional-password-2026'),y=await passwordHash('an-exceptional-password-2026');
 assert.notEqual(x,y);assert.equal(await passwordVerify('an-exceptional-password-2026',x),true);
 assert.equal(await passwordVerify('wrong-password',x),false);
 await assert.rejects(passwordHash('short'),DomainError);
});

test('BIGINT values returned as text cannot corrupt partial-delivery arithmetic',()=>{
 assert.equal(dbSafeInteger('0','delivered_sheets')+2,2);
 assert.equal(dbSafeInteger('2','delivered_sheets')+3,5);
 assert.equal(dbSafeInteger(5,'delivered_sheets')+1,6);
 assert.throws(()=>dbSafeInteger('9007199254740993','delivered_sheets'),e=>e.code==='DB_INTEGER_OVERFLOW');
 assert.throws(()=>dbSafeInteger('2.1','delivered_sheets'),e=>e.code==='INVALID_DB_INTEGER');
});

test('mock-only: no paper verification of simulation, and fake device proof is rejected',async()=>{
 const stubStore={
  tx:async fn=>fn({query:async()=>({rows:[],rowCount:0})}),
  once:async(_db,_p,_action,_key,_payload,fn)=>fn(),
  one:async(_db,sql)=>{
    if(sql.startsWith('SELECT order_id FROM core_print_jobs'))return {order_id:'order1'};
    if(sql.startsWith('SELECT * FROM core_orders'))return {id:'order1',shop_id:'shop1',active_revision:1,delivered_sheets:'0',manual_lock:false,print_closed:false};
    if(sql.startsWith('SELECT * FROM core_print_jobs'))return {id:'job1',state:'UNKNOWN',mode_at_send:'simulation'};
    throw Error('unexpected SQL '+sql);
  }
 };
 const svc=new OrderService(stubStore);
 await assert.rejects(svc.verifyPaper(staff,'job1',{evidence_kind:'staff_inspected',physical_sheets:1,note:'inspection',idempotency_key:'no-real-paper'}),e=>e.code==='SIMULATION_NOT_PAPER');
 await assert.rejects(svc.verifyPaper(staff,'job1',{evidence_kind:'device_verified',physical_sheets:1,note:'fake telemetry',idempotency_key:'fake-device'}),e=>e.code==='DEVICE_PROOF_NOT_CONNECTED'&&e.status===503);
});

test('agent role is not enough without a trusted printer scope',()=>{
 assert.throws(()=>assertAgent({...owner,id:'unscoped',role:'print_agent'}),e=>e.code==='AGENT_REQUIRED');
 assert.throws(()=>assertAgent({...owner,id:'unverified',role:'print_agent',printer_ids:['RMP7000'],verified:false}),e=>e.code==='AGENT_REQUIRED');
 assert.doesNotThrow(()=>assertAgent({...owner,id:'agent',role:'print_agent',printer_ids:['RMP7000']}));
});
