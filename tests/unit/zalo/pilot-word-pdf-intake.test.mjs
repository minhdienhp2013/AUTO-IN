import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPilotWordPdfIntakeAdapter} from '../../../backend/conversation/pilot-word-pdf-intake.ts';

const scope={shop_id:'shop-synthetic',oa_id:'oa-synthetic',customer_id:'customer-synthetic',
  conversation_id:'conversation-synthetic'};
const pdf=Buffer.from('%PDF-1.7\nsynthetic public fixture\n%%EOF\n');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const settingsHash=settings=>digest(Buffer.from(JSON.stringify({color:settings.color,copies:settings.copies,
  duplex:settings.duplex,paper:settings.paper}),'utf8'));
const event=(event_id,kind,text)=>({event_id,...scope,occurred_at:'2026-10-21T03:00:00.000Z',kind,...(text?{text}:{})});
const events=[
  event('file-1','file'),
  event('settings-1','text','In 2 bản A4, 2 mặt, đen trắng.'),
  event('code-1','text','Mã cửa hàng: ABCDEFGHJK')
];

function fixture({tamperReadback=false,candidate=true,candidateMutator=value=>value,
  eventReader=null}={}){
  const stored=new Map(),calls={register:[],authorize:[]};
  const ports={
    async read_verified_events({event_ids}){
      if(eventReader)return eventReader(event_ids);
      return event_ids.map(id=>events.find(item=>item.event_id===id)).filter(Boolean);
    },
    media:{async read_verified(input){
      return input.provider_event_id==='file-1'?{...scope,provider_event_id:'file-1',bytes:new Uint8Array(pdf)}:null;
    }},
    custody:{
      async seal(input){
        stored.set(input.provider_event_id,new Uint8Array(input.bytes));
        return {schema:'ai0.pilot_sealed_source.v1',...scope,provider_event_id:input.provider_event_id,
          format:input.format,artifact_ref:`doc-synth01/source-000-${input.sha256}.pdf`,
          sha256:input.sha256,size_bytes:input.size_bytes};
      },
      async read_sealed({provider_event_id}){
        const bytes=stored.get(provider_event_id);
        if(!bytes)return null;
        return tamperReadback?new Uint8Array([...bytes,0x58]):new Uint8Array(bytes);
      }
    },
    candidate_binding:{async bind(input){
      if(!candidate)return null;
      return candidateMutator({...scope,order_id:'order-synthetic',revision:1,request_hash:'a'.repeat(64),
        source:{format:input.source.format,artifact_ref:input.source.artifact_ref,
          sha256:input.source.sha256,size_bytes:input.source.size_bytes,
          provider_event_id:input.source.provider_event_id},settings:input.settings,
        settings_sha256:settingsHash(input.settings),printer_id:'printer-synthetic'});
    }},
    core:{
      async registerPilotCandidate(value){calls.register.push(value);return {status:'WAITING_FOR_CODE'};},
      async authorizePilotPrint(value){calls.authorize.push(value);return {status:'AUTHORIZED'};}
    }
  };
  const intake=createPilotWordPdfIntakeAdapter({trusted_shop_id:scope.shop_id,trusted_oa_id:scope.oa_id,ports});
  return {intake,calls,stored,ports};
}

test('verified synthetic event batch seals bytes, binds exact candidate, and calls Core ports',async()=>{
  const h=fixture();
  const result=await h.intake.processVerifiedEvents({event_ids:events.map(e=>e.event_id),source_event_id:'file-1'});
  assert.deepEqual(result,{status:'AUTHORIZED',candidate_registered:true,authorization_attempted:true});
  assert.equal(h.calls.register.length,1);
  assert.equal(h.calls.authorize.length,1);
  const candidate=h.calls.register[0];
  assert.equal(candidate.source.sha256,digest(pdf));
  assert.equal(candidate.source.size_bytes,pdf.length);
  assert.equal(candidate.source.format,'PDF');
  assert.equal(candidate.source.provider_event_id,'file-1');
  assert.equal(candidate.settings.copies,2);
  assert.equal(candidate.settings.duplex,true);
  const submission=h.calls.authorize[0];
  assert.equal(submission.provider_event_id,'code-1');
  assert.equal(submission.code,'ABCDEFGHJK');
  assert.equal(submission.order_id,'order-synthetic');
  assert.equal(submission.revision,1);
  assert.equal(JSON.stringify(result).includes(submission.code),false);
});

