import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPilotPrivateSourcePorts} from '../../../dist/backend/composition/pilot-private-source.js';

const OA='synthetic-oa',CUSTOMER='synthetic-customer',CONVERSATION='synthetic-conversation';
const EVENT='synthetic-file-event';
const BYTES=Buffer.from('%PDF-1.7\nsynthetic public fixture\n%%EOF\n');
const SHA=createHash('sha256').update(BYTES).digest('hex');

function fakeSqlPool(){
 const sources=new Map();let inserts=0;
 return {sources,get inserts(){return inserts;},async query(sql,params=[]){
  if(sql.includes('FROM zalo_inbound_events e JOIN core_shop_zalo_oa_registry')){
   return {rows:params[0]===OA&&params[1]===EVENT
    ?[{shop_id:'synthetic-shop',customer_id:CUSTOMER,conversation_id:CONVERSATION,kind:'file'}]:[]};
  }
  if(sql.includes('SELECT * FROM ai0_pilot_private_sources')){
   const row=sources.get(`${params[0]}:${params[1]}`);
   return {rows:row?[row]:[]};
  }
  if(sql.includes('INSERT INTO ai0_pilot_private_sources')){
   inserts++;
   const [shop_id,oa_id,event_id,customer_id,conversation_id,format,artifact_ref,sha256,size_bytes]=params;
   const key=`${oa_id}:${event_id}`;
   if(sources.has(key))return {rows:[]};
   const row={shop_id,oa_id,event_id,customer_id,conversation_id,format,artifact_ref,sha256,size_bytes};
   sources.set(key,row);return {rows:[row]};
  }
  throw new Error('unexpected SQL in source-custody unit test');
 }};
}

test('private source composition captures verified synthetic bytes once and reuses hash-checked custody',async()=>{
 const db=fakeSqlPool(),root=await mkdtemp(join(tmpdir(),'ai0-private-source-'));
 const mediaCalls=[];
 try{
  const ports=createPilotPrivateSourcePorts(db,root,{async read_verified(input){
   mediaCalls.push(structuredClone(input));
   return {oa_id:OA,customer_id:CUSTOMER,conversation_id:CONVERSATION,
    provider_event_id:EVENT,bytes:new Uint8Array(BYTES)};
  }});
  const scope={oa_id:OA,customer_id:CUSTOMER,conversation_id:CONVERSATION,provider_event_id:EVENT};
  const first=await ports.source_capture.ensure_sealed_source(scope);
  assert.ok(first);
  assert.match(first.artifact_ref,/^doc-[a-f0-9]{32}\/source-000-[a-f0-9]{64}\.pdf$/);
  assert.deepEqual(first,{schema:'ai0.pilot_sealed_source.v1',...scope,format:'PDF',
   artifact_ref:`${first.artifact_ref.split('/')[0]}/source-000-${SHA}.pdf`,sha256:SHA,size_bytes:BYTES.length});
  assert.deepEqual(mediaCalls,[{oa_id:OA,provider_event_id:EVENT}]);
  assert.equal(db.inserts,1);
  const second=await ports.source_capture.ensure_sealed_source(scope);
  assert.deepEqual(second,first);
  assert.equal(mediaCalls.length,1,'a replay must read private custody rather than retrieve media again');
  assert.equal(db.inserts,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('private source composition stays closed without media or when verified bytes mismatch event scope',async()=>{
 const scope={oa_id:OA,customer_id:CUSTOMER,conversation_id:CONVERSATION,provider_event_id:EVENT};
 const noMediaDb=fakeSqlPool(),noMediaRoot=await mkdtemp(join(tmpdir(),'ai0-private-source-off-'));
 try{
  const ports=createPilotPrivateSourcePorts(noMediaDb,noMediaRoot);
  assert.equal(await ports.source_capture.ensure_sealed_source(scope),null);
  assert.equal(noMediaDb.inserts,0);
 }finally{await rm(noMediaRoot,{recursive:true,force:true});}

 for(const mismatch of [
  {customer_id:'foreign-customer'},
  {conversation_id:'foreign-conversation'},
  {provider_event_id:'different-event'}
 ]){
  const db=fakeSqlPool(),root=await mkdtemp(join(tmpdir(),'ai0-private-source-mismatch-'));
  try{
   const ports=createPilotPrivateSourcePorts(db,root,{async read_verified(){
    return {oa_id:OA,customer_id:CUSTOMER,conversation_id:CONVERSATION,
     provider_event_id:EVENT,bytes:new Uint8Array(BYTES),...mismatch};
   }});
   assert.equal(await ports.source_capture.ensure_sealed_source(scope),null,
    'scope or event mismatch must not be written to private custody');
   assert.equal(db.inserts,0);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});
