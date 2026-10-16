import test from 'node:test';
import assert from 'node:assert/strict';
import {canEditShopSchedule,draftFromSchedule,parseShopSchedule,prepareSchedulePatch,
  saveShopScheduleAndRead,scheduleErrorText,type ShopSchedule,type SchedulePort} from '../../web/src/shop-schedule.ts';

const base=():ShopSchedule=>parseShopSchedule({shop_id:'isolated-shop-a',version:8,
  open_at:'07:00',close_at:'21:30',timezone:'Asia/Ho_Chi_Minh',
  holiday_dates:['2026-10-20'],manual_lock:false,
  operational_guard:{mode:'simulation',printing_enabled:false}});
const fault=(status:number)=>Object.assign(new Error('synthetic no secrets'),{status});

test('strict GET decoder rejects missing scope/version/guard and never invents print mode',()=>{
 const a=base();assert.equal(a.version,8);
 for(const raw of [
  {...a,shop_id:''},{...a,version:0},{...a,version:'8'},
  {...a,operational_guard:{mode:'production',printing_enabled:'true'}},
  {...a,timezone:'Asia/Bangkok'},{...a,open_at:'22:00',close_at:'07:00'},
  {...a,holiday_dates:['2026-02-29']},{...a,holiday_dates:['2026-10-20','2026-10-20']},
 ])assert.throws(()=>parseShopSchedule(raw));
});
test('staff is view-only regardless of claimed can_manage_schedule; owner only when allowed',()=>{
 assert.equal(canEditShopSchedule('staff',true),false);
 assert.equal(canEditShopSchedule('owner',false),false);
 assert.equal(canEditShopSchedule('owner',true),true);
 assert.equal(canEditShopSchedule(null,true),false);
});
test('PATCH is minimal, CAS version and idempotency key; omits forbidden mode/shop/printing fields',()=>{
 const s=base(),d=draftFromSchedule(s);d.open_at='08:00';d.holiday_dates='2026-10-22,\n2026-10-20';
 const p=prepareSchedulePatch(s,d,'once-1');
 assert.deepEqual(p,{expected_version:8,idempotency_key:'once-1',
   open_at:'08:00',holiday_dates:['2026-10-20','2026-10-22']});
 assert.equal(Object.hasOwn(p!,'printing_enabled'),false);
 assert.equal(Object.hasOwn(p!,'mode'),false);
 assert.equal(Object.hasOwn(p!,'shop_id'),false);
});
test('no-change is no PATCH, normalized holiday order is equal',()=>{
 const s=base(),d=draftFromSchedule(s);
 d.holiday_dates='2026-10-20';
 assert.equal(prepareSchedulePatch(s,d,'id'),null);
});
test('invalid HH:mm, overnight, duplicate, malformed or too many dates fail before network',()=>{
 const s=base();
 for(const [field,value] of [
  ['open_at','24:00'],['close_at','24:01'],['open_at','22:00'],
  ['open_at','7:00'],['holiday_dates','2026-02-29'],
  ['holiday_dates','2026-10-20 2026-10-20'],
  ['holiday_dates',Array.from({length:731},(_,i)=>'2026-10-20').join(',')],
 ] as const){
  const d={...draftFromSchedule(s),[field]:value};
  assert.throws(()=>prepareSchedulePatch(s,d,'id'));
 }
});
test('owner PATCH must always GET after success; trust readback, not changed or replay receipt',async()=>{
 const s=base(),events:string[]=[];
 const fresh={...s,version:9,open_at:'08:00'};
 const port:SchedulePort={async patchShopSchedule(p){events.push('PATCH');
   assert.deepEqual(p,{expected_version:8,idempotency_key:'key-1',open_at:'08:00'});
   return {...s,version:9,open_at:'08:00'};},
  async getShopSchedule(){events.push('GET');return fresh;}};
 const o=await saveShopScheduleAndRead(port,s,{...draftFromSchedule(s),open_at:'08:00'},'key-1');
 assert.equal(o.kind,'saved');assert.deepEqual(o.fresh,fresh);assert.deepEqual(events,['PATCH','GET']);
});
test('idempotent replay also reads fresh authoritative version',async()=>{
 const s=base();let patch=0,gets=0;
 const port:SchedulePort={async patchShopSchedule(p){patch++;
   assert.equal(p.idempotency_key,'replay-identical');return {...s,version:9,open_at:'08:00'};},
  async getShopSchedule(){gets++;return {...s,version:10,open_at:'09:00'};}};
 for(let i=0;i<2;i++){
  const o=await saveShopScheduleAndRead(port,s,{...draftFromSchedule(s),open_at:'08:00'},'replay-identical');
  assert.equal(o.kind,'saved');assert.equal(o.fresh?.version,10);
 }
 assert.equal(patch,2);assert.equal(gets,2);
});
test('401/403/409/503/offline after PATCH always GET and never auto retries',async()=>{
 const s=base();
 for(const status of [401,403,409,503,0]){
  let patches=0,gets=0;
  const port:SchedulePort={
   async patchShopSchedule(){patches++;throw fault(status);},
   async getShopSchedule(){gets++;return {...s,version:9};}
  };
  const o=await saveShopScheduleAndRead(port,s,{...draftFromSchedule(s),manual_lock:true},'k');
  assert.equal(o.kind,'failed');assert.equal(o.fresh?.version,9);
  assert.equal(patches,1);assert.equal(gets,1);
  assert.match(scheduleErrorText(o.failure),/lịch|Lịch|kết nối|quyền|đăng nhập/);
 }
});
test('ambiguous PATCH success plus failed GET is not confirmed saved',async()=>{
 const s=base();let patches=0,gets=0;
 const port:SchedulePort={
  async patchShopSchedule(){patches++;return {...s,version:9};},
  async getShopSchedule(){gets++;throw fault(503);}
 };
 const o=await saveShopScheduleAndRead(port,s,{...draftFromSchedule(s),manual_lock:true},'k');
 assert.equal(o.kind,'failed');assert.equal(o.readbackFailed,true);assert.equal(o.fresh,null);
 assert.equal(patches,1);assert.equal(gets,1);
});
test('shop scope mismatch on readback stays failure; no cross-shop schedule cached',async()=>{
 const s=base();
 const port:SchedulePort={
  async patchShopSchedule(){return {...s,version:9};},
  async getShopSchedule(){return {...s,shop_id:'other-shop'};}
 };
 const o=await saveShopScheduleAndRead(port,s,{...draftFromSchedule(s),manual_lock:true},'k');
 assert.equal(o.kind,'failed');assert.equal(o.fresh,null);
});
test('no-change never hits PATCH or GET',async()=>{
 const s=base();
 const port:SchedulePort={async patchShopSchedule(){assert.fail('PATCH');},
  async getShopSchedule(){assert.fail('GET');}};
 assert.equal((await saveShopScheduleAndRead(port,s,draftFromSchedule(s),'k')).kind,'unchanged');
});
