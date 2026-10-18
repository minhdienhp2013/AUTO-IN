import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {canonical,sha} from '../../../backend/core/model.ts';

const databaseUrl=process.env.TEST_DATABASE_URL;
const postUrl='/api/v1/orders/:order_id/revisions/:revision/pdf-review-previews';
const pageRouteUrl='/api/v1/orders/:order_id/revisions/:revision/previews/:index';

// Probe registered Fastify routes without touching a database. This lets the
// test report NOT RUN at a candidate that has not wired the target endpoint.
const noDatabase={
  async query(){throw new Error('Route registration probe must not query PostgreSQL');},
  async connect(){throw new Error('Route registration probe must not connect to PostgreSQL');}
};
async function probeRouteWiring(){
  const app=buildIntegratedApp({pool:noDatabase});
  try{
    await app.ready();
    return {
      post:app.hasRoute({method:'POST',url:postUrl}),
      page:app.hasRoute({method:'GET',url:pageRouteUrl})
    };
  }finally{await app.close();}
}
const routeWiring=await probeRouteWiring();
const skipReasons=[];
if(!databaseUrl)skipReasons.push('TEST_DATABASE_URL missing: PDF route PostgreSQL/HTTP NOT RUN');
if(!routeWiring.post)skipReasons.push('PDF review POST route is not wired: route acceptance NOT RUN');
if(!routeWiring.page)skipReasons.push('authenticated PDF page GET route is not wired: route acceptance NOT RUN');
const skip=skipReasons.length?skipReasons.join('; '):false;

const digest=(bytes)=>createHash('sha256').update(bytes).digest('hex');
const auth=(token)=>({authorization:`Bearer ${token}`});
const counts=async(pool,orderId,conversationId)=>{
  const row=(await pool.query(
    'SELECT (SELECT count(*)::int FROM core_confirmations WHERE order_id=$1) confirmations,'+
    '(SELECT count(*)::int FROM core_approvals WHERE order_id=$1) approvals,'+
    '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=$1) print_jobs,'+
    '(SELECT count(*)::int FROM zalo_outbound WHERE conversation_id=$2) outbox',
    [orderId,conversationId])).rows[0];
  return {confirmations:row.confirmations,approvals:row.approvals,
    print_jobs:row.print_jobs,outbox:row.outbox};
};
const assertHeld=(response)=>{
  if(response.statusCode!==200){
    assert.ok([404,409,422,503].includes(response.statusCode),
      `expected a bounded stale/source denial, got ${response.statusCode}: ${response.body}`);
    return;
  }
  const body=response.json();
  assert.equal(body.schema,'ai0.pdf_review_preview.v1');
  assert.equal(body.status,'NEEDS_HUMAN');
  assert.deepEqual(body.pages,[]);
  assert.equal(body.ready,false);
  assert.equal(body.allowed_to_print,false);
  assert.equal(body.requires_staff_review,true);
  assert.equal(body.physical_print_verified,false);
};

