import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../backend/composition/postgres.ts';
import {buildIntegratedApp} from '../../backend/composition/runtime.ts';
import {createCoreModule} from '../../backend/core/factory.ts';

const url=process.env.TEST_DATABASE_URL;
const id=prefix=>prefix+'-'+randomUUID().replaceAll('-','');
const one=async(pool,query,args=[])=>(await pool.query(query,args)).rows[0];
async function count(pool,table,col,value){
  const allowed=new Set(['zalo_inbound_events','zalo_process_queue',
    'zalo_official_quarantine','core_ai_draft_proposals','core_approvals','core_print_jobs']);
  if(!allowed.has(table)||!['oa_id','order_id'].includes(col))throw Error('UNSAFE_COUNT');
  return (await one(pool,'SELECT count(*)::int AS n FROM '+table+' WHERE '+col+'=$1',[value])).n;
}
function signed(scope,kind,eventId,sender=scope.sender){
  const timestamp=Date.now();
  const event={app_id:scope.appId,timestamp,event_name:kind,
    sender:{id:sender},recipient:{id:scope.oa},message:{msg_id:eventId}};
  if(kind==='user_send_text')event.message.text='Synthetic A4 print request';
  const raw=Buffer.from(JSON.stringify(event),'utf8');
  const signature='mac='+createHash('sha256').update(scope.appId,'utf8')
    .update(raw).update(String(timestamp),'utf8').update(scope.secret,'utf8').digest('hex');
  return {raw,signature};
}
async function setup(){
  assert.ok(url,'TEST_DATABASE_URL REQUIRED — no SKIP allowed for acceptance');
  assert.equal(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE,'YES_ISOLATED_TEST_DB');
  assertIsolatedSimulationDatabase(url);
  const a=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:5000});
  const b=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:5000});
  const scope={shop:id('autoin-test-ai5shop'),oa:id('oa'),appId:id('app'),
    secret:'synthetic-key-'+randomUUID()+'-'+randomUUID(),
    sender:id('mapped-user'),unmapped:id('unmapped-user'),
    customer:id('customer'),conversation:id('conversation'),password:id('fixture-password')};
  let app,disabled,bootstrapped=false;
  const core=createCoreModule({pool:asSqlPool(a)});
  const coreB=createCoreModule({pool:asSqlPool(b)});
  try{
    const pa=(await one(a,'SELECT pg_backend_pid() AS pid')).pid;
    const pb=(await one(b,'SELECT pg_backend_pid() AS pid')).pid;
    assert.notEqual(pa,pb,'two independent PostgreSQL pools required');
    await core.auth.bootstrapOwner({shop_id:scope.shop,username:'owner',
      password:scope.password,bootstrap_enabled:true});
    bootstrapped=true;
    const user=await one(a,"SELECT id FROM core_users WHERE shop_id=$1 AND username='owner'",[scope.shop]);
    scope.owner={id:user.id,shop_id:scope.shop,role:'owner',verified:true};
    const webhook={app_id:scope.appId,oa_id:scope.oa,oa_secret_key:scope.secret,
      resolve_verified_user(sender){
        return sender===scope.sender?
          {customer_id:scope.customer,conversation_id:scope.conversation}:null;
      }};
    disabled=buildIntegratedApp({pool:asSqlPool(a)});
    await disabled.ready();
    app=buildIntegratedApp({pool:asSqlPool(a),
      officialZaloSimulation:{shop_id:scope.shop,webhook}});
    await app.ready();
    scope.send=async(fixture,signature=fixture.signature)=>app.inject({
      method:'POST',url:'/webhooks/zalo',
      headers:{'content-type':'application/json','x-zevent-signature':signature},
      payload:fixture.raw
    });
    scope.a=a;scope.b=b;scope.core=core;scope.coreB=coreB;
    scope.app=app;scope.disabled=disabled;
    scope.bootstrapped=true;
    return scope;
  }catch(err){
    if(app)await app.close();
    if(disabled)await disabled.close();
    if(bootstrapped)await cleanupRows(a,scope);
    await Promise.all([a.end(),b.end()]);
    throw err;
  }
}
async function cleanupRows(a,s){
  const oa=s.oa,shop=s.shop;
  // Test-only unique shop/OA; never touch non-owned data.
  for(const q of [
    'DELETE FROM zalo_outbound WHERE shop_id=$1',
    'DELETE FROM zalo_batch_items WHERE oa_id=$1',
    'DELETE FROM zalo_batches WHERE oa_id=$1',
    'DELETE FROM zalo_process_queue WHERE oa_id=$1',
    'DELETE FROM zalo_inbound_events WHERE oa_id=$1',
    'DELETE FROM zalo_official_quarantine WHERE oa_id=$1',
    'DELETE FROM zalo_official_quarantine_scopes WHERE oa_id=$1',
    'DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=$1',
    'DELETE FROM core_print_jobs WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM core_approvals WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM core_confirmations WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',
    'DELETE FROM core_audit WHERE shop_id=$1',
    'DELETE FROM core_idempotency WHERE shop_id=$1',
    'DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM core_orders WHERE shop_id=$1',
    'DELETE FROM core_conversation_controls WHERE shop_id=$1',
    'DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',
    'DELETE FROM core_users WHERE shop_id=$1',
    'DELETE FROM core_shop_settings WHERE shop_id=$1'
  ]){
    await a.query(q,[q.includes('WHERE oa_id=$1') ? oa : shop]);
  }
}
async function teardown(s){
  await s.app.close();await s.disabled.close();
  try{await cleanupRows(s.a,s)}finally{await Promise.all([s.a.end(),s.b.end()])}
}
async function register(s,appId=s.appId){
  await s.a.query('INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3) ON CONFLICT (shop_id,oa_id) DO UPDATE SET app_id=EXCLUDED.app_id',
    [s.shop,s.oa,appId]);
}
async function manualReady(s){
  const draft=await s.core.service.createDraft(s.owner,{
    customer_id:s.customer,conversation_id:s.conversation,
    request_data:{documents:[{name:'fixture.txt',copies:1,format:'A4'}]},
    idempotency_key:id('staff-manual')
  });
  const order=draft.order_id,hash=draft.request_hash;
  assert.ok(order&&hash);
  assert.equal(await count(s.a,'core_ai_draft_proposals','order_id',order),0,
    'manual order must NOT be associated with an AI proposal');
  const row=await one(s.a,'SELECT shop_id,customer_id,conversation_id FROM core_orders WHERE id=$1',[order]);
  assert.equal(row.shop_id,s.shop);assert.equal(row.customer_id,s.customer);
  assert.equal(row.conversation_id,s.conversation);
  await s.core.service.publishVerifiedPlan({
    id:'fixture-processor',shop_id:s.shop,role:'processor',verified:true
  },order,{expected_revision:1,plan:{
      ready:true,request_hash:hash,verified_by:'synthetic-test-only',
      artifact_ref:'synthetic/no-real-document',printer_id:'NO_REAL_PRINTER',
      document_pages:1,printed_faces:1,physical_sheets:1
    },idempotency_key:id('verified-plan')});
  await s.core.service.confirm({id:'fixture-customer',shop_id:s.shop,
    role:'customer',verified:true,customer_id:s.customer},order,{
      expected_revision:2,kind:'request',idempotency_key:id('customer-confirm')
    });
  const {token}=await s.core.auth.login(s.shop,'owner',s.password);
  return {order,token};
}
async function httpApproval(s,order,token){
  return s.app.inject({method:'POST',
    url:'/api/v1/orders/'+order+'/approvals',
    headers:{authorization:'Bearer '+token},
    payload:{expected_revision:2,acknowledge_deposit_shortage:false,
      idempotency_key:id('staff-approval')}
  });
}
const coreApproval=(s,order)=>s.coreB.service.approve(s.owner,order,{
  expected_revision:2,acknowledge_deposit_shortage:false,
  idempotency_key:id('concurrent-owner-approve')
}).then(value=>({result:'resolved',value}),err=>({
  result:'rejected',code:err.code,status:err.status,message:err.message
}));
const unsignedStats=async(s,order)=>({
  approvals:await count(s.b,'core_approvals','order_id',order),
  print_jobs:await count(s.b,'core_print_jobs','order_id',order)
});

