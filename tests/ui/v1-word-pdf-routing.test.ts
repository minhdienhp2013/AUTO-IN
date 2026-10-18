import test from 'node:test';
import assert from 'node:assert/strict';
import {routeVerifiedDocument,pendingStaffQueue} from '../../web/src/v1-routing.ts';
import {canApproveAfterInboundReview} from '../../web/src/code008.ts';
import {mapCoreOrderDetail,mapOrder} from '../../web/src/api.ts';

const id='00000000-0000-4000-8000-000000000101';
const hash='a'.repeat(64);
const mkOrder=()=>mapOrder({order_id:id,revision:2,request_hash:hash,
  order_state:'confirmed',confirmed_revision:2,print_state:'NOT_SENT',
  documents:[{document_id:'synthetic-doc',filename:'synthetic.docx',format:'DOCX',
  pages:2,printed_faces:2,physical_sheets:2,preview_trusted:true}],
  detail_loaded:true});

test('Word DOCX and PDF are only format labels from authenticated preview facts',()=>{
 assert.equal(routeVerifiedDocument({format:'DOCX'}),'word');
 assert.equal(routeVerifiedDocument({format:'pdf'}),'pdf');
 for(const f of ['PNG','JPEG','DOC','ZIP','TIFF','XLSX','unknown'])
  assert.equal(routeVerifiedDocument({format:f}),'staff_only');
});
test('scoped backend needs_human with pending file is only generic waiting staff, no category guess',()=>{
 const order={...mkOrder(),detail_loaded:true,pending_updates:{
  state:'needs_human' as const,unresolved_count:2,
  items:[{kind:'file' as const,label:'Tệp tin cần đối soát',
  summary:'Metadata tổng hợp',received_at:null}]}};
 assert.deepEqual(pendingStaffQueue(order),{count:2,listed:1});
 assert.equal(pendingStaffQueue({...order,pending_updates:{...order.pending_updates,state:'processing'}}),null);
 assert.equal(pendingStaffQueue({...order,detail_loaded:false}),null);
 assert.equal(pendingStaffQueue({...order,pending_updates:{...order.pending_updates,unresolved_count:0,items:[]}}),null);
});
test('routing does not forge customer consent, printer success, or approval authority',()=>{
 const order=mkOrder();
 assert.equal(canApproveAfterInboundReview(order),false);
 assert.equal(order.confirmed_revision,2);
 assert.equal(order.print_state,'NOT_SENT');
});
test('Core detail preserves scoped generic pending data without manufacturing categories',()=>{
 const data={order:{id,active_revision:2,shop_id:'test',customer_id:'c',
   conversation_id:'chat',manual_lock:false,print_closed:false,delivered_sheets:0,
   created_at:'2026-10-17T00:00:00.000Z'},
  revisions:[{revision:2,request_hash:hash,request_data:{}}],jobs:[],
  current:{revision:2,request_hash:hash,
   pending_updates:{order_id:id,revision:2,request_hash:hash,
    status:'needs_human',unresolved_count:1,items:[{
      kind:'file',label:'Tệp tin cần đối soát',summary:'Chưa xác minh',received_at:null}]}},
  quote:null,received_vnd:0};
 const mapped=mapCoreOrderDetail(data);
 assert.deepEqual(pendingStaffQueue(mapped),{count:1,listed:1});
 assert.equal(mapped.documents.length,0);
 assert.equal(mapped.print_state,'NOT_SENT');
 assert.equal(mapped.confirmed_revision,null);
 assert.equal(canApproveAfterInboundReview(mapped),false);
 assert.throws(()=>mapCoreOrderDetail({...data,current:{...data.current,
   revision:1}}),{code:'INVALID_CURRENT_REVISION'});
});
