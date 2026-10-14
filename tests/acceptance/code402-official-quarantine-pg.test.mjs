import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../backend/composition/postgres.ts';
import {createOfficialZaloWebhookPlugin} from '../../backend/composition/official-zalo-webhook.ts';
import {buildIntegratedApp} from '../../backend/composition/runtime.ts';
import {createCoreModule} from '../../backend/core/factory.ts';
import {requireExactCode405Checkout} from './code405-exact-sha.mjs';

const url=process.env.AUTOIN_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const active=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1';
const gate={skip:!active?'NOT RUN: AI5 real composition quarantine requires --integration':
 !url?'NOT RUN: isolated PostgreSQL with official migrations is required':false,timeout:120000};
const unique=prefix=>prefix+'-'+randomUUID();
const mac=(raw,app,stamp,secret)=>'mac='+createHash('sha256')
 .update(app,'utf8').update(raw).update(String(stamp),'utf8')
 .update(secret,'utf8').digest('hex');

/**
 * CODE-402 independent, real AI0 composition acceptance:
 * Fastify RAW BODY -> server-owned OA/identity registry -> AI2
 * createOfficialZaloVerifiedIngress -> PostgreSQL quarantine table.
 *
 * The HMAC secret, example event names and payloads are SYNTHETIC only.
 * They are NOT captured Zalo OA webhook vectors or verified official
 * image/file/button schemas. Production OA route MUST remain disabled.
 * No customer confirmation, staff approval, print or outbound effect.
 */
async function withComposition(run){
 assertIsolatedSimulationDatabase(url);
 requireExactCode405Checkout(process.env.AUTOIN_INTEGRATION_SHA);
 const a=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:5000});
 const b=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5000});
 const shop=unique('autoin-test-ai5-official-shop'),oa=unique('oa');
 const appId=unique('app'),user=unique('provider-user');
 const customer=unique('customer'),conversation=unique('chat');
 const secret='synthetic-only-'+randomUUID()+randomUUID();
 let appA,appB,unconfigured,configured=false;
 try{
  const required=await a.query("SELECT to_regclass('zalo_official_quarantine') quarantine, "+
   "to_regclass('zalo_official_quarantine_scopes') scopes, "+
   "to_regclass('ai0_official_zalo_oa_registry') registry, "+
   "to_regclass('ai0_official_zalo_identity_map') mappings");
  for(const [name,table] of Object.entries(required.rows[0]))
   assert.ok(table,'AI0/AI2 real migration missing: '+name);
  const pids=await Promise.all([
   a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')
  ]);
  assert.notEqual(pids[0].rows[0].pid,pids[1].rows[0].pid,
   'two independent real PostgreSQL pools are mandatory');

  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  configured=true;
  const core=createCoreModule({pool:asSqlPool(a)});
  await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
   password:'test-only-'+randomUUID(),bootstrap_enabled:true});
  const owner=await a.query("SELECT id FROM core_users WHERE shop_id=$1 AND username='owner'",[shop]);
  assert.equal(owner.rowCount,1);
  await a.query("INSERT INTO ai0_official_zalo_oa_registry(oa_id,app_id,shop_id,enabled) "+
   "VALUES($1,$2,$3,true)",[oa,appId,shop]);
  await a.query("INSERT INTO ai0_official_zalo_identity_map "+
   "(oa_id,shop_id,provider_user_id,customer_id,conversation_id,verified_by) "+
   "VALUES($1,$2,$3,$4,$5,$6)",
   [oa,shop,user,customer,conversation,owner.rows[0].id]);

  appA=buildIntegratedApp({pool:asSqlPool(a),zaloWebhook:
   await createOfficialZaloWebhookPlugin(asSqlPool(a),{
    app_id:appId,oa_id:oa,oa_secret_key:secret
   })});
  appB=buildIntegratedApp({pool:asSqlPool(b),zaloWebhook:
   await createOfficialZaloWebhookPlugin(asSqlPool(b),{
    app_id:appId,oa_id:oa,oa_secret_key:secret
   })});
  await Promise.all([appA.ready(),appB.ready()]);
  const fixture=(kind,more={},provider=user)=>{
   const timestamp=Date.now(),event=unique('msg');
   const payload={app_id:appId,timestamp,event_name:kind,
    sender:{id:provider},recipient:{id:oa},
    message:{msg_id:event,...more}};
   const raw=Buffer.from(JSON.stringify(payload),'utf8');
   return {raw,payload,event,headers:{
    'content-type':'application/json',
    'x-zevent-signature':mac(raw,appId,timestamp,secret)
   }};
  };
  const send=(app,w,headers=w.headers)=>app.inject({
   method:'POST',url:'/webhooks/zalo',headers,payload:w.raw
  });
  const sql=(statement,params=[])=>a.query(statement,params);
  const count=async(table,where,params)=>{
   const res=await sql('SELECT count(*)::int n FROM '+table+' WHERE '+where,params);
   return res.rows[0].n;
  };
  const noCoreEffects=async reason=>{
   assert.equal(await count('core_orders','shop_id=$1',[shop]),0,
    reason+': signed OA input cannot create AI1 order');
   assert.equal(await count('zalo_confirmation_candidates','oa_id=$1',[oa]),0,
    reason+': signed image/file/click cannot become CODE402 consent candidate');
   for(const table of ['core_confirmations','core_approvals','core_print_jobs']){
    assert.equal(await count(table,
     'order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]),0,
     reason+': no '+table);
   }
   assert.equal(await count('zalo_outbound','oa_id=$1',[oa]),0,
    reason+': no automatic outgoing OA message');
  };
  await run({a,b,appA,appB,oa,shop,customer,conversation,user,appId,secret,
   fixture,send,sql,count,noCoreEffects});
 }finally{
  for(const app of [appA,appB,unconfigured])if(app)await app.close();
  if(configured){
   // Clean each synthetic shop/OA only. NEVER TRUNCATE shared CI database.
   await a.query('DELETE FROM ai0_official_quarantine_reviews WHERE shop_id=$1',[shop]);
   await a.query('DELETE FROM zalo_official_quarantine WHERE oa_id=$1',[oa]);
   await a.query('DELETE FROM zalo_official_quarantine_scopes WHERE oa_id=$1',[oa]);
   await a.query('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]);
   await a.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]);
   await a.query('DELETE FROM ai0_official_zalo_identity_map WHERE oa_id=$1',[oa]);
   await a.query('DELETE FROM ai0_official_zalo_oa_registry WHERE oa_id=$1',[oa]);
   await a.query('DELETE FROM core_audit WHERE shop_id=$1',[shop]);
   await a.query('DELETE FROM core_idempotency WHERE shop_id=$1',[shop]);
   await a.query('DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',[shop]);
   await a.query('DELETE FROM core_users WHERE shop_id=$1',[shop]);
   await a.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]);
  }
  await Promise.all([a.end(),b.end()]);
 }
}
const quarantine=async(sql,oa)=> (await sql(
 'SELECT id,oa_id,raw_sha256,kind,status,customer_id,conversation_id,'+
 'provider_claimed_event_id,received_at,reviewed_at FROM zalo_official_quarantine '+
 'WHERE oa_id=$1 ORDER BY received_at,id',[oa])).rows;

