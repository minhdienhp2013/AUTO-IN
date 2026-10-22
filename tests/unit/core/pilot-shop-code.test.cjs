const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {derivePilotShopCode,pilotCodeHash,safeEqualPilotCodeHash,validPilotCode,
 validatePilotCandidateShape,validatePilotSubmissionShape,pilotSettingsHash,validatePilotClaimRequest,
 validatePilotGateRequest,validatePilotAgentReport}=require(path.join(root,'core/pilot-shop-code.js'));

const key=Buffer.from('synthetic-only-pilot-hmac-key-material-32-bytes-plus');
const candidate={shop_id:'shop-a',oa_id:'oa-a',customer_id:'customer-a',conversation_id:'chat-a',
 intake_batch_id:'00000000-0000-4000-8000-000000000003',order_id:'order-a',
 revision:1,request_hash:'a'.repeat(64),source:{format:'DOCX',artifact_ref:'bundle-a/source.docx',
 sha256:'b'.repeat(64),size_bytes:12,provider_event_id:'file-event-a'},
 settings:{copies:2,duplex:true,paper:'A4',color:'black_white'},settings_sha256:'c'.repeat(64),printer_id:'RMP7000'};

test('pilot code is per shop/window, fixed-length Crockford alphabet, and stored only as keyed digest',()=>{
 const a=derivePilotShopCode(key,'shop-a','00000000-0000-4000-8000-000000000001');
 const same=derivePilotShopCode(key,'shop-a','00000000-0000-4000-8000-000000000001');
 const otherShop=derivePilotShopCode(key,'shop-b','00000000-0000-4000-8000-000000000001');
 const nextWindow=derivePilotShopCode(key,'shop-a','00000000-0000-4000-8000-000000000002');
 assert.equal(a,same);assert.notEqual(a,otherShop);assert.notEqual(a,nextWindow);
 assert.equal(validPilotCode(a),true);assert.match(a,/^[0-9A-HJKMNP-TV-Z]{10}$/);
 assert.equal(validPilotCode('AB1234'),false);assert.equal(validPilotCode('O'.repeat(10)),false);
 const digest=pilotCodeHash(key,'shop-a','00000000-0000-4000-8000-000000000001',a);
 assert.equal(digest.length,32);assert.equal(digest.toString('hex').includes(a),false);
 assert.equal(safeEqualPilotCodeHash(digest,pilotCodeHash(key,'shop-a','00000000-0000-4000-8000-000000000001',a)),true);
 assert.equal(safeEqualPilotCodeHash(digest,pilotCodeHash(key,'shop-a','00000000-0000-4000-8000-000000000002',a)),false);
});

test('pilot candidate/submission contracts are exact and accept only the 10-character server code alphabet',()=>{
 const withHash={...candidate,settings_sha256:pilotSettingsHash(candidate.settings)};
 assert.deepEqual(validatePilotCandidateShape(withHash),withHash);
 assert.throws(()=>validatePilotCandidateShape({...withHash,code:'AB12345678'}),e=>e.code==='PILOT_SOURCE_NOT_VERIFIED');
 const submission={schema:'ai0.pilot_code_submission.v1',shop_id:'shop-a',oa_id:'oa-a',customer_id:'customer-a',
  conversation_id:'chat-a',intake_batch_id:candidate.intake_batch_id,order_id:'order-a',revision:1,
  provider_event_id:'code-event-a',code:'AB23456789',
  idempotency_key:'idempotency-a'};
 assert.deepEqual(validatePilotSubmissionShape(submission),submission);
 assert.throws(()=>validatePilotSubmissionShape({...submission,unexpected:'field'}),
  e=>e.code==='PILOT_SOURCE_NOT_VERIFIED');
});

test('pilot settings canonical hash keeps the locked duplex boolean and shared vector',()=>{
 assert.equal(pilotSettingsHash({color:'black_white',copies:2,duplex:true,paper:'A4'}),
  'e6ed1f13eba6750d851960ef87efb679356b36aad49c20887ac249e55162b486');
 assert.notEqual(pilotSettingsHash({color:'black_white',copies:2,duplex:false,paper:'A4'}),
  pilotSettingsHash({color:'black_white',copies:2,duplex:true,paper:'A4'}));
});

test('pilot Agent claim and gate inputs enforce the locked wire shape and source/settings/evidence tuple',()=>{
 assert.deepEqual(validatePilotClaimRequest({printer_id:'RMP7000',idempotency_key:'claim-a'}),
  {printer_id:'RMP7000',idempotency_key:'claim-a'});
 assert.throws(()=>validatePilotClaimRequest({printer_id:'RMP7000',idempotency_key:'claim-a',approval_id:'x'}),
  e=>e.code==='INVALID_INPUT');
 const gate={expected_revision:1,lease_token:'lease-a',request_hash:'a'.repeat(64),source_sha256:'b'.repeat(64),
  settings_sha256:'c'.repeat(64),evidence_sha256:'d'.repeat(64),printer_id:'RMP7000'};
 assert.deepEqual(validatePilotGateRequest(gate),gate);
 assert.throws(()=>validatePilotGateRequest({...gate,approval_id:'x'}),e=>e.code==='INVALID_INPUT');
});

test('pilot Agent report is sanitized to status evidence and DryRun requires a boolean no-driver fact',()=>{
 const report={schema:'ai0.pilot_agent_report.v1',lease_token:'lease-a',idempotency_key:'report-a',
  state:'SIMULATED_DONE',evidence:{driver_called:false,reason_code:'SIMULATED'}};
 assert.deepEqual(validatePilotAgentReport(report),report);
 assert.throws(()=>validatePilotAgentReport({...report,evidence:{driver_called:false,source_base64:'private'}}),
  e=>e.code==='INVALID_INPUT');
 assert.throws(()=>validatePilotAgentReport({...report,evidence:{driver_called:'false'}}),
  e=>e.code==='INVALID_INPUT');
});
