import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationProcessor} from '../../../backend/conversation/processor.ts';
import {interpretByRules} from '../../../backend/conversation/rules.ts';
import {MessageBatcher,FixtureBatchStore,batchKey} from '../../../backend/conversation/batch.ts';
import {scheduleDecision} from '../../../backend/conversation/schedule.ts';
import {OutboundDispatcher} from '../../../backend/conversation/gate.ts';
import {ZaloIngress,SyntheticTestVerifier,SyntheticFixtureNormalizer} from '../../../backend/integrations/zalo/protocol.ts';

const when='2026-10-17T14:00:00Z';
const ev=(id,kind='file',opts={})=>({
  event_id:id,kind,oa_id:'oa-v1',customer_id:'customer-v1',
  conversation_id:'chat-v1',occurred_at:when,
  ...(kind==='file'||kind==='image'?{file_ref:'synthetic:'+id}:{}),...opts,
});
const batch=(...events)=>({key:'synthetic-v1',first_at:0,deadline_at:60000,events});
function harness(inspect=async batch=>batch.events.filter(e=>e.kind==='file'||e.kind==='image')
 .map(()=>({kind:'pdf',preview_trusted:true}))){
  const events=[],replies=[],routes=[],writes=[],gateReads=[];
  let mode='AI',generation=7,inspections=0;
  const gate={async read(id){
    gateReads.push(id);return {conversation_id:id,mode,generation};
  }};
  const doc={async inspect(value){inspections++;return inspect(value)}};
  const orders={
    async apply_incoming_batch(value){
      writes.push(value);return {status:'created',order_id:'order-synthetic'};
    },
    async suggest_draft(){assert.fail('legacy path should not be entered')},
    async route_human(value){routes.push(value);return {status:'routed',generation:generation+1}}
  };
  const processor=new ConversationProcessor(gate,doc,orders,
    {async enqueue(value){replies.push(value)}});
  return {processor,events,replies,routes,writes,gateReads,
    inspections:()=>inspections,
    handover(){mode='HUMAN';generation++;},
    returnToAi(){mode='AI';generation++;}};
}
test('V1 Word/PDF trusted facts preserve shop/OA/chat scope and require confirmation',async()=>{
 for(const kind of ['pdf','word']){
  const h=harness(async()=>[{kind,preview_trusted:true}]);
  const file=ev('source-'+kind,'file',{
    filename:kind==='pdf'?'abc.pdf':'abc.docx',
    mime_type:kind==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });
  assert.equal(await h.processor.consume(batch(file)),'processed');
  assert.equal(h.writes.length,1);
  assert.deepEqual(h.writes[0].scope,{
    oa_id:'oa-v1',customer_id:'customer-v1',conversation_id:'chat-v1'});
  assert.deepEqual(h.writes[0].changes,['attachment']);
  assert.equal(h.routes.length,0);
  assert.match(h.replies[0].text,/xác nhận/);
  assert.doesNotMatch(h.replies[0].text,/đã duyệt|đã in|giá.*đồng/);
 }
});
test('V1 images stay staff-only and NEVER reach OCR/facts, AI, order or print',async()=>{
 for(const event of [
   ev('image-event','image',{mime_type:'image/jpeg'}),
   ev('image-mime','file',{mime_type:'image/png',filename:'scan.pdf'}),
 ]){
  const h=harness(async()=>{assert.fail('image should not be inspected')});
  assert.equal(await h.processor.consume(batch(event)),'human');
  assert.equal(h.routes[0].reason,'IMAGE_V1');
  assert.equal(h.inspections(),0);assert.equal(h.writes.length,0);
 }
});
test('V1 photo routing is bound to the durable event and makes no automatic-processing claim',async()=>{
 for(const [id,kind,attrs] of [
  ['photo-text','image',{filename:'photo-text.jpg',mime_type:'image/jpeg'}],
  ['cccd','file',{filename:'cccd-front.png',mime_type:'image/png'}],
  ['temhoa','file',{filename:'temhoa-request.webp',mime_type:'image/webp'}],
  // A misleading document suffix must not let an image enter Word/PDF preflight.
  ['photo-disguised','file',{filename:'photo.docx',mime_type:'image/jpeg'}],
 ]){
  const h=harness(async()=>{assert.fail('manual image routing must bypass document preflight')});
  const file=ev(id,kind,{...attrs,file_ref:'sealed:'+id});
  assert.equal(await h.processor.consume(batch(file)),'human');
  assert.deepEqual(h.routes.map(route=>route.reason),['IMAGE_V1']);
  // Bind handover to the source event; do not synthesize a draft/order,
  // confirmation, preview, or outbound message from an image.
  assert.deepEqual(h.routes[0].event_ids,[id]);
  assert.equal(h.inspections(),0);
  assert.equal(h.writes.length,0);
  assert.equal(h.replies.length,0);
 }
});
test('V1 unknown/Excel/ZIP unsupported or ambiguous always route staff',async()=>{
 for(const [fact,reason] of [
  [{kind:'excel',preview_trusted:true},'EXCEL'],
  [{kind:'unknown',preview_trusted:true},'UNSUPPORTED_FILE'],
  [{kind:'zip',count_inside:1,preview_trusted:true},'ZIP_V1'],
  [{kind:'zip'},'NEEDS_CLARIFICATION'],
  [{kind:'word',preview_trusted:false},'UNREADABLE'],
  [{kind:'pdf'},'UNREADABLE'],
 ]){
  const h=harness(async()=>[fact]);
  assert.equal(await h.processor.consume(batch(ev('f'))),'human');
  assert.equal(h.routes[0].reason,reason);
  assert.equal(h.writes.length,0);
 }
});
test('V1 ZIP/Excel filename or MIME hints may escalate but never approve formats',async()=>{
 for(const [attrs,reason] of [
  [{filename:'archive.zip',mime_type:'application/octet-stream'},'ZIP_V1'],
  [{filename:'orders.xlsx',mime_type:'application/octet-stream'},'EXCEL'],
  [{filename:'unknown.data',mime_type:'application/vnd.ms-excel'},'EXCEL'],
 ]){
  const h=harness(async()=>{assert.fail('obvious unsupported file must not consume preflight')});
  assert.equal(await h.processor.consume(batch(ev('f','file',attrs))),'human');
  assert.equal(h.routes[0].reason,reason);
  assert.equal(h.writes.length,0);
 }
});
test('V1 >5 independent PDF/Word files or >5 items inside ZIP => staff review',async()=>{
 const many=Array.from({length:6},(_,i)=>ev('file'+i));
 const h=harness(async()=>{assert.fail('>5 files do not require PDF processing')});
 assert.equal(await h.processor.consume(batch(...many)),'human');
 assert.equal(h.routes[0].reason,'TOO_MANY_DOCUMENTS');
 assert.equal(h.writes.length,0);
 const decision=interpretByRules([ev('text','text',{text:'in'})],
   [{kind:'zip',count_inside:6,preview_trusted:true}]);
 assert.equal(decision.handover_reason,'TOO_MANY_DOCUMENTS');
});
test('V1 missing/mismatched document facts and download failures escalate, no draft',async()=>{
 for(const inspect of [
   async()=>[],
   async()=>[{kind:'pdf',preview_trusted:false}],
   async()=>{throw Error('PRIVATE DOWNLOAD URL OR FILE NAME')},
 ]){
  const h=harness(inspect);
  assert.equal(await h.processor.consume(batch(ev('f'))),'human');
  assert.ok(['UNREADABLE','DOWNLOAD_FAILED'].includes(h.routes[0].reason));
  assert.equal(h.writes.length,0);
  assert.ok(!JSON.stringify(h.replies).includes('PRIVATE DOWNLOAD'));
 }
});
test('V1 repeated file_ref different event IDs must not double-append or silently drop',async()=>{
 const h=harness(),a=ev('one','file',{file_ref:'sealed:same-sha'});
 const b=ev('two','file',{file_ref:'sealed:same-sha'});
 assert.equal(await h.processor.consume(batch(a,b)),'human');
 assert.equal(h.routes[0].reason,'DUPLICATE_FILE');
 assert.deepEqual(h.routes[0].event_ids,['one','two']);
 assert.equal(h.inspections(),0);
 assert.equal(h.writes.length,0);
 const other=harness();
 assert.equal(await other.processor.consume(batch(a,{...a})),'held');
 assert.equal(other.writes.length,0);assert.equal(other.routes.length,0);
});
test('V1 deterministic idempotency for same persisted Word file event on replays',async()=>{
 const seen=new Set();let revisions=0;
 const h=harness(async()=>[{kind:'word',preview_trusted:true}]);
 // Same source event identity persists; idempotency keys must match every replay.
 const first=ev('word-one','file',{file_ref:'sealed:word-one'});
 await h.processor.consume(batch(first));
 await h.processor.consume(batch(first));
 assert.equal(h.writes.length,2);
 assert.equal(h.writes[0].idempotency_key,h.writes[1].idempotency_key);
 for(const item of h.writes){if(!seen.has(item.idempotency_key)){seen.add(item.idempotency_key);revisions++}}
 assert.equal(revisions,1);
});
test('V1 synthetic ingress duplicate webhook persisted once per OA/event ID',async()=>{
 const rows=new Set();let queueMarkers=0;
 const ingress=new ZaloIngress(new SyntheticTestVerifier('synthetic-v1-secret'),
   new SyntheticFixtureNormalizer(),{async insert_once(event){
     const key=JSON.stringify([event.oa_id,event.event_id]);
     if(rows.has(key))return 'duplicate';
     rows.add(key);queueMarkers++;return 'inserted';
   }});
 const raw=new TextEncoder().encode(JSON.stringify({synthetic_fixture:true,...ev('pdf-one','file',{
   filename:'notice.pdf',mime_type:'application/pdf'})}));
 const headers={'x-test-fixture-key':'synthetic-v1-secret'};
 assert.equal((await ingress.receive(raw,headers)).status,'accepted');
 assert.equal((await ingress.receive(raw,headers)).status,'duplicate');
 assert.equal(rows.size,1);assert.equal(queueMarkers,1);
});
test('V1 after-hours stores files in batch, no provider delivery; 60s then 10s unchanged',async()=>{
 let now=0;const storage=new FixtureBatchStore(),m=new MessageBatcher(storage,{now:()=>now});
 const a=ev('file-first'),b=ev('file-second','file',{file_ref:'sealed:second'});
 let state=await m.add(a);assert.equal(state.deadline_at,60000);
 now=15000;state=await m.add(b);assert.equal(state.deadline_at,25000);
 assert.equal(state.events.length,2);
 const different={...a,event_id:'other-shop',oa_id:'oa-other'};
 await m.add(different);
 const received=await storage.get(batchKey(a));
 assert.equal(received.events.length,2);
 const holidayOverride={paused:false,overrides:{
   '2026-10-17':{date:'2026-10-17',open:'07:00',close:'21:30',shop_holiday:true}}};
 const at=new Date('2026-10-17T16:00:00Z'); // 23:00 Vietnam
 assert.equal(scheduleDecision(at,holidayOverride).ai_allowed,false);
 let sent=0,marked=[];
 const dispatcher=new OutboundDispatcher({async read(){return {conversation_id:'chat-v1',generation:7,mode:'AI'}}},
   {async reserve_if_current(){assert.fail('outside-hours should not reserve')},
    async mark(_id,status){marked.push(status)}},
   {async send_text(){sent++}}, {now:()=>at},
   {allowed:dt=>scheduleDecision(dt,holidayOverride).ai_allowed});
 assert.equal(await dispatcher.deliver({outbound_id:'synthetic-outbound',
   conversation_id:'chat-v1',generation:7,text:'synthetic-only'}),'blocked');
 assert.deepEqual(marked,['CANCELLED']);assert.equal(sent,0);
 const paused={...holidayOverride,paused:true};
 assert.equal(scheduleDecision(new Date('2026-10-17T06:00:00Z'),paused).ai_allowed,false);
});
test('V1 handover before document inspection completion prevents automatic business effects',async()=>{
 let resume;
 const entered=new Promise(resolve=>{resume=resolve});
 let leave;
 const stop=new Promise(resolve=>{leave=resolve});
 const h=harness(async()=>{resume();await stop;return [{kind:'pdf',preview_trusted:true}]});
 const pending=h.processor.consume(batch(ev('f')));
 await entered;h.handover();leave();
 assert.equal(await pending,'held');
 assert.equal(h.writes.length,0);assert.equal(h.replies.length,0);
});
