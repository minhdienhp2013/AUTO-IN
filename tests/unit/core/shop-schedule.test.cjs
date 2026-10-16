const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {validateSchedulePatch}=require(path.join(root,'core/shop-schedule.js'));
const {DomainError}=require(path.join(root,'core/model.js'));
const good={expected_version:1,idempotency_key:'owner-op-1',manual_lock:true};
const invalid=(body,code='INVALID_SCHEDULE')=>assert.throws(
 ()=>validateSchedulePatch(body),e=>e instanceof DomainError&&e.code===code);
test('CODE501 strict schema never accepts operation-mode toggles or spoofed shop',()=>{
 assert.deepEqual(validateSchedulePatch(good),{expected_version:1,idempotency_key:'owner-op-1',changes:{manual_lock:true}});
 for(const key of ['mode','printing_enabled','operational_guard'])invalid({...good,[key]:false},'READ_ONLY_OPERATION_FIELDS');
 for(const key of ['shop_id','actor_id','role','version','unknown','__proto__'])
  invalid({...good,[key]:1},'INVALID_INPUT');
 invalid({expected_version:1,idempotency_key:'x'},'INVALID_SCHEDULE');
 invalid({expected_version:1,idempotency_key:'x',manual_lock:null});
 invalid({expected_version:0,idempotency_key:'x',manual_lock:false});
 invalid({expected_version:1,idempotency_key:' ',manual_lock:false},'IDEMPOTENCY_REQUIRED');
 invalid({...good,idempotency_key:'a'.repeat(129)},'IDEMPOTENCY_REQUIRED');
});
test('CODE501 local business time and holiday Gregorian dates',()=>{
 assert.deepEqual(validateSchedulePatch({expected_version:1,idempotency_key:'x',holiday_dates:['2028-02-29','2026-01-01']}).changes.holiday_dates,['2026-01-01','2028-02-29']);
 for(const open_at of ['24:00','7:00','07:60','-1:00','07:00:00','07:00Z'])invalid({...good,open_at});
 for(const close_at of ['24:01','25:00','21:60','21:30:00'])invalid({...good,close_at});
 assert.equal(validateSchedulePatch({...good,close_at:'24:00'}).changes.close_at,'24:00');
 for(const date of ['2026-02-29','2026-04-31','2026-00-01','2026-13-01','0000-12-01','2026-2-01'])invalid({...good,holiday_dates:[date]});
 invalid({...good,holiday_dates:['2026-01-01','2026-01-01']});
 invalid({...good,holiday_dates:Array.from({length:731},(_,i)=>String(i))});
 invalid({...good,timezone:'UTC'});
 assert.equal(validateSchedulePatch({...good,timezone:'Asia/Ho_Chi_Minh'}).changes.timezone,'Asia/Ho_Chi_Minh');
});
