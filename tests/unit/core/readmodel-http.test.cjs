const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {OrderService}=require(path.join(root,'core/service.js'));
const {registerCoreRoutes}=require(path.join(root,'api/routes.js'));

const staff={id:'staff1',role:'staff',shop_id:'shop-test',verified:true};
function mockReadModel(mode, previewVerified, artifactPreview, manualEvidence=false){
 const requestHash='a'.repeat(64);
 const plan={ready:true,request_hash:requestHash,physical_sheets:5,
  document_pages:5,printed_faces:5,printer_id:'RMP7000',
  artifact_ref:'artifact/authorized',verified_by:'processor',
  preview_verified:previewVerified,preview_ref:artifactPreview};
 const order={id:'order1',shop_id:staff.shop_id,active_revision:2,
  customer_id:'customer1',conversation_id:null,manual_lock:false,
  print_closed:false,delivered_sheets:'0'};
 const job={id:'job1',order_id:'order1',revision:2,request_hash:requestHash,
  approval_id:'approval1',printer_id:'RMP7000',state:'VERIFIED_DONE',
  verified_sheets:'5',mode_at_send:mode,cancelled_at:null};
 const db={query:async sql=>{
  // Non-Zalo unit fixture: verify pending read model fails closed only for an OA-linked order.
  if(sql.startsWith('SELECT to_regclass(')){
   if(sql.includes('core_shop_zalo_oa_registry'))return {rows:[{
    registry:'core_shop_zalo_oa_registry',quarantine:'zalo_official_quarantine',
    scopes:'zalo_official_quarantine_scopes'}]};
   return {rows:[manualEvidence?
    {proposals:'core_ai_draft_proposals',audit:'core_audit',
     users:'core_users',revisions:'core_revisions'}:{proposals:null,events:null,reviews:null}]};
  }
  if(sql.includes('FROM public.zalo_official_quarantine q'))return {rows:[{n:0}]};
  if(sql.startsWith('SELECT (SELECT count(*)::int FROM core_ai_draft_proposals'))
   return {rows:[{proposal_count:0,staff_creates:1,
    initial_data:{files:[]},current_data:{files:[]},request_hash:requestHash}]};
  if(sql.startsWith('SELECT * FROM core_revisions'))return {rows:[{revision:2,request_hash:requestHash,request_data:{},plan}]};
  if(sql.startsWith('SELECT id,order_id,revision,request_hash,approval_id,state'))return {rows:[job]};
  if(sql.startsWith('SELECT * FROM core_quotes'))return {rows:[]};
  if(sql.startsWith('SELECT id,revision,request_hash,quote_revision,kind'))return {rows:[{id:'confirmation1',revision:2,
   request_hash:requestHash,kind:'request',customer_id:'customer1',created_at:new Date()}]};
  if(sql.startsWith('SELECT id,revision,request_hash,quote_revision,actor_id'))return {rows:[{id:'approval1',revision:2,
   request_hash:requestHash,actor_id:staff.id,deposit_short_vnd:'0'}]};
  throw Error('unexpected SQL in read model: '+sql);
 }};
 const store={
  tx:async fn=>fn(db),
  one:async (_db,sql)=>{
   if(sql.startsWith('SELECT * FROM core_orders'))return order;
   if(sql.startsWith('SELECT COALESCE(SUM(CASE'))return {amount:'0'};
   throw Error('unexpected one SQL: '+sql);
  }
 };
 return new OrderService(store);
}
test('read model never counts legacy/null-mode print as verified physical paper',async()=>{
 const view=await mockReadModel(null,true,'preview/private').getOrder(staff,'order1');
 assert.equal(view.current.staff_approved,true);
 assert.equal(view.current.pending_updates.status,'needs_human',
  'missing staff audit/schema must never become clear solely from null conversation');
 assert.equal(view.current.pending_updates.unresolved_count,0);
 assert.equal(view.current.verified_plan.physical_sheets,5);
 assert.equal(view.current.preview_ref,'preview/private');
 assert.equal(view.jobs[0].paper_complete,false);
 assert.equal(view.print_progress.verified_sheets,0);
 assert.equal(view.print_progress.missing_sheets,5);
 assert.equal(view.print_progress.fully_verified,false);
});
test('read model counts controlled-test physical evidence, not fabricated previews',async()=>{
 const view=await mockReadModel('controlled_test',false,'preview/unverified').getOrder(staff,'order1');
 assert.equal(view.current.preview_ref,null);
 assert.equal(view.jobs[0].paper_complete,true);
 assert.equal(view.print_progress.verified_sheets,5);
 assert.equal(view.print_progress.fully_verified,true);
});
test('API route rejects non-object bodies before invoking core mutations',async()=>{
 const paths=new Map();
 const app={get:(route,handler)=>paths.set('GET '+route,handler),
  post:(route,handler)=>paths.set('POST '+route,handler)};
 let called=false;
 const dependencies={
  auth:{principal:async()=>staff,login:async()=>{called=true;return {token:'t'};},logout:async()=>{}},
  service:{createDraft:async()=>{called=true;return {order_id:'x'};}},
  resolveVerifiedCustomer:async()=>staff,resolvePrintAgent:async()=>staff
 };
 registerCoreRoutes(app,dependencies);
 async function request(url,body){
  let status=200,response;
  const reply={code(n){status=n;return this;},send(value){response=value;return value;}};
  response=await paths.get('POST '+url)({headers:{authorization:'Bearer test'},body},reply);
  return {status,response};
 }
 const badOrder=await request('/api/v1/orders',null);
 assert.equal(badOrder.status,422);
 assert.equal(badOrder.response.error.code,'INVALID_INPUT');
 const badLogin=await request('/api/v1/auth/login',{shop_id:'shop-test',username:'staff'});
 assert.equal(badLogin.status,422);
 assert.equal(badLogin.response.error.code,'INVALID_INPUT');
 assert.equal(called,false);
});

test('verified staff non-Zalo order reports lower-case clear in existing order detail API',async()=>{
 const view=await mockReadModel('controlled_test',true,'preview/manual',true).getOrder(staff,'order1');
 assert.deepEqual(view.current.pending_updates,{
  order_id:'order1',revision:2,request_hash:'a'.repeat(64),
  status:'clear',unresolved_count:0,items:[]
 });
});
