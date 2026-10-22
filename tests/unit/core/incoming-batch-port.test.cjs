const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {createIncomingBatchPort}=require(path.join(root,'core/incoming-batch-port.js'));

const valid={scope:{oa_id:'oa-test',customer_id:'customer-test',conversation_id:'chat-test'},
 queue_batch_id:'41',lease_token:'00000000-0000-4000-8000-000000000041',
 intake_batch_id:'00000000-0000-4000-8000-000000000042',purpose:'PILOT',expected_generation:0,
 event_ids:['file-event'],text:'server parsed request',idempotency_key:'pilot-key',intent:'append_or_create',
 changes:['attachment','copies','paper','duplex'],
 pilot_settings:{copies:2,duplex:true,paper:'A4',color:'black_white'}};

test('PILOT apply validates settings and rejects caller-provided artifact, digest, or locator fields before DB access',async()=>{
 let transactions=0;
 const port=createIncomingBatchPort({store:{async tx(){transactions++;throw new Error('DB must not be reached');}},
  trusted:{shop_id:'shop-test',oa_id:'oa-test'},processor:{id:'processor-test',shop_id:'shop-test',role:'processor',verified:true}});
 await assert.rejects(port.apply_incoming_batch({...valid,pilot_settings:{...valid.pilot_settings,copies:0}}),
  error=>error.code==='INVALID_INCOMING_PILOT_SETTINGS');
 for(const field of ['artifact_name','source_sha256','artifact_ref','source_path','source_url'])
  await assert.rejects(port.apply_incoming_batch({...valid,[field]:'caller-controlled'}),
   error=>error.code==='INVALID_INCOMING_BATCH');
 await assert.rejects(port.apply_incoming_batch({...valid,purpose:'ORDER'}),
  error=>error.code==='INVALID_INCOMING_PILOT_SETTINGS');
 assert.equal(transactions,0);
});
