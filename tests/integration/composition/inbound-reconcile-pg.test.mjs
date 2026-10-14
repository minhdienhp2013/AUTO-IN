import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {ingestSyntheticArtifact} from '../../../backend/composition/synthetic-ingest.ts';
import {createSyntheticInboundDraft} from '../../../backend/composition/inbound-draft.ts';
import {reconcileSyntheticInboundDraft} from '../../../backend/composition/inbound-reconcile.ts';

const url=process.env.TEST_DATABASE_URL;
test('REAL PostgreSQL: owner reconciles AI1 committed draft after lost ACK; never inserts another order',{
  skip:!url?'TEST_DATABASE_URL missing: owner draft reconciliation NOT VERIFIED':false,
  timeout:120000
},async()=>{
 assertIsolatedSimulationDatabase(url);
 const root=await mkdtemp(join(tmpdir(),'autoin-reconcile-'));
 const incoming=join(root,'incoming'),pool=new pg.Pool({connectionString:url});
 let app;
 try {
  await mkdir(incoming,{mode:0o700});
  const fixture=join(root,'fixture.png');
  const generator=spawnSync(process.env.AUTOIN_PYTHON??'python3',
    ['-c','from PIL import Image;import sys;Image.new("RGB",(60,60),"white").save(sys.argv[1])',fixture],
    {timeout:10000});
  assert.equal(generator.status,0,'Python image fixture generator available');
  const file=await readFile(fixture);
  const shop='autoin-test-recon-'+randomUUID(),oa='synthetic-'+randomUUID();
  const scope={shop_id:shop,oa_id:oa};
  const core=createCoreModule({pool:asSqlPool(pool)});
  await pool.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  const password='safe-synthetic-'+randomUUID();
  await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
  const login=await core.auth.login(shop,'owner',password);
  const owner=login.principal;
  app=buildIntegratedApp({pool:asSqlPool(pool),
    syntheticArtifactIngest:{artifactRoot:incoming,scope}});
  await app.ready();
  const fresh=async()=>{
    const event='evt-'+randomUUID();
    const payload={event_id:event,kind:'image',oa_id:oa,filename:'fixture.png',
      customer_id:'synthetic-user',conversation_id:'synthetic-conversation',
      occurred_at:new Date().toISOString()};
    await pool.query('INSERT INTO zalo_inbound_events (oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) '+
      'VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [oa,event,payload.conversation_id,payload.customer_id,payload.occurred_at,JSON.stringify(payload)]);
    await ingestSyntheticArtifact(asSqlPool(pool),incoming,scope,owner,{
      event_id:event,filename:'fixture.png',content_base64:file.toString('base64')});
    return event;
  };
  const settings=event_id=>({event_id,paper:'A4',copies:1,duplex:false});
  const route=event=>'/internal/simulation/inbound-artifacts/'+event+'/reconcile';
  const call=async(event,body={paper:'A4',copies:1,duplex:false},token=login.token)=>
    app.inject({method:'POST',url:route(event),payload:body,
      headers:token?{authorization:'Bearer '+token}:{}});
  const countOrders=async()=>Number((await pool.query(
    'SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n);
  const event=await fresh();
  let actualOrderId;
  await assert.rejects(createSyntheticInboundDraft(asSqlPool(pool),{
    async createDraft(...args){
      const receipt=await core.service.createDraft(...args);
      actualOrderId=receipt.order_id;
      throw new Error('LOST_RESPONSE_AFTER_AI1_COMMIT');
    }
  },incoming,scope,owner,settings(event)),/LOST_RESPONSE_AFTER_AI1_COMMIT/);
  assert.equal(await countOrders(),1);
  assert.equal((await pool.query('SELECT status FROM ai0_inbound_artifact_drafts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
    [shop,oa,event])).rows[0].status,'PENDING');
  assert.equal((await call(event,undefined,null)).statusCode,401);
  const staff={...owner,role:'staff'};
  await assert.rejects(reconcileSyntheticInboundDraft(asSqlPool(pool),incoming,scope,staff,settings(event)),
    {code:'OWNER_REQUIRED'});
  assert.equal((await call(event,{paper:'A4',copies:3,duplex:false})).statusCode,409);
  assert.equal((await pool.query('SELECT status FROM ai0_inbound_artifact_drafts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
    [shop,oa,event])).rows[0].status,'PENDING');
  const first=await call(event);
  assert.equal(first.statusCode,200,JSON.stringify(first.json()));
  assert.deepEqual(first.json(),{
    status:'recovered',order_id:actualOrderId,revision:1,
    requires_customer_confirmation:true,preview_trusted:false,created_new_order:false
  });
  assert.equal((await call(event)).json().status,'existing');
  assert.equal(await countOrders(),1,'Reconciliation MUST NOT mint an order');
  const receipt=(await pool.query(
    'SELECT status,order_id FROM ai0_inbound_artifact_drafts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
    [shop,oa,event])).rows[0];
  assert.equal(receipt.status,'CREATED');assert.equal(receipt.order_id,actualOrderId);
  const audit=(await pool.query(
    "SELECT actor_id,details FROM core_audit WHERE shop_id=$1 AND order_id=$2 AND action='ai0.synthetic_draft.reconciled'",
    [shop,actualOrderId])).rows;
  assert.equal(audit.length,1,'Owner recovery must have exactly one durable audit row');
  assert.equal(audit[0].actor_id,owner.id);
  assert.equal(audit[0].details.event_id,event);
  assert.equal(audit[0].details.created_new_order,false);
  const noAI1=await fresh();
  await assert.rejects(createSyntheticInboundDraft(asSqlPool(pool),{
    async createDraft(){throw new Error('AI1_NOT_COMMITTED');}
  },incoming,scope,owner,settings(noAI1)),/AI1_NOT_COMMITTED/);
  const missing=await call(noAI1);
  assert.equal(missing.statusCode,409);
  assert.equal(missing.json().error.code,'DRAFT_EVIDENCE_NOT_COMMITTED');
  assert.equal(await countOrders(),1);
  const row=(await pool.query(
    'SELECT status,order_id FROM ai0_inbound_artifact_drafts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
    [shop,oa,noAI1])).rows[0];
  assert.equal(row.status,'PENDING');assert.equal(row.order_id,null);
  // Independent pair of owner recovery requests must serialize on reservation.
  const concurrent=await fresh();
  let concurrentId;
  await assert.rejects(createSyntheticInboundDraft(asSqlPool(pool),{
    async createDraft(...args){
      const record=await core.service.createDraft(...args);
      concurrentId=record.order_id;
      throw new Error('LOST_ACK_CONCURRENT');
    }
  },incoming,scope,owner,settings(concurrent)),/LOST_ACK_CONCURRENT/);
  const pair=await Promise.all([call(concurrent),call(concurrent)]);
  assert.deepEqual(pair.map(x=>x.statusCode),[200,200]);
  assert.deepEqual(pair.map(x=>x.json().status).sort(),['existing','recovered']);
  assert.ok(pair.every(x=>x.json().order_id===concurrentId));
  assert.equal(await countOrders(),2,'Concurrent recovery must never make an extra order');
 } finally {
  if(app)await app.close();
  await pool.end();await rm(root,{recursive:true,force:true});
 }
});
