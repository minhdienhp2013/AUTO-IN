import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {ingestSyntheticArtifact} from '../../../backend/composition/synthetic-ingest.ts';
import {createSyntheticInboundDraft} from '../../../backend/composition/inbound-draft.ts';
import {loadVerifiedOrderPreview} from '../../../backend/composition/preview.ts';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';

const url=process.env.TEST_DATABASE_URL;
test('REAL PostgreSQL: verified synthetic webhook file → one staff draft → AI3 plan → staff preview, mutation blocked',{
 skip:!url?'TEST_DATABASE_URL unset: synthetic document to draft PG NOT VERIFIED':false,
 timeout:120000
},async()=>{
 assertIsolatedSimulationDatabase(url);
 const root=await mkdtemp(join(tmpdir(),'autoin-verified-flow-'));
 const inbound=join(root,'inbound'),output=join(root,'output');
 const pool=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000});
 const python=process.env.AUTOIN_PYTHON??'python3';
 try {
  await mkdir(inbound,{mode:0o700});await mkdir(output,{mode:0o700});
  const pngPath=join(root,'fixture.png');
  const result=spawnSync(python,['-c','from PIL import Image;import sys;Image.new("RGB",(90,120),"white").save(sys.argv[1])',pngPath],{timeout:10000});
  assert.equal(result.status,0,'Synthetic PDF/image dependencies must be installed');
  const png=await readFile(pngPath);
  const shop='auto-link-'+randomUUID(),oa='synthetic-oa-'+randomUUID();
  const ownerPassword='synthetic-test-only-'+randomUUID();
  const scope={shop_id:shop,oa_id:oa};
  const core=createCoreModule({pool:asSqlPool(pool)});
  await pool.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await core.auth.bootstrapOwner({shop_id:shop,username:'synthetic-owner',password:ownerPassword,bootstrap_enabled:true});
  const login=await core.auth.login(shop,'synthetic-owner',ownerPassword);
  const staff=login.principal;
  const app=buildIntegratedApp({pool:asSqlPool(pool),
    syntheticArtifactIngest:{artifactRoot:inbound,scope},previewArtifactRoot:output});
  await app.ready();
  const insertEvent=async(eventId)=>{
    const event={synthetic_fixture:true,event_id:eventId,oa_id:oa,
      customer_id:'synthetic-customer',conversation_id:'synthetic-conversation',
      occurred_at:new Date().toISOString(),kind:'image',filename:'fixture.png',
      file_ref:'synthetic-fixture-ref'};
    await pool.query('INSERT INTO zalo_inbound_events (oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [oa,eventId,event.conversation_id,event.customer_id,event.occurred_at,JSON.stringify(event)]);
  };
  const importEvent=async(eventId)=>{
    await insertEvent(eventId);
    return ingestSyntheticArtifact(asSqlPool(pool),inbound,scope,staff,{
      event_id:eventId,filename:'fixture.png',content_base64:png.toString('base64')
    });
  };
  const config=(eventId)=>({event_id:eventId,paper:'A4',copies:2,duplex:false});
  const env={...process.env,DATABASE_URL:url,AUTOIN_INPUT_ROOT:inbound,AUTOIN_ARTIFACT_ROOT:output,
    AUTOIN_PROCESSOR_ID:'synthetic-internal-processor',AUTOIN_PYTHON:python};
  const cli=(orderId)=>spawnSync(process.execPath,['--import','tsx','scripts/process-order.ts',shop,orderId],
    {cwd:process.cwd(),encoding:'utf8',timeout:60000,env});
  const event='evt-'+randomUUID();
  assert.equal((await importEvent(event)).status,'registered');
  const endpoint='/internal/simulation/inbound-artifacts/'+event+'/draft';
  const settings={paper:'A4',copies:2,duplex:false};
  assert.equal((await app.inject({method:'POST',url:endpoint,payload:settings})).statusCode,401);
  const response=await app.inject({method:'POST',url:endpoint,
    headers:{authorization:'Bearer '+login.token},payload:settings});
  assert.equal(response.statusCode,201,JSON.stringify(response.json()));
  const draft=response.json();
  assert.equal(draft.status,'created');
  assert.equal(draft.revision,1);
  assert.equal(draft.preview_trusted,false);
  const replayResponse=await app.inject({method:'POST',url:endpoint,
    headers:{authorization:'Bearer '+login.token},payload:settings});
  assert.equal(replayResponse.statusCode,200);
  const replay=replayResponse.json();
  assert.equal(replay.status,'existing');
  assert.equal(replay.order_id,draft.order_id);
  await assert.rejects(createSyntheticInboundDraft(asSqlPool(pool),core.service,inbound,scope,staff,{
    ...config(event),copies:3
  }),{code:'DRAFT_SETTINGS_CONFLICT'});
  const first=cli(draft.order_id);
  assert.equal(first.status,0,'AI3 verified render + AI1 publish + AI0 anchor: '+first.stderr?.slice(-1200));
  const published=JSON.parse(first.stdout);
  assert.equal(published.revision,2);
  assert.equal(published.requires_reconfirmation,true);
  const catalogUrl='/api/v1/orders/'+draft.order_id+'/revisions/2/previews';
  assert.equal((await app.inject({method:'GET',url:catalogUrl})).statusCode,401);
  const catalogResponse=await app.inject({method:'GET',url:catalogUrl,
    headers:{authorization:'Bearer '+login.token}});
  assert.equal(catalogResponse.statusCode,200,JSON.stringify(catalogResponse.json()));
  assert.equal(catalogResponse.headers['cache-control'],'no-store');
  const catalog=catalogResponse.json();
  assert.equal(catalog.preview_verified,true);
  assert.equal(catalog.revision,2);
  assert.equal(catalog.order_id,draft.order_id);
  assert.ok(catalog.preview_count>0 && catalog.preview_count<=15);
  assert.equal(catalog.previews.length,catalog.preview_count);
  assert.equal(catalog.previews[0].index,0);
  assert.equal(catalog.previews[0].content_type,'image/png');
  assert.equal(catalog.previews[0].url,
    '/api/v1/orders/'+draft.order_id+'/revisions/2/previews/0');
  assert.ok(!JSON.stringify(catalog).includes('/doc-'),'Catalog cannot expose source/manifest paths');
  const previewUrl='/api/v1/orders/'+draft.order_id+'/revisions/2/previews/0';
  assert.equal((await app.inject({method:'GET',url:previewUrl})).statusCode,401);
  const previewResponse=await app.inject({method:'GET',url:previewUrl,
    headers:{authorization:'Bearer '+login.token}});
  assert.equal(previewResponse.statusCode,200,previewResponse.body.slice(0,300));
  assert.equal(previewResponse.headers['cache-control'],'no-store');
  assert.equal(previewResponse.headers['content-type'],'image/png');
  const view=await loadVerifiedOrderPreview(asSqlPool(pool),output,staff,draft.order_id,2,0);
  assert.deepEqual(view.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  await assert.rejects(loadVerifiedOrderPreview(asSqlPool(pool),output,
    {...staff,shop_id:'other'},draft.order_id,2,0),{code:'PREVIEW_NOT_AVAILABLE'});
  // The catalog is also invalidated on source preview bytes change, not just per-image access.
  const metadata=(await pool.query('SELECT artifact_ref FROM ai0_verified_plan_manifests WHERE order_id=$1 AND revision=2',
    [draft.order_id])).rows[0];
  const manifest=JSON.parse(await readFile(join(output,metadata.artifact_ref),'utf8'));
  const rendered=join(output,manifest.previews[0].ref);
  await chmod(rendered,0o600);await writeFile(rendered,Buffer.from('broken after verified plan'));
  const brokenCatalog=await app.inject({method:'GET',url:catalogUrl,
    headers:{authorization:'Bearer '+login.token}});
  assert.equal(brokenCatalog.statusCode,409);
  assert.equal(brokenCatalog.json().error.code,'PREVIEW_BYTES_CHANGED');
  const revisions=(await pool.query('SELECT active_revision FROM core_orders WHERE id=$1',[draft.order_id])).rows;
  assert.equal(revisions[0].active_revision,2);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM core_confirmations WHERE order_id=$1',[draft.order_id])).rows[0].n,0);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[draft.order_id])).rows[0].n,0);
  // Tampering a different registered snapshot must fail BEFORE publication.
  const badEvent='evt-'+randomUUID();
  await importEvent(badEvent);
  const bad=await createSyntheticInboundDraft(asSqlPool(pool),core.service,inbound,scope,staff,config(badEvent));
  const sourceRow=(await pool.query('SELECT artifact_ref FROM ai0_inbound_document_artifacts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
    [shop,oa,badEvent])).rows[0];
  const filename=join(inbound,sourceRow.artifact_ref);
  await chmod(filename,0o600);await writeFile(filename,Buffer.from('changed after registration'));
  const rejected=cli(bad.order_id);
  assert.notEqual(rejected.status,0,'Modified source may never produce a plan');
  assert.equal((await pool.query('SELECT active_revision FROM core_orders WHERE id=$1',[bad.order_id])).rows[0].active_revision,1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[bad.order_id])).rows[0].n,0);
  // Ambiguous AI1 failure must remain durable PENDING; never auto-create twice.
  const uncertain='evt-'+randomUUID();
  await importEvent(uncertain);
  await assert.rejects(createSyntheticInboundDraft(asSqlPool(pool),{
    async createDraft(){throw new Error('synthetic AI1 response lost');}
  },inbound,scope,staff,config(uncertain)),/synthetic AI1 response lost/);
  await assert.rejects(createSyntheticInboundDraft(asSqlPool(pool),core.service,
    inbound,scope,staff,config(uncertain)),{code:'DRAFT_PENDING_NEEDS_HUMAN'});
  assert.equal((await pool.query('SELECT status FROM ai0_inbound_artifact_drafts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
    [shop,oa,uncertain])).rows[0].status,'PENDING');
  await app.close();
 } finally {await pool.end();await rm(root,{recursive:true,force:true});}
});