test('multiple file inputs or an image in the same batch fail closed before Core writes',async()=>{
  const extraFile=event('file-2','file');
  const fileBatch=[...events,extraFile];
  const multipleFiles=fixture({eventReader(ids){
    return ids.map(id=>fileBatch.find(item=>item.event_id===id)).filter(Boolean);
  }});
  const multipleResult=await multipleFiles.intake.processVerifiedEvents({
    event_ids:fileBatch.map(item=>item.event_id),source_event_id:'file-1'});
  assert.deepEqual(multipleResult,{status:'NEEDS_HUMAN',
    reason:'MULTIPLE_OR_UNSUPPORTED_INPUT_EVENTS',candidate_registered:false,authorization_attempted:false});
  assert.equal(multipleFiles.calls.register.length,0);
  assert.equal(multipleFiles.calls.authorize.length,0);
  assert.equal(multipleFiles.stored.size,0);

  const image=event('image-1','image');
  const imageBatch=[...events,image];
  const withImage=fixture({eventReader(ids){
    return ids.map(id=>imageBatch.find(item=>item.event_id===id)).filter(Boolean);
  }});
  const imageResult=await withImage.intake.processVerifiedEvents({
    event_ids:imageBatch.map(item=>item.event_id),source_event_id:'file-1'});
  assert.deepEqual(imageResult,{status:'NEEDS_HUMAN',
    reason:'MULTIPLE_OR_UNSUPPORTED_INPUT_EVENTS',candidate_registered:false,authorization_attempted:false});
  assert.equal(withImage.calls.register.length,0);
  assert.equal(withImage.calls.authorize.length,0);
  assert.equal(withImage.stored.size,0);
});

test('unsealed or mutated bytes fail closed before either Core write',async()=>{
  const h=fixture({tamperReadback:true});
  const result=await h.intake.processVerifiedEvents({event_ids:events.map(e=>e.event_id),source_event_id:'file-1'});
  assert.equal(result.status,'NEEDS_HUMAN');
  assert.equal(result.reason,'SOURCE_CUSTODY_READBACK_MISMATCH');
  assert.equal(h.calls.register.length,0);
  assert.equal(h.calls.authorize.length,0);
});

test('wrong event scope and source bytes that are not PDF/DOCX never reach Core',async()=>{
  const h=fixture();
  const wrong=await h.intake.processVerifiedEvents({event_ids:['file-1','wrong-text'],source_event_id:'file-1'});
  assert.equal(wrong.status,'NEEDS_HUMAN');
  assert.equal(h.calls.register.length,0);
  const badPorts={
      async read_verified_events({event_ids}){return event_ids.map(id=>events.find(item=>item.event_id===id)).filter(Boolean);},
      media:{async read_verified(){return {...scope,provider_event_id:'file-1',bytes:Buffer.from('not a document')};}},
      custody:{async seal(){throw new Error('must not store unsupported source');},async read_sealed(){return null;}},
      candidate_binding:{async bind(){throw new Error('must not bind unsupported source');}},
      core:{async registerPilotCandidate(){throw new Error('must not call Core');},async authorizePilotPrint(){throw new Error('must not call Core');}}
  };
  const bad=createPilotWordPdfIntakeAdapter({trusted_shop_id:scope.shop_id,trusted_oa_id:scope.oa_id,ports:badPorts});
  const result=await bad.processVerifiedEvents({event_ids:events.map(e=>e.event_id),source_event_id:'file-1'});
  assert.equal(result.reason,'UNSUPPORTED_SOURCE_BYTES');
});

test('durable event order and candidate source hash/ref must match before Core calls',async()=>{
  const reordered=fixture({eventReader(ids){
    return ids.map(id=>events.find(item=>item.event_id===id)).filter(Boolean).reverse();
  }});
  const orderResult=await reordered.intake.processVerifiedEvents({
    event_ids:events.map(e=>e.event_id),source_event_id:'file-1'});
  assert.equal(orderResult.reason,'VERIFIED_EVENTS_UNAVAILABLE');
  assert.equal(reordered.calls.register.length,0);

  const badRef=fixture({candidateMutator(value){
    return {...value,source:{...value.source,artifact_ref:`doc-synth01/source-000-${'b'.repeat(64)}.pdf`}};
  }});
  const refResult=await badRef.intake.processVerifiedEvents({
    event_ids:events.map(e=>e.event_id),source_event_id:'file-1'});
  assert.equal(refResult.reason,'CORE_CANDIDATE_BINDING_MISMATCH');
  assert.equal(badRef.calls.register.length,0);

  const badHash=fixture({candidateMutator(value){
    return {...value,source:{...value.source,sha256:'c'.repeat(64)}};
  }});
  const hashResult=await badHash.intake.processVerifiedEvents({
    event_ids:events.map(e=>e.event_id),source_event_id:'file-1'});
  assert.equal(hashResult.reason,'CORE_CANDIDATE_BINDING_MISMATCH');
  assert.equal(badHash.calls.register.length,0);
  assert.equal(badHash.calls.authorize.length,0);
});

test('invalid code never reaches authorize even when a source candidate is registered',async()=>{
  const h=fixture();
  const altered=events.map(item=>item.event_id==='code-1'?{...item,text:'Mã: ABCDEFGHIJ'}:item);
  const intake=createPilotWordPdfIntakeAdapter({trusted_shop_id:scope.shop_id,trusted_oa_id:scope.oa_id,
    ports:{...h.ports,
      async read_verified_events({event_ids}){return event_ids.map(id=>altered.find(item=>item.event_id===id)).filter(Boolean);}
    }});
  const result=await intake.processVerifiedEvents({event_ids:events.map(e=>e.event_id),source_event_id:'file-1'});
  assert.equal(result.status,'WAITING_FOR_CODE');
  assert.equal(result.candidate_registered,true);
  assert.equal(result.authorization_attempted,false);
  assert.equal(h.calls.register.length,1);
  assert.equal(h.calls.authorize.length,0);
  assert.equal(JSON.stringify(result).includes('ABCDEFGHIJ'),false);
});
