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
const row=(id,sha)=>({id,kind:'image',status:'NEEDS_HUMAN',media_state:'AWAITING_MEDIA',raw_event_sha256:sha.repeat(64),received_at:'2026-10-18T00:00:00.000Z',mapped_customer:false});

function setup(){
 const routes=new Map(),calls=[];
 const principals={tokenA:{id:'staff-a',shop_id:'shop-a',role:'staff',verified:true},tokenB:{id:'staff-b',shop_id:'shop-b',role:'owner',verified:true}};
 const hashes=new Map(Object.entries(principals).map(([token,p])=>[createHash('sha256').update(token).digest('hex'),p]));
 const rows={'shop-a':[row('item-a','a')],'shop-b':[row('item-b','b')]};
 const store={pool:{async query(sql,args){
  if(sql.includes('FROM core_sessions s JOIN core_users u'))return {rows:hashes.has(args[0])?[hashes.get(args[0])]:[],rowCount:hashes.has(args[0])?1:0};
  if(sql.includes('FROM core_inbound_review_items item')){calls.push({sql,args});return {rows:rows[args[0]]||[],rowCount:(rows[args[0]]||[]).length};}
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
 assert.equal(calls.length,1);
 assert.match(calls[0].sql,/WHERE item\.shop_id=\$1/);
 assert.deepEqual(calls[0].args,['shop-b']);
 assert.deepEqual(result.items.map(x=>x.id),['item-b']);
 assert.equal(out.inspect().headers['cache-control'],'no-store');
});

test('staff sees held AWAITING_MEDIA item with only approved fields',async()=>{
 const {handler,reply}=setup(),out=reply();
 const result=await handler({headers:{authorization:'Bearer tokenA'}},out.r);
 assert.equal(out.inspect().status,200);
 assert.equal(result.items[0].media_state,'AWAITING_MEDIA');
 assert.equal(result.items[0].status,'NEEDS_HUMAN');
 assert.deepEqual(Object.keys(result.items[0]).sort(),
  ['id','kind','mapped_customer','media_state','raw_event_sha256','received_at','status'].sort());
});
