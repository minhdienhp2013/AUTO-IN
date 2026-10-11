import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const skip=!(process.env.AUTOIN_RUN_LEGACY_P0==='1'&&process.env.AUTOIN_ACCEPTANCE_ADAPTER)&&'Product adapter missing: NOT RUN';
async function run(seed,fn){
 const mod=await import(pathToFileURL(resolve(process.env.AUTOIN_ACCEPTANCE_ADAPTER)).href);
 const a=await mod.createAcceptanceAdapter({databaseUrl:process.env.AUTOIN_TEST_DATABASE_URL,mode:'simulation',printer:'DryRunDriver'});
 assert.equal(a.environment?.type,'product-backed');
 assert.equal(a.environment?.database,'postgresql');
 assert.equal(a.environment?.print_driver,'DryRunDriver');
 try{await a.reset(seed);await fn(a);}finally{await a.dispose();}
}
const denial=r=>{assert.equal(r?.ok,false);assert.ok(r.error?.code);};
test('PRODUCT P0: forged Zalo signature blocked',{skip},()=>run('bad_zalo_signature',async a=>{
 denial(await a.act('webhook',{event_id:'fake',signature:'INVALID'},{actor:'unverified-zalo'}));
 assert.equal((await a.snapshot()).normalized_event_count,0);
}));
test('PRODUCT P0: malformed PDF/path traversal/ZIP bomb/6 docs do not auto-print',{skip},()=>run('malicious_documents',async a=>{
 for(const f of ['nguy-hiem-pdf-khong-hop-le.pdf','nguy-hiem-path-traversal.zip','nguy-hiem-zip-bomb-ratio.zip','nguy-hiem-qua-5-tai-lieu.zip']){
  const r=await a.act('ingest_fixture',{fixture_name:f},{actor:'staff'});
  const acceptedReasons=['ZIP_PATH_TRAVERSAL','ZIP_COMPRESSION_RATIO','OVER_FIVE_DOCUMENTS','CORRUPT_DOCUMENT','FILE_CORRUPT','PDF_OPEN_ERROR','INVALID_PDF','INVALID_DOCUMENT','ZIP_EXPANSION_LIMIT'];
  const reason=r?.reason_code??r?.error?.code;
  assert.ok(r?.state==='NEEDS_HUMAN'||r?.status==='NEEDS_HUMAN'||(r?.ok===false&&acceptedReasons.includes(reason)),
   'Unsafe input must be rejected for file safety, not auth/bad-request: '+f+' '+JSON.stringify(r));
 }
 assert.equal((await a.snapshot()).driver_calls,0);
}));
test('PRODUCT P0: idempotency collision with different body returns HTTP 409',{skip},()=>run('idempotency_conflict',async a=>{
 const one=await a.act('revise',{order_id:'synthetic-o2',expected_revision:2,request_data:{synthetic:true,copies:2},idempotency_key:'same'},{actor:'staff'});
 assert.equal(one.ok,true,'First mutation must succeed or this is a vacuous rejection test');
 const r=await a.act('revise',{order_id:'synthetic-o2',expected_revision:2,request_data:{synthetic:true,copies:3},idempotency_key:'same'},{actor:'staff'});
 denial(r);assert.equal(r.status,409);
}));
test('PRODUCT P0: duplicate mark-sending cannot grant two send permissions',{skip},()=>run('approved_unsent',async a=>{
 const x=await a.newAgent('agent-1'),y=await a.newAgent('agent-2');
 assert.notEqual(x.connection_id,y.connection_id);
 const got=await x.act('claim',{printer_id:'RMP7000',idempotency_key:'synthetic-double-send-claim'});
 assert.equal(got.ok,true);assert.ok(got.job?.job_id&&got.job?.lease_token);
 const body={job_id:got.job.job_id,lease_token:got.job.lease_token,expected_revision:got.job.revision};
 const r=await Promise.all([x.act('mark_sending',{...body,idempotency_key:'synthetic-first-send'}),x.act('mark_sending',{...body,idempotency_key:'synthetic-second-send'})]);
 assert.equal(r.filter(z=>z.ok===true&&z.state==='SENDING').length,1);
 assert.ok(r.some(z=>z.ok===false),'Second mark-sending must be rejected, not grant new send');
 assert.ok((await a.snapshot()).driver_calls<=1);
}));
