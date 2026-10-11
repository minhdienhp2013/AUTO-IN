const {test} = require('node:test');
const assert = require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const load=(m)=>require(path.join(root,m+'.js'));
const {assertStaff,assertOwner,assertPlan,checkRevision,printingAllowed,canonical,sha,shortage,DomainError}=load('core/model');
const {passwordHash,passwordVerify}=load('core/auth');
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
