const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {registerCoreRoutes}=require(path.join(root,'api/routes.js'));
const {DomainError}=require(path.join(root,'core/model.js'));
const {AuthService}=require(path.join(root,'core/auth.js'));
const {createInboundReviewReader}=require(path.join(root,'core/inbound-review-items.js'));
const routePath='/api/v1/inbound-review-items';
const row=(id,sha)=>({source:'quarantine',id,kind:'image',status:'NEEDS_HUMAN',media_state:'AWAITING_MEDIA',raw_event_sha256:sha.repeat(64),received_at:'2026-10-18T00:00:00.000Z',mapped_customer:false});
const colorIntake={source:'pilot_intake',id:'123e4567-e89b-42d3-a456-426614174010',kind:'pilot_intake',
 status:'NEEDS_HUMAN',received_at:'2026-10-18T00:01:00.000Z',reason_code:'COLOR_PRINT'};
const genericIntake={source:'pilot_intake',id:'123e4567-e89b-42d3-a456-426614174011',kind:'pilot_intake',
 status:'NEEDS_HUMAN',received_at:'2026-10-18T00:02:00.000Z'};

function setup(){
 const routes=new Map(),calls=[];
 const principals={tokenA:{id:'staff-a',shop_id:'shop-a',role:'staff',verified:true},tokenB:{id:'staff-b',shop_id:'shop-b',role:'owner',verified:true}};
 const hashes=new Map(Object.entries(principals).map(([token,p])=>[createHash('sha256').update(token).digest('hex'),p]));
 const rows={'shop-a':[row('item-a','a')],'shop-b':[row('item-b','b')]};
 const intakes={'shop-a':[], 'shop-b':[
  {id:colorIntake.id,status:'NEEDS_HUMAN',close_reason:'COLOR_PRINT',opened_at:colorIntake.received_at},
  {id:genericIntake.id,status:'NEEDS_HUMAN',close_reason:null,opened_at:genericIntake.received_at},
 ]};
 const store={pool:{async query(sql,args){
  if(sql.includes('FROM core_sessions s JOIN core_users u'))return {rows:hashes.has(args[0])?[hashes.get(args[0])]:[],rowCount:hashes.has(args[0])?1:0};
  if(sql.includes('FROM core_inbound_review_items item')||sql.includes('FROM core_oa_intake_batches')){
   calls.push({sql,args});const result=sql.includes('FROM core_inbound_review_items item')?rows[args[0]]||[]:intakes[args[0]]||[];
   return {rows:result,rowCount:result.length};
  }
  throw Error('unexpected SQL '+sql);
 }}};
 const auth=new AuthService(store),inboundReviewReader=createInboundReviewReader({store});
 const registrar={get(path,handler){routes.set(path,handler)},post(){}};
 const inert={};
 registerCoreRoutes(registrar,{auth,service:inert,schedule:inert,
  inboundReviewReader,
  resolveVerifiedCustomer:async()=>{throw Error('unused')},resolvePrintAgent:async()=>{throw Error('unused')}});
 function reply(){let status=200,payload,headers={};const r={code(n){status=n;return r},header(name,value){headers[name.toLowerCase()]=value;return r},send(value){payload=value;return value}};return {r,inspect:()=>({status,payload,headers})}}
 return {handler:routes.get(routePath),calls,reply};
}

test('inbound review list requires an AuthService bearer session and is never cached',async()=>{
 const {handler,reply}=setup(),out=reply();
 await handler({headers:{}},out.r);
 assert.equal(out.inspect().status,401);
 assert.equal(out.inspect().headers['cache-control'],'no-store');
});

test('inbound review list derives shop solely from authenticated principal',async()=>{
 const {handler,calls,reply}=setup(),out=reply();
 const result=await handler({headers:{authorization:'Bearer tokenB'},query:{shop_id:'shop-a',oa_id:'oa-a',order_id:'order-a'}},out.r);
 assert.equal(out.inspect().status,200);
 assert.equal(calls.length,2);
 assert.ok(calls.every(call=>call.args[0]==='shop-b'));
 assert.ok(calls.some(call=>/WHERE item\.shop_id=\$1/.test(call.sql)));
 assert.ok(calls.some(call=>/WHERE shop_id=\$1 AND purpose='PILOT' AND status='NEEDS_HUMAN'/.test(call.sql)));
 assert.deepEqual(result.items.map(x=>`${x.source}:${x.id}`),[
  'quarantine:item-b',`pilot_intake:${colorIntake.id}`,`pilot_intake:${genericIntake.id}`]);
 assert.equal(out.inspect().headers['cache-control'],'no-store');
});

test('staff sees held AWAITING_MEDIA item with only approved fields',async()=>{
 const {handler,reply}=setup(),out=reply();
 const result=await handler({headers:{authorization:'Bearer tokenA'}},out.r);
 assert.equal(out.inspect().status,200);
 const quarantine=result.items.find(x=>x.source==='quarantine');
 assert.equal(quarantine.media_state,'AWAITING_MEDIA');
 assert.equal(quarantine.status,'NEEDS_HUMAN');
 assert.deepEqual(Object.keys(quarantine).sort(),
  ['source','id','kind','mapped_customer','media_state','raw_event_sha256','received_at','status'].sort());
 assert.equal(result.items.some(x=>x.id===colorIntake.id),false);
});