test('AI5 PR88 HTTP binding default 503/missing registry 503 zero receipt; signed text durable/replay, unsupported image/file/click quarantine, 403 zero writes', {timeout:120000},async()=>{
  const s=await setup();
  try{
    const text=signed(s,'user_send_text',id('text'));
    const off=await s.disabled.inject({method:'POST',url:'/webhooks/zalo',
      headers:{'content-type':'application/json'},payload:'{}'});
    assert.equal(off.statusCode,503);assert.equal(off.json().error.code,'FEATURE_UNAVAILABLE');
    const missing=await s.send(text);
    assert.equal(missing.statusCode,503);assert.equal(missing.json().error.code,'OFFICIAL_ZALO_SCOPE_NOT_REGISTERED');
    assert.equal(await count(s.b,'zalo_inbound_events','oa_id',s.oa),0);
    assert.equal(await count(s.b,'zalo_official_quarantine','oa_id',s.oa),0);
    await register(s,id('wrong-app'));
    assert.equal((await s.send(text)).statusCode,503,'wrong app registry must be unavailable');
    await register(s);
    const [first,second]=await Promise.all([s.send(text),s.send(text)]);
    assert.deepEqual([first.statusCode,second.statusCode],[200,200]);
    assert.equal(await count(s.b,'zalo_inbound_events','oa_id',s.oa),1);
    assert.equal(await count(s.b,'zalo_process_queue','oa_id',s.oa),1);
    for(const [eventName,kind] of [
      ['user_send_image','image'],['user_send_file','file'],['user_click','click']
    ]){
      const e=signed(s,eventName,id(kind));
      const [a,b]=await Promise.all([s.send(e),s.send(e)]);
      assert.equal(a.statusCode,200);assert.equal(b.statusCode,200);
      const row=await one(s.b,
        "SELECT count(*)::int AS n FROM zalo_official_quarantine WHERE oa_id=$1 AND kind=$2 AND status='NEEDS_HUMAN' AND customer_id=$3 AND conversation_id=$4",
        [s.oa,kind,s.customer,s.conversation]);
      assert.equal(row.n,1,kind+' must be durable and replay-idempotent');
    }
    assert.equal(await count(s.b,'zalo_official_quarantine','oa_id',s.oa),3);
    const unbound=signed(s,'user_send_image',id('oa-unbound'),s.unmapped);
    assert.equal((await s.send(unbound)).statusCode,200);
    const oaLevel=await one(s.b,
      "SELECT customer_id,conversation_id,status FROM zalo_official_quarantine WHERE oa_id=$1 AND raw_sha256=$2",
      [s.oa,createHash('sha256').update(unbound.raw).digest('hex')]);
    assert.equal(oaLevel.customer_id,null);assert.equal(oaLevel.conversation_id,null);
    assert.equal(oaLevel.status,'NEEDS_HUMAN');
    const countBefore=await count(s.b,'zalo_official_quarantine','oa_id',s.oa);
    const bad=await s.send(signed(s,'user_send_image',id('bad-signature')),'mac='+'0'.repeat(64));
    assert.equal(bad.statusCode,403);
    assert.equal(await count(s.b,'zalo_official_quarantine','oa_id',s.oa),countBefore);
    assert.equal(await count(s.b,'zalo_inbound_events','oa_id',s.oa),1);
  }finally{await teardown(s)}
});

