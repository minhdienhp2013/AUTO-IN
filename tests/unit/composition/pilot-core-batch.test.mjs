import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPilotCoreBatchPort} from '../../../dist/backend/composition/pilot-core-batch.js';

const trusted={shop_id:'synthetic-shop',oa_id:'synthetic-oa'};
const processor={id:'synthetic-processor',shop_id:trusted.shop_id,role:'processor',verified:true};
const source={oa_id:trusted.oa_id,provider_event_id:'verified-file-event',
 artifact_ref:'doc-123456789abcdef0123456789abcdef0/source-000-'+ 'a'.repeat(64)+'.pdf'};

test('pilot Core bridge fails closed before port construction without private custody reader',()=>{
 let constructed=0;
 const service={async acceptIncomingQueueBatch(){throw new Error('must not accept');},
  createIncomingBatchPort(){constructed++;throw new Error('must not construct');}};
 assert.throws(()=>createPilotCoreBatchPort({service,trusted,processor,custody:null}),
  error=>error.code==='INCOMING_SOURCE_NOT_CONFIGURED');
 assert.equal(constructed,0);
});

test('pilot Core bridge supplies custody reader and propagates missing bytes as failure',async()=>{
 let supplied,reads=0;
 const service={async acceptIncomingQueueBatch(){return {status:'OPEN'};},
  async closeIncomingQueueBatch(input){return {status:'NEEDS_HUMAN',
   intake_batch_id:input.intake_batch_id,close_reason:input.reason};},
  createIncomingBatchPort(options){supplied=options;
  return {async apply_incoming_batch(){
   const bytes=await options.sealed_source_reader.read_sealed(source);
   if(!bytes)throw new Error('INCOMING_SOURCE_NOT_VERIFIED');
   return {status:'created',order_id:'synthetic-order',active_revision:1};
  }};
 }};
 const custody={async read_sealed(input){reads++;assert.deepEqual(input,source);return null;}};
 const port=createPilotCoreBatchPort({service,trusted,processor,custody});
 assert.equal(port.trusted_shop_id,trusted.shop_id);
 assert.equal(port.trusted_oa_id,trusted.oa_id);
 assert.deepEqual(supplied.trusted,trusted);
 assert.equal(supplied.processor,processor);
 assert.deepEqual(await port.closeIncomingQueueBatch({intake_batch_id:'synthetic-intake',
  queue_batch_id:'1',lease_token:'synthetic-lease',reason:'COLOR_PRINT'}),
  {status:'NEEDS_HUMAN',intake_batch_id:'synthetic-intake',close_reason:'COLOR_PRINT'});
 await assert.rejects(port.apply_incoming_batch({}),/INCOMING_SOURCE_NOT_VERIFIED/);
 assert.equal(reads,1);
});
