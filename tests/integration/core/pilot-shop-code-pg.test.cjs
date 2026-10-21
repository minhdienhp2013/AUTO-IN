const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {OrderService}=require(path.join(root,'core/service.js'));
const {PgStore}=require(path.join(root,'storage/database.js'));
const {sha,canonical}=require(path.join(root,'core/model.js'));
const {pilotSettingsHash}=require(path.join(root,'core/pilot-shop-code.js'));
let pg;try{pg=require('pg')}catch{}
const databaseUrl=process.env.TEST_DATABASE_URL,uid=()=>randomUUID(),idempotency=()=>`pilot-${uid()}`;
const skip=!(pg&&databaseUrl)&&'NOT RUN - isolated PostgreSQL TEST_DATABASE_URL and pg are required';
const codeKey=Buffer.from('synthetic-only-pilot-HMAC-secret-key-32-bytes-minimum');
const fixedNow=()=>new Date('2026-10-21T05:00:00.000Z');
const error=code=>e=>e&&e.code===code;

test('AI1 pilot shop code REAL PG: order/revision/source binding, 30-minute code, rate limit, replay/race and one job',
 {skip,timeout:120000},async t=>{
  const parsed=new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'TEST_DATABASE_URL must use a local disposable PostgreSQL server');
  assert.match(parsed.pathname,/test/i,'TEST_DATABASE_URL database name must identify a test database');
  const a=new pg.Pool({connectionString:databaseUrl,max:8}),b=new pg.Pool({connectionString:databaseUrl,max:8});
  const worlds=[];
  try{
   for(const migration of [
    '../../../backend/integrations/zalo/migrations/001_zalo_durable.sql',
    '../../../backend/storage/migrations/001_core.sql',
    '../../../backend/storage/migrations/002_send_mode.sql',
    '../../../backend/storage/migrations/003_confirmed_queue.sql',
    '../../../backend/storage/migrations/007_active_order_inbound.sql',
    '../../../backend/storage/migrations/011_print_evidence_binding.sql',
    '../../../backend/storage/migrations/013_inbound_review_items.sql',
    '../../../backend/storage/migrations/014_pilot_shop_code.sql',
    '../../../backend/composition/migrations/005_official_zalo_shop_registry.sql'
   ])await a.query(fs.readFileSync(path.resolve(__dirname,migration),'utf8'));
   const makeWorld=async(label)=>{
    const suffix=uid(),shop=`pilot-${label}-${suffix}`,oa=`pilot-oa-${suffix}`,customer=`customer-${suffix}`;
    const conversation=`chat-${suffix}`,orderId=uid(),agentId=`agent-${suffix}`;
    const fileEvent=`file-${suffix}`,codeEvent=`code-${suffix}`,bundle=`bundle_${suffix.replaceAll('-','')}`;
    const artifactRef=`${bundle}/source.docx`,manifestRef=`${bundle}/manifest.json`;
    const sourceBytes=Buffer.from(`synthetic-docx-${suffix}`),requestData={documents:[{
     artifact_name:artifactRef,copies:2,duplex:true,paper:'A4'}]};
    const requestHash=sha(canonical(requestData));
    const settings={copies:2,duplex:true,paper:'A4',color:'black_white'};
    const manifestFor=(bytes,hash)=>Buffer.from(JSON.stringify({schema:'ai0.word_review_manifest.v1',
     manifest_ref:manifestRef,shop_id:shop,order_id:orderId,active_revision:1,request_hash:hash,
     source:{format:'DOCX',artifact_ref:artifactRef,
      sha256:createHash('sha256').update(bytes).digest('hex'),size_bytes:bytes.length}}));
    const material={bytes:sourceBytes,requestData,requestHash};
    const reader={async read_registered(_db,scope){
     return {source:{artifact_ref:artifactRef,bytes:Buffer.from(material.bytes)},
      manifest:{ref:manifestRef,bytes:manifestFor(material.bytes,scope.request_hash)},provider_event_id:fileEvent};
    }};
    const A=new OrderService(new PgStore(a),fixedNow,undefined,reader,undefined,codeKey);
    const B=new OrderService(new PgStore(b),fixedNow,undefined,reader,undefined,codeKey);
    await a.query("INSERT INTO core_shop_settings(shop_id,mode,printing_enabled,open_at,close_at) VALUES($1,'simulation',false,'00:00','24:00')",[shop]);
    await a.query('INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',[shop,oa,`app-${suffix}`]);
    await a.query('INSERT INTO core_pilot_shop_config(shop_id,printer_id,agent_id,enabled,allow_real_print,tested_at) '+
     'VALUES($1,$2,$3,true,false,clock_timestamp())',[shop,'RMP7000',agentId]);
    const plan={request_hash:requestHash,physical_sheets:2,document_pages:2,printed_faces:4,ready:true,
     printer_id:'RMP7000',artifact_ref:artifactRef,verified_by:`processor-${suffix}`};
    await a.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id,active_revision) VALUES($1,$2,$3,$4,1)',
     [orderId,shop,customer,conversation]);
    await a.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data,plan) VALUES($1,1,$2,$3::jsonb,$4::jsonb)',
     [orderId,requestHash,JSON.stringify(requestData),JSON.stringify(plan)]);
    const addEvent=async(eventId,kind,who=customer,chat=conversation)=>a.query(
     'INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) '+
     'VALUES($1,$2,$3,$4,clock_timestamp(),$5::jsonb)',[oa,eventId,chat,who,JSON.stringify({kind})]);
    await addEvent(fileEvent,'file');
    const candidate={shop_id:shop,oa_id:oa,customer_id:customer,conversation_id:conversation,order_id:orderId,
     revision:1,request_hash:requestHash,source:{format:'DOCX',artifact_ref:artifactRef,
      sha256:createHash('sha256').update(sourceBytes).digest('hex'),size_bytes:sourceBytes.length,
      provider_event_id:fileEvent},settings,settings_sha256:pilotSettingsHash(settings),printer_id:'RMP7000'};
    const staff={id:`staff-${suffix}`,shop_id:shop,role:'staff',verified:true};
    const agent={id:agentId,shop_id:shop,role:'print_agent',verified:true,printer_ids:['RMP7000']};
    const display=await A.getPilotShopCode(staff);
    const submission=(eventId=codeEvent,code=display.code,customerId=customer)=>({schema:'ai0.pilot_code_submission.v1',
     shop_id:shop,oa_id:oa,customer_id:customerId,conversation_id:conversation,order_id:orderId,
     revision:1,provider_event_id:eventId,code,idempotency_key:idempotency()});
    await addEvent(codeEvent,'text');
    const destroy=async()=>{
     await a.query('DELETE FROM core_print_jobs WHERE order_id=$1',[orderId]).catch(()=>{});
     await a.query('DELETE FROM core_pilot_print_authorizations WHERE order_id=$1',[orderId]).catch(()=>{});
     await a.query('DELETE FROM core_pilot_code_attempts WHERE order_id=$1',[orderId]).catch(()=>{});
     await a.query('DELETE FROM core_pilot_candidates WHERE order_id=$1',[orderId]).catch(()=>{});
     await a.query('DELETE FROM core_audit WHERE order_id=$1',[orderId]).catch(()=>{});
     await a.query('DELETE FROM core_revisions WHERE order_id=$1',[orderId]).catch(()=>{});
     await a.query('DELETE FROM core_orders WHERE id=$1',[orderId]).catch(()=>{});
     await a.query('DELETE FROM core_pilot_shop_code_windows WHERE shop_id=$1',[shop]).catch(()=>{});
     await a.query('DELETE FROM core_pilot_shop_config WHERE shop_id=$1',[shop]).catch(()=>{});
     await a.query('DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=$1',[shop]).catch(()=>{});
     await a.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]).catch(()=>{});
     await a.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]).catch(()=>{});
    };
    const world={A,B,a,b,shop,oa,customer,conversation,orderId,agentId,fileEvent,codeEvent,
     artifactRef,sourceBytes,material,candidate,staff,agent,display,submission,addEvent,destroy};
    worlds.push(world);return world;
   };
   const jobs=async id=>Number((await a.query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[id])).rows[0].n);
   const candidateCount=async id=>Number((await a.query('SELECT count(*)::int AS n FROM core_pilot_candidates WHERE order_id=$1',[id])).rows[0].n);

   await t.test('valid code arrives before file, stays HMAC-only, then creates one pilot job and worker receives private bytes',async()=>{
    const w=await makeWorld('early-code');
    const pending=await w.A.authorizePilotPrint(w.submission());
    assert.equal(pending.status,'WAITING_FOR_FILE');
    const registered=await w.A.registerPilotCandidate(w.candidate);
    assert.equal(registered.status,'AUTHORIZED');
    assert.equal(candidateCount(w.orderId),1);assert.equal(await jobs(w.orderId),1);
    const rows=(await a.query('SELECT id,approval_id,pilot_authorization_id,confirmed_at,state FROM core_print_jobs WHERE order_id=$1',[w.orderId])).rows;
    assert.equal(rows[0].approval_id,null);assert.ok(rows[0].pilot_authorization_id);assert.equal(rows[0].confirmed_at,null);
    const window=(await a.query('SELECT issued_at,expires_at,code_hmac FROM core_pilot_shop_code_windows WHERE shop_id=$1',[w.shop])).rows[0];
    assert.equal(new Date(window.expires_at)-new Date(window.issued_at),30*60*1000);
    assert.notEqual(window.code_hmac,w.display.code);
    assert.equal((await a.query('SELECT count(*)::int n FROM core_approvals WHERE order_id=$1',[w.orderId])).rows[0].n,0);
    assert.equal((await a.query('SELECT count(*)::int n FROM core_confirmations WHERE order_id=$1',[w.orderId])).rows[0].n,0);
    const persisted=JSON.stringify((await a.query('SELECT * FROM core_pilot_code_attempts WHERE order_id=$1',[w.orderId])).rows);
    const audit=JSON.stringify((await a.query('SELECT details FROM core_audit WHERE order_id=$1',[w.orderId])).rows);
    assert.equal(persisted.includes(w.display.code),false);assert.equal(audit.includes(w.display.code),false);
    const claimed=await w.A.claimPilot(w.agent,{printer_id:'RMP7000',idempotency_key:idempotency()});
    assert.equal(claimed.schema,'ai0.pilot_agent_claim.v1');assert.equal(claimed.work.authorization.job_id,rows[0].id);
    const gate={expected_revision:1,lease_token:claimed.work.job.lease_token,request_hash:claimed.work.job.request_hash,
     source_sha256:claimed.work.authorization.source_sha256,settings_sha256:claimed.work.authorization.settings_sha256,
     evidence_sha256:claimed.work.authorization.evidence_sha256,printer_id:claimed.work.job.printer_id};
    const preflight=await w.B.preflightPilot(w.agent,claimed.work.job.job_id,gate);
    assert.equal(preflight.schema,'ai0.pilot_agent_gate_receipt.v1');assert.equal(preflight.state,'AUTHORIZED');
    const privateSource=await w.B.getPilotJobSource(w.agent,claimed.work.job.job_id,claimed.work.job.lease_token);
    assert.equal(Buffer.from(privateSource.bytes).equals(w.sourceBytes),true);
    assert.equal(JSON.stringify(preflight).includes('private_bytes'),false);
    await w.destroy();
   });

   await t.test('accepted code expires before the file is ready and cannot create authorization/job later',async()=>{
    const w=await makeWorld('expiry-after-arrival');
    assert.equal((await w.A.authorizePilotPrint(w.submission())).status,'WAITING_FOR_FILE');
    await a.query("UPDATE core_pilot_shop_code_windows SET expires_at=clock_timestamp()-interval '1 second' WHERE shop_id=$1",[w.shop]);
    const result=await w.A.registerPilotCandidate(w.candidate);
    assert.deepEqual(result,{status:'WAITING_FOR_CODE',reason:'CODE_EXPIRED'});
    assert.equal(await jobs(w.orderId),0);
    assert.equal((await a.query('SELECT count(*)::int n FROM core_pilot_print_authorizations WHERE order_id=$1',[w.orderId])).rows[0].n,0);
    await w.destroy();
   });

   await t.test('wrong code is counted, continuous guesses are limited, and wrong shop/customer fail closed',async()=>{
    const w=await makeWorld('rate-limit');
    for(let n=0;n<5;n++){
     const event=`guess-${n}-${uid()}`;await w.addEvent(event,'text');
     assert.equal((await w.A.authorizePilotPrint(w.submission(event,'0000000000'))).status,'WAITING_FOR_CODE');
    }
    const correctEvent=`correct-${uid()}`;await w.addEvent(correctEvent,'text');
    assert.equal((await w.A.authorizePilotPrint(w.submission(correctEvent))).status,'WAITING_FOR_CODE');
    assert.equal((await a.query('SELECT count(*)::int n FROM core_pilot_code_attempts WHERE shop_id=$1 AND accepted=false',[w.shop])).rows[0].n,6);
    await assert.rejects(w.A.authorizePilotPrint({...w.submission(`wrong-shop-${uid()}`),shop_id:`other-${w.shop}`}),error('PILOT_SUBMISSION_REJECTED'));
    await assert.rejects(w.A.authorizePilotPrint(w.submission(`wrong-customer-${uid()}`,w.display.code,'not-this-customer')),
     error('PILOT_SUBMISSION_REJECTED'));
    const staleRevisionEvent=`stale-revision-${uid()}`;await w.addEvent(staleRevisionEvent,'text');
    await assert.rejects(w.A.authorizePilotPrint({...w.submission(staleRevisionEvent),revision:2}),
     error('PILOT_SUBMISSION_REJECTED'));
    assert.equal(await jobs(w.orderId),0);
    await w.destroy();
   });

   await t.test('expired code and source/settings drift do not authorize',async()=>{
    const expired=await makeWorld('expired-code');
    await a.query("UPDATE core_pilot_shop_code_windows SET expires_at=clock_timestamp()-interval '1 second' WHERE shop_id=$1",[expired.shop]);
    assert.equal((await expired.A.authorizePilotPrint(expired.submission())).status,'WAITING_FOR_CODE');
    const rotated=await expired.A.getPilotShopCode(expired.staff);
    assert.notEqual(rotated.code,expired.display.code);
    assert.equal(new Date(rotated.expires_at)-new Date(rotated.server_time),30*60*1000);
    assert.equal(await jobs(expired.orderId),0);await expired.destroy();

    const fileChanged=await makeWorld('file-drift');
    assert.equal((await fileChanged.A.registerPilotCandidate(fileChanged.candidate)).status,'WAITING_FOR_CODE');
    fileChanged.material.bytes=Buffer.from('changed synthetic bytes');
    await assert.rejects(fileChanged.A.authorizePilotPrint(fileChanged.submission()),error('PILOT_SOURCE_NOT_VERIFIED'));
    assert.equal(await jobs(fileChanged.orderId),0);await fileChanged.destroy();

    const settingsChanged=await makeWorld('settings-drift');
    assert.equal((await settingsChanged.A.registerPilotCandidate(settingsChanged.candidate)).status,'WAITING_FOR_CODE');
    const changed={documents:[{...settingsChanged.material.requestData.documents[0],copies:3}]};
    const changedHash=sha(canonical(changed));
    const storedPlan=(await a.query('SELECT plan FROM core_revisions WHERE order_id=$1 AND revision=1',[settingsChanged.orderId])).rows[0].plan;
    await a.query('UPDATE core_revisions SET request_data=$2::jsonb,request_hash=$3,plan=$4::jsonb WHERE order_id=$1 AND revision=1',
     [settingsChanged.orderId,JSON.stringify(changed),changedHash,JSON.stringify({...storedPlan,request_hash:changedHash})]);
    await assert.rejects(settingsChanged.A.authorizePilotPrint(settingsChanged.submission()),error('PILOT_SUBMISSION_REJECTED'));
    assert.equal(await jobs(settingsChanged.orderId),0);await settingsChanged.destroy();

    const printerChanged=await makeWorld('printer-drift');
    const wrongPrinter=await printerChanged.A.registerPilotCandidate({...printerChanged.candidate,printer_id:'OTHER-PRINTER'});
    assert.deepEqual(wrongPrinter,{status:'NEEDS_HUMAN',reason:'OUT_OF_PILOT_SCOPE'});
    assert.equal(await candidateCount(printerChanged.orderId),0);
    assert.equal(await jobs(printerChanged.orderId),0);await printerChanged.destroy();
   });

   await t.test('same webhook replay/race creates one job; UNKNOWN is returned and never reclaimed by a new code event',async()=>{
    const w=await makeWorld('replay-race');
    await w.A.registerPilotCandidate(w.candidate);
    const submission=w.submission();
    const raced=await Promise.all([w.A.authorizePilotPrint(submission),w.B.authorizePilotPrint(submission)]);
    assert.ok(raced.every(result=>result.status==='AUTHORIZED'));
    assert.equal(raced[0].authorization.job_id,raced[1].authorization.job_id);assert.equal(await jobs(w.orderId),1);
    const replay=await w.B.authorizePilotPrint(submission);
    assert.equal(replay.authorization.job_id,raced[0].authorization.job_id);assert.equal(await jobs(w.orderId),1);
    const claim=await w.A.claimPilot(w.agent,{printer_id:'RMP7000',idempotency_key:idempotency()});
    const gate={expected_revision:1,lease_token:claim.work.job.lease_token,request_hash:claim.work.job.request_hash,
     source_sha256:claim.work.authorization.source_sha256,settings_sha256:claim.work.authorization.settings_sha256,
     evidence_sha256:claim.work.authorization.evidence_sha256,printer_id:claim.work.job.printer_id};
    await w.A.markPilotSending(w.agent,claim.work.job.job_id,gate);
    await w.B.reportPilot(w.agent,claim.work.job.job_id,{schema:'ai0.pilot_agent_report.v1',
     lease_token:claim.work.job.lease_token,state:'UNKNOWN',idempotency_key:idempotency(),evidence:{}});
    const newCodeEvent=`new-code-${uid()}`;await w.addEvent(newCodeEvent,'text');
    const afterUnknown=await w.B.authorizePilotPrint(w.submission(newCodeEvent));
    assert.equal(afterUnknown.status,'UNKNOWN');assert.equal(afterUnknown.authorization.job_id,claim.work.job.job_id);
    assert.equal(await jobs(w.orderId),1);
    assert.equal((await w.A.claimPilot(w.agent,{printer_id:'RMP7000',idempotency_key:idempotency()})).work,null);
    await w.destroy();
   });
  }finally{
   for(const w of worlds.reverse())await w.destroy().catch(()=>{});
   await Promise.all([a.end(),b.end()]);
  }
 });
