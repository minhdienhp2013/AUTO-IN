import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const f=JSON.parse(await readFile(resolve(here,'../fixtures/public/scenarios.json'),'utf8'));
const item=n=>f.cases.find(x=>x.name===n);
test('FIXTURE ONLY: no real customer / no real printer',()=>{
 assert.equal(f.origin,'SYNTHETIC_PUBLIC_NO_CUSTOMER_DATA');
 assert.equal(f.cases.length,10);
 assert.ok(f.cases.every(x=>x.mode==='simulation'));
 assert.equal(new Set(f.cases.map(x=>x.id)).size,10);
});
test('FIXTURE ONLY: stale revisions and UNKNOWN stay distinct',()=>{
 assert.notEqual(item('stale_revision').revision,item('stale_revision').approved_revision);
 assert.equal(item('unknown_after_crash').print_state,'UNKNOWN');
 assert.equal(item('spooler').print_state,'SENT_UNVERIFIED');
});
test('FIXTURE ONLY: physical sheets and unpaid debt retained separately',()=>{
 const c=item('partial_delivery_exception');
 assert.equal(c.delivered_sheets+c.undelivered_sheets,c.physical_sheets);
 assert.equal(c.receivable_vnd,70000);
});
test('FIXTURE ONLY: duplicate Zalo event has identical stable ID',()=>{
 assert.equal(f.incoming_events[0].event_id,f.incoming_events[1].event_id);
 assert.equal(f.incoming_events[0].text,f.incoming_events[1].text);
});
test('FIXTURE ONLY: quote >150 sheets, deposit shortage',()=>{
 const a=item('large_quote_unconfirmed'),b=item('deposit_short');
 assert.equal(a.physical_sheets,151);
 assert.notEqual(a.quote_revision,a.confirmed_quote_revision);
 assert.ok(b.paid_vnd<b.deposit_required_vnd);
});
const skip=!(process.env.AUTOIN_RUN_LEGACY_P0==='1'&&process.env.AUTOIN_ACCEPTANCE_ADAPTER)&&'PRODUCT NOT CONNECTED: NOT RUN';
const printer_id='RMP7000';
const claim=id=>({printer_id,idempotency_key:'synthetic-claim-'+id});
function noClaim(r){
 if(r?.ok===false){
  assert.ok(['PRINT_CLOSED','MANUAL_LOCK','NO_ELIGIBLE_JOB'].includes(r.error?.code),JSON.stringify(r));
 }else{
  assert.equal(r?.ok,true,JSON.stringify(r));assert.equal(r.job??null,null,'Unexpected eligible job');
 }
}
function hasClaim(r){
 assert.equal(r?.ok,true,JSON.stringify(r));
 assert.ok(r.job?.job_id&&r.job?.lease_token&&Number.isInteger(r.job?.revision),'No valid claim lease');
 return r.job;
}
const sendPayload=(job,key)=>({job_id:job.job_id,lease_token:job.lease_token,expected_revision:job.revision,idempotency_key:key});
async function withProduct(seed,fn){
 const mod=await import(pathToFileURL(resolve(process.env.AUTOIN_ACCEPTANCE_ADAPTER)).href);
 if(typeof mod.createAcceptanceAdapter!=='function')throw Error('Missing adapter factory');
 const a=await mod.createAcceptanceAdapter({baseUrl:process.env.AUTOIN_API_URL,
 databaseUrl:process.env.AUTOIN_TEST_DATABASE_URL,mode:'simulation',printer:'DryRunDriver'});
 assert.equal(a.environment?.type,'product-backed','Mock tests must not count as acceptance');
 assert.equal(a.environment?.database,'postgresql','Must use real PostgreSQL');
 assert.equal(a.environment?.print_driver,'DryRunDriver','No real printing allowed');
 for(const fn of ['reset','act','newAgent','snapshot','dispose'])assert.equal(typeof a[fn],'function');
 try{await a.reset(seed);await fn(a);}finally{await a.dispose();}
}
function deny(r){assert.equal(r?.ok,false,JSON.stringify(r));assert.ok(r.error?.code);}
function zero(s){assert.equal(s.driver_calls,0,'Unauthorized command reached DryRunDriver');}
function p0(name,fn){test('PRODUCT P0 '+name,{skip},()=>withProduct(name,fn));}
p0('unapproved_order',async a=>{
 noClaim(await a.act('claim',claim('unapproved'),{actor:'agent'}));zero(await a.snapshot());
});
p0('stale_revision',async a=>{
 deny(await a.act('approve',{order_id:'synthetic-o2',expected_revision:1,acknowledge_deposit_shortage:false,idempotency_key:'synthetic-stale'},{actor:'staff'}));zero(await a.snapshot());
});
p0('forged_actor',async a=>{
 deny(await a.act('approve',{order_id:'synthetic-o1',expected_revision:1,acknowledge_deposit_shortage:true,idempotency_key:'synthetic-forged',approved:true,role:'owner'},{actor:'anonymous'}));zero(await a.snapshot());
});
p0('approved_unsent',async a=>{
 const x=await a.newAgent('agent-1'),y=await a.newAgent('agent-2');
 assert.notEqual(x.connection_id,y.connection_id,'Separate PostgreSQL connections required');
 const r=await Promise.all([x.act('claim',claim('double-a')),
 y.act('claim',claim('double-b'))]);
 assert.ok(r.every(z=>z.ok===true),JSON.stringify(r));
 assert.equal(r.filter(z=>z.job?.job_id).length,1,'Two agents received a lease');
 assert.equal(r.filter(z=>z.job===null).length,1,'One agent must see an empty queue');
 zero(await a.snapshot());
});
p0('sending_revision_race',async a=>{
 const x=await a.newAgent('agent-1'),y=await a.newAgent('staff');
 assert.notEqual(x.connection_id,y.connection_id);
 const job=hasClaim(await x.act('claim',claim('race')));
 const r=await Promise.all([x.act('mark_sending',sendPayload(job,'synthetic-send-race')),
 y.act('revise',{order_id:'synthetic-o3',expected_revision:3,request_data:{copies:7,synthetic:true},idempotency_key:'synthetic-revise-race'})]);
 assert.equal(r.filter(z=>z?.ok).length,1,'Exactly one conflicting mutation must win');
 assert.ok((await a.snapshot()).driver_calls<=1);
});
p0('unknown_after_crash',async a=>{
 deny(await a.act('recover',{order_id:'synthetic-o4'},{actor:'agent'}));
 assert.equal((await a.snapshot()).print_state,'UNKNOWN');zero(await a.snapshot());
});
p0('spooler',async a=>{
 deny(await a.act('report_verified',{order_id:'synthetic-o10',evidence_kind:'spooler'},{actor:'agent'}));
 assert.notEqual((await a.snapshot()).print_state,'VERIFIED_DONE');
});
p0('manual_lock',async a=>{
 noClaim(await a.act('claim',claim('manual'),{actor:'agent'}));zero(await a.snapshot());
});
p0('holiday',async a=>{
 noClaim(await a.act('claim',claim('holiday'),{actor:'agent'}));zero(await a.snapshot());
});
p0('large_quote_unconfirmed',async a=>{
 deny(await a.act('approve',{order_id:'synthetic-o5',expected_revision:1,quote_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'synthetic-quote'},{actor:'staff'}));zero(await a.snapshot());
});
p0('deposit_short',async a=>{
 assert.equal((await a.act('approve',{order_id:'synthetic-o6',expected_revision:1,acknowledge_deposit_shortage:true,idempotency_key:'synthetic-deposit'},{actor:'staff'})).ok,true);
 assert.equal((await a.snapshot()).receivable_vnd,100000);
});
p0('partial_delivery_exception',async a=>{
 deny(await a.act('close_exception',{order_id:'synthetic-o7',expected_revision:1,reason:'synthetic uncollected',idempotency_key:'synthetic-staff-exception'},{actor:'staff'}));
 assert.equal((await a.act('close_exception',{order_id:'synthetic-o7',expected_revision:1,reason:'synthetic uncollected',idempotency_key:'synthetic-owner-exception'},{actor:'owner'})).ok,true);
 const s=await a.snapshot();assert.equal(s.receivable_vnd,70000);assert.equal(s.undelivered_sheets,28);
});
p0('duplicate_webhook',async a=>{
 await a.act('webhook',f.incoming_events[0],{actor:'verified-zalo'});
 await a.act('webhook',f.incoming_events[0],{actor:'verified-zalo'});
 assert.equal((await a.snapshot()).normalized_event_count,1);
});
p0('handover_race',async a=>{
 await a.act('ai_compose',{conversation_id:'conv-A'},{actor:'ai'});
 await a.act('handover',{conversation_id:'conv-A'},{actor:'staff'});
 deny(await a.act('ai_dispatch',{conversation_id:'conv-A'},{actor:'ai'}));
 assert.equal((await a.snapshot()).ai_messages_sent,0);
});
p0('unauthorized_preview',async a=>{
 deny(await a.act('get_preview',{order_id:'synthetic-o1'},{actor:'other-customer'}));
});