test('AI5 PDF review route: scoped staff POST, private source binding, page bytes, stale denial and no print mutation',{
  skip,timeout:120_000
},async()=>{
  assertIsolatedSimulationDatabase(databaseUrl);
  const id=randomUUID(),shop='autoin-test-pdf-review-'+id,oa='pdf-review-oa-'+id;
  const foreignShop='autoin-test-pdf-review-foreign-'+id;
  const customer='synthetic-customer-'+id,conversation='synthetic-chat-'+id;
  const eventId='pdf-'+id.replaceAll('-','');
  const ownerPassword='synthetic-owner-'+id;
  const scratch=await mkdtemp(join(tmpdir(),'autoin-pdf-review-route-'));
  const sourceRoot=join(scratch,'source'),previewRoot=join(scratch,'preview');
  const pool=new pg.Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});
  let app;
  try{
    await mkdir(sourceRoot,{mode:0o700});
    await mkdir(previewRoot,{mode:0o700});
    const source=await readFile(new URL('../../fixtures/public/load100/source.pdf',import.meta.url));
    assert.equal(source.subarray(0,5).toString('ascii'),'%PDF-','committed fixture must be a synthetic PDF');

    const core=createCoreModule({pool:asSqlPool(pool)});
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password:ownerPassword,bootstrap_enabled:true});
    await core.auth.bootstrapOwner({shop_id:foreignShop,username:'owner',password:ownerPassword,bootstrap_enabled:true});
    const staff=await core.auth.login(shop,'owner',ownerPassword);
    const foreignStaff=await core.auth.login(foreignShop,'owner',ownerPassword);
    const scope={shop_id:shop,oa_id:oa};
    app=buildIntegratedApp({pool:asSqlPool(pool),
      syntheticArtifactIngest:{artifactRoot:sourceRoot,scope},
      previewArtifactRoot:previewRoot,
      pdfReviewArtifactRoot:previewRoot,
      trustedPrintEvidence:{artifactRoot:sourceRoot,printerCapabilities:{
        simulation_only:true,printer_id:'RMP7000',queue_name:'RMP7000'
      }}});
    await app.ready();

    await pool.query('INSERT INTO zalo_inbound_events '+
      '(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) '+
      'VALUES($1,$2,$3,$4,now(),$5::jsonb)',
      [oa,eventId,conversation,customer,JSON.stringify({kind:'file',filename:'source.pdf',
        customer_id:customer,conversation_id:conversation})]);
    const imported=await app.inject({method:'POST',url:'/internal/simulation/inbound-artifacts',
      headers:auth(staff.token),payload:{event_id:eventId,filename:'source.pdf',
        content_base64:source.toString('base64')}});
    assert.equal(imported.statusCode,201,imported.body);
    assert.equal(imported.json().status,'registered');

    const drafted=await app.inject({method:'POST',
      url:`/internal/simulation/inbound-artifacts/${eventId}/draft`,headers:auth(staff.token),
      payload:{event_id:eventId,paper:'A4',copies:1,duplex:false}});
    assert.equal(drafted.statusCode,201,drafted.body);
    const orderId=drafted.json().order_id;
    const order=(await pool.query('SELECT shop_id,customer_id,conversation_id,active_revision '+
      'FROM core_orders WHERE id=$1',[orderId])).rows[0];
    assert.deepEqual(order,{shop_id:shop,customer_id:customer,conversation_id:conversation,
      active_revision:1});
    const revision=(await pool.query('SELECT request_hash,request_data FROM core_revisions '+
      'WHERE order_id=$1 AND revision=1',[orderId])).rows[0];
    assert.equal(revision.request_hash,sha(canonical(revision.request_data)),
      'hash must be from Core’s unchanged stored request_data');
    const sourceRef=revision.request_data.documents[0].artifact_name;
    const registered=(await pool.query('SELECT artifact_ref,sha256 FROM ai0_inbound_document_artifacts '+
      'WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',[shop,oa,eventId])).rows[0];
    assert.equal(sourceRef,registered.artifact_ref,
      'Core artifact_name must name the exact server-registered source');
    assert.equal(registered.sha256,digest(source));

    const foreignOrder=await core.service.createDraft(foreignStaff.principal,{
      customer_id:`foreign-customer-${id}`,conversation_id:`foreign-chat-${id}`,
      request_data:{documents:[{artifact_name:'doc-foreign/source-000-'+'a'.repeat(64)+'.pdf',
        copies:1,duplex:false,paper:'A4'}]},idempotency_key:`foreign-pdf-${id}`
    });
    const before=await counts(pool,orderId,conversation);
    assert.deepEqual(before,{confirmations:0,approvals:0,print_jobs:0,outbox:0});

    // The route contract does not define a request JSON schema. Use an empty
    // object and require the server to resolve the exact active Core revision
    // and registered source itself; never let caller fields pick a file/hash.
    const post=(order,rev,headers=auth(staff.token))=>app.inject({
      method:'POST',url:`/api/v1/orders/${order}/revisions/${rev}/pdf-review-previews`,
      headers,payload:{}
    });
    const unauthorized=await post(orderId,1,{});
    assert.equal(unauthorized.statusCode,401,unauthorized.body);
    const invalidBearer=await post(orderId,1,auth('invalid-synthetic-token'));
    assert.equal(invalidBearer.statusCode,401,invalidBearer.body);
    const foreign=await post(foreignOrder.order_id,1,auth(staff.token));
    assert.ok([403,404].includes(foreign.statusCode),foreign.body);
    assert.ok(!foreign.body.includes(source.toString('base64')));
    const foreignPage=await app.inject({method:'GET',
      url:`/api/v1/orders/${orderId}/revisions/1/previews/0`,
      headers:auth(foreignStaff.token)});
    assert.ok([403,404].includes(foreignPage.statusCode),foreignPage.body);

    const response=await post(orderId,1);
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.headers['cache-control'],'no-store');
    const preview=response.json();
    assert.equal(preview.schema,'ai0.pdf_review_preview.v1');
    assert.equal(preview.shop_id,shop);
    assert.equal(preview.order_id,orderId);
    assert.equal(preview.revision,1);
    assert.equal(preview.request_hash,revision.request_hash);
    assert.equal(preview.source_sha256,registered.sha256);
    assert.match(preview.manifest_sha256,/^[0-9a-f]{64}$/);
    assert.equal(preview.source_format,'PDF');
    assert.equal(preview.status,'REVIEW_REQUIRED');
    assert.equal(preview.ready,false);
    assert.equal(preview.allowed_to_print,false);
    assert.equal(preview.requires_staff_review,true);
    assert.equal(preview.physical_print_verified,false);
    assert.ok(Array.isArray(preview.pages)&&preview.pages.length>0&&preview.pages.length<=15);
    assert.ok(!Object.hasOwn(preview,'private_bytes'));
    assert.ok(!Object.hasOwn(preview,'artifact_ref'));
    assert.ok(!Object.hasOwn(preview,'manifest_ref'));
    assert.ok(!response.body.includes(source.toString('base64')));
    assert.ok(!response.body.includes(sourceRef));

    for(let i=0;i<preview.pages.length;i++){
      const page=preview.pages[i];
      const expectedUrl=`/api/v1/orders/${orderId}/revisions/1/previews/${i}`;
      assert.deepEqual(page,{index:i,url:expectedUrl,content_type:'image/png',
        sha256:page.sha256,bytes:page.bytes});
      assert.match(page.sha256,/^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(page.bytes)&&page.bytes>0);
      const pageResponse=await app.inject({method:'GET',url:page.url,headers:auth(staff.token)});
      assert.equal(pageResponse.statusCode,200,pageResponse.body);
      assert.match(pageResponse.headers['content-type']??'',/^image\/png\b/i);
      assert.equal(pageResponse.headers['cache-control'],'no-store');
      const pageBytes=pageResponse.rawPayload;
      assert.ok(Buffer.isBuffer(pageBytes));
      assert.equal(pageBytes.length,page.bytes);
      assert.equal(digest(pageBytes),page.sha256);
      assert.deepEqual(pageBytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    }
    const pageUnauthenticated=await app.inject({method:'GET',url:preview.pages[0].url});
    assert.equal(pageUnauthenticated.statusCode,401,pageUnauthenticated.body);
    const pageInvalidBearer=await app.inject({method:'GET',url:preview.pages[0].url,
      headers:auth('invalid-synthetic-token')});
    assert.equal(pageInvalidBearer.statusCode,401,pageInvalidBearer.body);

    const unregisteredArtifact='doc-unregistered/source-000-'+'b'.repeat(64)+'.pdf';
    const unregisteredOrder=await core.service.createDraft(staff.principal,{
      customer_id:`unregistered-customer-${id}`,conversation_id:`unregistered-chat-${id}`,
      request_data:{documents:[{artifact_name:unregisteredArtifact,copies:1,
        duplex:false,paper:'A4'}]},idempotency_key:`unregistered-pdf-${id}`
    });
    const unregistered=await post(unregisteredOrder.order_id,1);
    assertHeld(unregistered);
    assert.ok(!unregistered.body.includes(source.toString('base64')));
    assert.ok(!unregistered.body.includes(unregisteredArtifact),
      'an unregistered source locator must not leak in the held response');

    const changedRequest=structuredClone(revision.request_data);
    changedRequest.documents[0].copies=2;
    const changed=await core.service.revise(staff.principal,orderId,{expected_revision:1,
      request_data:changedRequest,idempotency_key:`pdf-revision-change-${id}`});
    assert.equal(changed.revision,2);
    const stalePost=await post(orderId,1);
    assert.ok([404,409].includes(stalePost.statusCode),stalePost.body);
    const stalePage=await app.inject({method:'GET',url:preview.pages[0].url,
      headers:auth(staff.token)});
    assert.ok([404,409].includes(stalePage.statusCode),stalePage.body);

    const after=await counts(pool,orderId,conversation);
    assert.deepEqual(after,before,
      'preview reads and rejected/stale requests must not confirm, approve, create jobs or send outbox messages');
    console.log('PASS PDF REVIEW ROUTE synthetic fixture=1 staff_scope=true exact_source=true pages_hash_verified=true stale_denied=true side_effects=0');
  }finally{
    if(app)await app.close();
    await pool.end();
    await rm(scratch,{recursive:true,force:true});
  }
});
