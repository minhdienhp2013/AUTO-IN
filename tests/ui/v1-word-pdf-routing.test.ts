import test from 'node:test';
import assert from 'node:assert/strict';
import {parseServerManualQueue,manualQueueRowsForDisplay,manualRouteLabel,routeVerifiedDocument,
  pendingStaffQueue,v1HasManualRoutingHold} from '../../web/src/v1-routing.ts';
import {canApproveAfterInboundReview} from '../../web/src/code008.ts';
import {mapCoreOrderDetail,mapOrder} from '../../web/src/api.ts';

const id='00000000-0000-4000-8000-000000000101';
const hash='a'.repeat(64);
const scope={order_id:id,revision:2,request_hash:hash};
const queue=(category:string='image')=>({order_id:id,revision:2,
  request_hash:hash,status:'received_waiting_staff',
  items:[{kind:'file',category,received_at:'2026-10-17T00:00:00.000Z'}]});
const wire=(item:unknown)=>({current:{revision:2,request_hash:hash,v1_manual_queue:item}});
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
test('staff queue labels cover image, CCCD, TEMhoa, color and unsupported',()=>{
 assert.deepEqual(['image','cccd','temhoa','color','unsupported'].map(c=>
  manualRouteLabel(c as Parameters<typeof manualRouteLabel>[0])),
  ['Ảnh','CCCD','TEMhoa','Yêu cầu in màu','Định dạng chưa hỗ trợ']);
});
test('V1 queue presentation keeps image and unsupported requests visible as waiting staff',()=>{
 const manual={...mkOrder(),detail_loaded:true,v1_manual_queue:parseServerManualQueue(wire({...queue(),items:[
  {kind:'file',category:'image',received_at:null},
  {kind:'file',category:'unsupported',received_at:null},
 ]}),scope)??undefined};
 assert.deepEqual(manualQueueRowsForDisplay(manual),[
  {label:'Ảnh',status:'Đã nhận — chờ nhân viên; chưa xác nhận xử lý hay in.'},
  {label:'Định dạng chưa hỗ trợ',status:'Đã nhận — chờ nhân viên; chưa xác nhận xử lý hay in.'},
 ]);
 assert.equal(manualQueueRowsForDisplay({...manual,revision:3}),null,
  'a queue from an older revision is not presented as current');
});
test('server-specific categories require exact bound order, revision and hash',()=>{
 const parsed=parseServerManualQueue(wire(queue('temhoa')),scope);
 assert.equal(parsed?.items[0]?.category,'temhoa');
 assert.equal(parsed?.state,'received_waiting_staff');
 assert.equal(parsed?.revision,2);
 for(const broken of [{...queue(),order_id:'other'},
  {...queue(),revision:1},{...queue(),request_hash:'b'.repeat(64)},
  {...queue(),status:'processed'},{...queue(),items:[{kind:'file',category:'pdf'}]},
  {...queue(),items:[{kind:'file',category:'CCCD'}]},
  {...queue(),items:[]},{...queue(),items:[{kind:'file',category:'image',received_at:'invalid'}]}]){
  assert.equal(parseServerManualQueue(wire(broken),scope),null);
 }
 assert.equal(parseServerManualQueue({current:{revision:1,request_hash:hash,v1_manual_queue:queue()}},scope),null);
 assert.equal(parseServerManualQueue({},scope),null);
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
 const manual={...order,v1_manual_queue:parseServerManualQueue(wire(queue('cccd')),scope)??undefined};
 assert.equal(v1HasManualRoutingHold(manual),true);
 assert.equal(canApproveAfterInboundReview(manual),false);
});
test('Core detail preserves server-bound manual queue but does not manufacture documents/preview',()=>{
 const data={order:{id,active_revision:2,shop_id:'test',customer_id:'c',
   conversation_id:'chat',manual_lock:false,print_closed:false,delivered_sheets:0,
   created_at:'2026-10-17T00:00:00.000Z'},
  revisions:[{revision:2,request_hash:hash,request_data:{}}],jobs:[],
  current:{revision:2,request_hash:hash,v1_manual_queue:queue('color'),
   pending_updates:{order_id:id,revision:2,request_hash:hash,
    status:'needs_human',unresolved_count:1,items:[{
      kind:'file',label:'Tệp tin cần đối soát',summary:'Chưa xác minh',received_at:null}]}},
  quote:null,received_vnd:0};
 const mapped=mapCoreOrderDetail(data);
 assert.equal(mapped.v1_manual_queue?.items[0].category,'color');
 assert.equal(mapped.documents.length,0);
 assert.equal(mapped.print_state,'NOT_SENT');
 assert.equal(mapped.confirmed_revision,null);
 assert.equal(canApproveAfterInboundReview(mapped),false);
 const old=mapCoreOrderDetail({...data,current:{...data.current,
   v1_manual_queue:{...queue('image'),revision:1}}});
 assert.equal(old.v1_manual_queue,undefined);
});
