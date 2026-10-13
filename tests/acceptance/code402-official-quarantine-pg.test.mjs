
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createOfficialZaloIngress} from '../../backend/integrations/zalo/official-webhook.ts';
import {PostgresInboundEventRepository} from '../../backend/integrations/zalo/postgres-events.ts';
import {createZaloTransactions} from '../../backend/integrations/zalo/transaction-runner.ts';
import {assertIsolatedSimulationDatabase} from '../../backend/composition/postgres.ts';
import {requireExactCode405Checkout} from './code405-exact-sha.mjs';

const url=process.env.AUTOIN_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const active=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1';
const gate={skip:!active?'NOT RUN: official OA controlled-contract requires --integration':
 !url?'NOT RUN: isolated PostgreSQL is required':false,timeout:60000};
const random=p=>p+'-'+randomUUID();
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
const signature=(raw,app,stamp,secret)=>({
 'x-zevent-signature':'mac='+createHash('sha256')
 .update(app).update(raw).update(String(stamp)).update(secret).digest('hex')
});

/** Independent AI5 acceptance: synthetic MAC is computed according to the
 * PUBLICLY DOCUMENTED scheme; it is NOT a captured provider signature.
 * Non-text event names/extra fields below are controlled-test envelopes,
 * NOT a claim about actual Zalo image/file/button JSON schema.
 */
async function withIngress(run) {
 assertIsolatedSimulationDatabase(url);
 requireExactCode405Checkout(process.env.AUTOIN_INTEGRATION_SHA);
 const poolA=new pg.Pool({connectionString:url,max:3});
 const poolB=new pg.Pool({connectionString:url,max:3});
 const app=random('app'),oa=random('oa'),user=random('user');
 const customer=random('customer'),chat=random('chat');
 const secret='synthetic-only-'+randomUUID()+randomUUID();
 const config={
  app_id:app,oa_id:oa,oa_secret_key:secret,
  resolve_verified_user:uid=>uid===user?{customer_id:customer,conversation_id:chat}:null
 };
 const inA=createOfficialZaloIngress(config,
  new PostgresInboundEventRepository(createZaloTransactions(poolA)));
 const inB=createOfficialZaloIngress(config,
  new PostgresInboundEventRepository(createZaloTransactions(poolB)));
 const row=async(sql,params=[])=>poolA.query(sql,params);
 try{
  const tables=await row("SELECT to_regclass('zalo_inbound_events') AS events,to_regclass('zalo_process_queue') AS queue");
  assert.ok(tables.rows[0]?.events&&tables.rows[0]?.queue,
   'AI0 must migrate durable inbound events/queue, not substitute in-memory mocks');
  const pids=await Promise.all([poolA.query('SELECT pg_backend_pid() pid'),poolB.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pids[0].rows[0].pid,pids[1].rows[0].pid,'two independent PostgreSQL pools required');
  const signed=(kind,more={})=>{
   const stamp=Date.now(),event=random('zalo-event');
   const payload={app_id:app,timestamp:stamp,event_name:kind,
    sender:{id:user},recipient:{id:oa},message:{msg_id:event,...more}};
   const raw=encode(payload);
   return {raw,headers:signature(raw,app,stamp,secret),event,payload};
  };
  await run({inA,inB,row,signed,oa,customer,chat});
 }finally{
  try{
   await row('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]);
   await row('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]);
  }finally{await Promise.all([poolA.end(),poolB.end()]);}
 }
}
async function saved(row,oa,event){
 const e=await row('SELECT payload_json,received_at FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[oa,event]);
 const q=await row('SELECT status FROM zalo_process_queue WHERE oa_id=$1 AND event_id=$2',[oa,event]);
 return {events:e.rows,markers:q.rows};
}

test('C402-OA-01 documented-MAC signed TEXT: 2-pool durable dedupe is COMPONENT only (not runtime wiring)',gate,async()=>{
 await withIngress(async({inA,inB,row,signed,oa,customer,chat})=>{
  const w=signed('user_send_text',{text:'In A4 2 bản'});
  const [a,b]=await Promise.all([
   inA.receive(w.raw,w.headers),inB.receive(w.raw,w.headers)
  ]);
  assert.deepEqual([a.status,b.status].sort(),['accepted','duplicate']);
  const got=await saved(row,oa,w.event);
  assert.equal(got.events.length,1);
  assert.equal(got.markers.length,1);
  assert.equal(got.events[0].payload_json.kind,'text');
  assert.equal(got.events[0].payload_json.customer_id,customer);
  assert.equal(got.events[0].payload_json.conversation_id,chat);
  assert.equal(got.events[0].payload_json.confirmation_postback,undefined);
  assert.ok(got.events[0].received_at);
  assert.equal(got.markers[0].status,'QUEUED');
  await assert.rejects(inB.receive(w.raw,{'x-zevent-signature':'mac='+'0'.repeat(64)}),
   /WEBHOOK_SIGNATURE_REJECTED/);
  assert.equal((await saved(row,oa,w.event)).events.length,1);
 });
});

for(const [code,kind,details] of [
 ['02','user_send_image',{attachments:[{type:'image',url:'untrusted:do-not-download'}]}],
 ['03','user_send_file',{attachments:[{type:'file',url:'untrusted:do-not-download'}]}],
 ['04','user_click_button',{payload:'not-a-challenge',text:'OK'}]
]){
 test('C402-OA-'+code+' REQUIRED signed '+kind+' must enter durable PENDING quarantine, never be discarded',gate,async()=>{
  await withIngress(async({inA,inB,row,signed,oa,customer,chat})=>{
   const w=signed(kind,details);
   // This is an intentionally REQUIRED new V1 gate. A signed but not yet
   // understood provider event must be retained for human/provider review
   // instead of being ACKed and lost or treated as customer acceptance.
   // The source contract is a controlled envelope, NOT real Zalo schema.
   const accepted=await inA.receive(w.raw,w.headers);
   assert.equal(accepted.status,'accepted','signed unsupported events must be held durably');
   const got=await saved(row,oa,w.event);
   assert.equal(got.events.length,1,'signed unknown event MUST survive in PostgreSQL');
   assert.equal(got.markers.length,1,'review item MUST have durable processing marker');
   assert.ok(got.events[0].received_at,'trusted server receipt timestamp is required');
   assert.equal(got.events[0].payload_json.oa_id,oa,'cannot lose trusted OA scope');
   assert.equal(got.events[0].payload_json.customer_id,customer,'trusted customer binding');
   assert.equal(got.events[0].payload_json.conversation_id,chat,'trusted chat binding');
   assert.equal(got.events[0].payload_json.kind,'unsupported','cannot classify unsupported as accepted file/postback');
   assert.equal(got.events[0].payload_json.confirmation_postback,undefined,
    'unsupported button/text must NEVER authenticate CODE-401');
   assert.equal(got.markers[0].status,'QUEUED','must remain pending and retrievable for human review');
   const replay=await inB.receive(w.raw,w.headers);
   assert.equal(replay.status,'duplicate','two-worker retry cannot duplicate quarantine');
   assert.equal((await saved(row,oa,w.event)).events.length,1);
  });
 });
}