for(const mapped of [true,false]){
  test('AI5 PR88 manual SAME customer/conversation + '+(mapped?'mapped':'OA-level unmapped')+
    ' pending signed receipt => HTTP409 and 0 approvals/print (INGRESS-FIRST, two pools, replay/lost ACK)',{
    timeout:120000
  },async()=>{
    const s=await setup();
    try{
      await register(s);
      const {order,token}=await manualReady(s);
      const fixture=signed(s,mapped?'user_send_image':'user_send_file',
        id('pending'),mapped?s.sender:s.unmapped);
      const [received,replayed]=await Promise.all([s.send(fixture),s.send(fixture)]);
      assert.equal(received.statusCode,200);assert.equal(replayed.statusCode,200);
      assert.equal(await count(s.b,'zalo_official_quarantine','oa_id',s.oa),1);
      const receipt=await one(s.b,
        'SELECT customer_id,conversation_id,status FROM zalo_official_quarantine WHERE oa_id=$1',
        [s.oa]);
      assert.equal(receipt.status,'NEEDS_HUMAN');
      assert.equal(receipt.customer_id,mapped?s.customer:null);
      assert.equal(receipt.conversation_id,mapped?s.conversation:null);
      // Both independent pools attempt to approve the MANUAL order. Missing
      // proposal MUST NOT bypass registry's authoritative shop/OA binding.
      const [http,direct]=await Promise.all([
        httpApproval(s,order,token),coreApproval(s,order)
      ]);
      const actual=await unsignedStats(s,order);
      const diagnostic=JSON.stringify({case:mapped?'mapped':'oa-unmapped',
        http_status:http.statusCode,http_code:http.json().error?.code,
        second_pool:direct,counts:actual,product_sha:'3093de9d17d5455690474dcb3d66addf7f49bb1f'});
      // Never downgrade these assertions. A 200/one job is a REAL blocker.
      assert.equal(http.statusCode,409,diagnostic);
      assert.equal(http.json().error.code,'PENDING_INBOUND_REVIEW',diagnostic);
      assert.equal(direct.result,'rejected',diagnostic);
      assert.equal(direct.status,409,diagnostic);
      assert.equal(direct.code,'PENDING_INBOUND_REVIEW',diagnostic);
      assert.equal(actual.approvals,0,diagnostic);
      assert.equal(actual.print_jobs,0,diagnostic);
    }finally{await teardown(s)}
  });
}

test('AI5 PR88 approval-first manual order: later signed receipt remains pending, replay cannot create another job', {timeout:120000},async()=>{
  const s=await setup();
  try{
    await register(s);
    const {order,token}=await manualReady(s);
    const first=await httpApproval(s,order,token);
    assert.equal(first.statusCode,200,first.body);
    assert.deepEqual(await unsignedStats(s,order),{approvals:1,print_jobs:1});
    const f=signed(s,'user_send_image',id('after-approval'));
    assert.equal((await s.send(f)).statusCode,200);
    assert.equal((await s.send(f)).statusCode,200);
    assert.equal(await count(s.b,'zalo_official_quarantine','oa_id',s.oa),1);
    const held=await one(s.b,
      'SELECT status FROM zalo_official_quarantine WHERE oa_id=$1',[s.oa]);
    assert.equal(held.status,'NEEDS_HUMAN','later receipt must not be erased by approval');
    const retry=await httpApproval(s,order,token);
    assert.equal(retry.statusCode,409,retry.body);
    assert.deepEqual(await unsignedStats(s,order),{approvals:1,print_jobs:1},
      'approval-first cannot create a second job after replay/lost ACK');
  }finally{await teardown(s)}
});