test('C402-OA-01 AI0 Fastify: signed mapped TEXT durable queue; text OK cannot mint CODE401 confirmation',gate,async()=>{
 await withComposition(async({appA,appB,fixture,send,sql,count,oa,customer,conversation,noCoreEffects})=>{
  const w=fixture('user_send_text',{text:'OK',confirmation_postback:{
   kind:'verified_confirmation_accept',challenge_token:'self-declared'
  }});
  const [r1,r2]=await Promise.all([send(appA,w),send(appB,w)]);
  assert.deepEqual([r1.statusCode,r2.statusCode],[200,200]);
  assert.deepEqual([r1.json().status,r2.json().status].sort(),['accepted','duplicate']);
  const e=await sql('SELECT payload_json,received_at FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[oa,w.event]);
  const q=await sql('SELECT status FROM zalo_process_queue WHERE oa_id=$1 AND event_id=$2',[oa,w.event]);
  assert.equal(e.rowCount,1);assert.equal(q.rowCount,1);
  assert.equal(e.rows[0].payload_json.kind,'text');
  assert.equal(e.rows[0].payload_json.customer_id,customer);
  assert.equal(e.rows[0].payload_json.conversation_id,conversation);
  assert.equal(e.rows[0].payload_json.confirmation_postback,undefined);
  assert.equal(q.rows[0].status,'QUEUED');
  assert.ok(e.rows[0].received_at instanceof Date);
  assert.equal((await quarantine(sql,oa)).length,0,'mapped text must NOT be quarantined');
  const bad=await send(appA,w,{
   ...w.headers,'x-zevent-signature':'mac='+'0'.repeat(64)
  });
  assert.equal(bad.statusCode,403);
  assert.equal(await count('zalo_inbound_events','oa_id=$1',[oa]),1);
  await noCoreEffects('signed text only');
 });
});

for(const [code,kind,expected,details] of [
 ['02','user_send_image','image',{attachments:[{type:'image',url:'untrusted:not-downloaded'}]}],
 ['03','user_send_file','file',{attachments:[{type:'file',url:'untrusted:not-downloaded'}]}],
 ['04','user_click_button','click',{payload:'NOT_A_VERIFIED_CHALLENGE',text:'OK'}]
]){
 test('C402-OA-'+code+' signed '+kind+' survives AI0 composition as NEEDS_HUMAN (two pools, replay, no effects)',gate,async()=>{
  await withComposition(async({appA,appB,fixture,send,sql,count,oa,customer,conversation,noCoreEffects})=>{
   const w=fixture(kind,details);
   // First receipt and lost-ACK replay can race across two real connections;
   // exactly ONE immutable custody row is allowed.
   const [one,two]=await Promise.all([send(appA,w),send(appB,w)]);
   assert.equal(one.statusCode,200,one.body);
   assert.equal(two.statusCode,200,two.body);
   assert.deepEqual([one.json().status,two.json().status].sort(),['duplicate','held']);
   assert.equal(one.json().receipt_id,two.json().receipt_id);
   const rows=await quarantine(sql,oa);
   assert.equal(rows.length,1,'signed unsupported provider event MUST NOT vanish');
   const row=rows[0];
   assert.equal(row.id,one.json().receipt_id);
   assert.equal(row.oa_id,oa);
   assert.equal(row.kind,expected);
   assert.equal(row.status,'NEEDS_HUMAN','unreviewed event MUST block approval');
   assert.equal(row.customer_id,customer,'server-verified customer mapping only');
   assert.equal(row.conversation_id,conversation,'server-verified chat mapping only');
   assert.equal(row.provider_claimed_event_id,w.event);
   assert.equal(row.raw_sha256,createHash('sha256').update(w.raw).digest('hex'));
   assert.ok(row.received_at instanceof Date,'receipt time MUST come from PostgreSQL');
   assert.equal(row.reviewed_at,null);
   const noEvent=await count('zalo_inbound_events','oa_id=$1',[oa]);
   const noQueue=await count('zalo_process_queue','oa_id=$1',[oa]);
   assert.equal(noEvent,0,'unsupported event MUST NOT impersonate mapped text');
   assert.equal(noQueue,0,'quarantine must not enqueue unknown event for AI2 text worker');
   await noCoreEffects(kind);
   const replay=await send(appA,w);
   assert.equal(replay.statusCode,200);
   assert.equal(replay.json().status,'duplicate');
   assert.equal(replay.json().receipt_id,row.id);
   assert.equal((await quarantine(sql,oa))[0].received_at.getTime(),row.received_at.getTime(),
    'lost ACK replay must preserve original PostgreSQL receipt time');
   const wrongMac=await send(appA,w,{
    ...w.headers,'x-zevent-signature':'mac='+'0'.repeat(64)
   });
   assert.equal(wrongMac.statusCode,403);
   assert.equal((await quarantine(sql,oa)).length,1);
   // Re-sign a differently scoped OA: the valid MAC must NEVER authorize
   // storage under the configured server scope.
   const otherPayload={...w.payload,recipient:{id:'foreign-'+oa}};
   const raw=Buffer.from(JSON.stringify(otherPayload),'utf8');
   const foreign=await send(appA,{
    raw,headers:{'content-type':'application/json',
     'x-zevent-signature':mac(raw,w.payload.app_id,w.payload.timestamp,
       'unused')},payload:otherPayload
   }).catch(()=>null);
   // A wrong/unknown secret may only cause 403, not a quarantine write.
   assert.ok(foreign===null||foreign.statusCode===403||foreign.statusCode===422);
   assert.equal((await quarantine(sql,oa)).length,1);
   await noCoreEffects(kind+' after negative input');
  });
 });
}

test('C402-OA-05 signed TEXT without server identity mapping remains OA-only NEEDS_HUMAN, no body or candidate',gate,async()=>{
 await withComposition(async({appA,appB,fixture,send,sql,oa,count,noCoreEffects})=>{
  const w=fixture('user_send_text',{text:'OK'},
   unique('unverified-provider-user'));
  const first=await send(appA,w),replayed=await send(appB,w);
  assert.equal(first.statusCode,200,first.body);
  assert.equal(first.json().status,'held');
  assert.equal(replayed.json().status,'duplicate');
  const rows=await quarantine(sql,oa);
  assert.equal(rows.length,1);
  assert.equal(rows[0].kind,'unknown');
  assert.equal(rows[0].status,'NEEDS_HUMAN');
  assert.equal(rows[0].customer_id,null,'NO guessed customer');
  assert.equal(rows[0].conversation_id,null,'NO guessed chat');
  assert.equal(rows[0].provider_claimed_event_id,w.event);
  assert.equal(await count('zalo_inbound_events','oa_id=$1',[oa]),0,
   'unmapped text body never persists in regular queue');
  assert.equal(await count('zalo_process_queue','oa_id=$1',[oa]),0);
  await noCoreEffects('unmapped signed text');
 });
});
