const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const load=name=>require(path.join(root,name+'.js'));
const {createCoreModule}=load('core/factory');
let Pg,Fastify;
try{Pg=require('pg');Fastify=require('fastify');}catch{}
const url=process.env.TEST_DATABASE_URL;
const enabled=Boolean(Pg&&Fastify&&url);
const id=()=>randomUUID();
test('V1-CORE-07 real PostgreSQL + Fastify: authenticated inbound review read is scoped, safe and read-only',
 {skip:enabled?false:'PostgreSQL/Fastify TEST_DATABASE_URL missing: NOT RUN',timeout:30000},async()=>{
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'TEST_DATABASE_URL must point to local isolated PostgreSQL');
 assert.match(decodeURIComponent(parsed.pathname),/test/i,'database name must identify an isolated test database');
 const pool=new Pg.Pool({connectionString:url,max:8});
 const shops=['autoin-test-inbound-review-'+id(),'autoin-test-inbound-review-'+id()];
 const ids=[id(),id()],quarantines=[id(),id()];
 let app;
 try{
  const tables=(await pool.query(
   "SELECT to_regclass('public.core_users')::text users,to_regclass('public.core_sessions')::text sessions,"+
   "to_regclass('public.core_shop_settings')::text settings,to_regclass('public.core_inbound_review_items')::text items,"+
   "to_regclass('public.core_inbound_review_audit_events')::text audit,to_regclass('public.core_orders')::text orders,"+
   "to_regclass('public.core_approvals')::text approvals,to_regclass('public.core_print_jobs')::text jobs")).rows[0];
  assert.ok(Object.values(tables).every(Boolean),'Run the Core migrations including 013_inbound_review_items.sql before this test');

  const core=createCoreModule({pool});
  const auth=core.auth;
  await auth.bootstrapOwner({shop_id:shops[0],username:'owner',password:'owner-password-2026!',bootstrap_enabled:true});
  await auth.bootstrapOwner({shop_id:shops[1],username:'owner',password:'owner-password-2026!',bootstrap_enabled:true});
  const [sessionA,sessionB]=await Promise.all([
   auth.login(shops[0],'owner','owner-password-2026!'),auth.login(shops[1],'owner','owner-password-2026!')
  ]);
  await pool.query(
   "INSERT INTO core_inbound_review_items(id,shop_id,oa_id,quarantine_id,raw_event_sha256,kind,received_at) "+
   "VALUES($1,$2,$3,$4,$5,'image',clock_timestamp()),($6,$7,$8,$9,$10,'file',clock_timestamp())",
   [ids[0],shops[0],'test-oa-a-'+id(),quarantines[0],'a'.repeat(64),ids[1],shops[1],'test-oa-b-'+id(),quarantines[1],'b'.repeat(64)]
  );

  app=Fastify({logger:false});
  const registry={
   get:(route,handler)=>app.get(route,(request,reply)=>handler(request,reply)),
   post:(route,handler)=>app.post(route,(request,reply)=>handler(request,reply)),
   patch:(route,handler)=>app.patch(route,(request,reply)=>handler(request,reply))
  };
  core.registerRoutes(registry,{
   resolveVerifiedCustomer:async()=>{throw Error('unused in inbound review read test')},
   resolvePrintAgent:async()=>{throw Error('unused in inbound review read test')}
  });
  await app.ready();

  const before=(await pool.query(
   "SELECT (SELECT count(*)::int FROM core_inbound_review_items WHERE shop_id=ANY($1::text[])) items,"+
   "(SELECT count(*)::int FROM core_inbound_review_audit_events WHERE shop_id=ANY($1::text[])) audit,"+
   "(SELECT count(*)::int FROM core_orders WHERE shop_id=ANY($1::text[])) orders,"+
   "(SELECT count(*)::int FROM core_approvals a JOIN core_orders o ON o.id=a.order_id WHERE o.shop_id=ANY($1::text[])) approvals,"+
   "(SELECT count(*)::int FROM core_print_jobs j JOIN core_orders o ON o.id=j.order_id WHERE o.shop_id=ANY($1::text[])) jobs",
   [shops])).rows[0];
  const json=response=>JSON.parse(response.payload);

  const unauth=await app.inject({method:'GET',url:'/api/v1/inbound-review-items'});
  assert.equal(unauth.statusCode,401);
  assert.equal(unauth.headers['cache-control'],'no-store');
  assert.equal(json(unauth).error.code,'UNAUTHENTICATED');

  const own=await app.inject({method:'GET',url:'/api/v1/inbound-review-items',headers:{authorization:'Bearer '+sessionA.token}});
  assert.equal(own.statusCode,200,own.payload);
  assert.equal(own.headers['cache-control'],'no-store');
  assert.deepEqual(json(own).items.map(item=>item.id),[ids[0]]);
  assert.equal(json(own).items[0].media_state,'AWAITING_MEDIA');
  assert.equal(json(own).items[0].status,'NEEDS_HUMAN');
  assert.deepEqual(Object.keys(json(own).items[0]).sort(),
   ['id','kind','status','media_state','raw_event_sha256','received_at','mapped_customer'].sort());

  const spoof=await app.inject({method:'GET',url:'/api/v1/inbound-review-items?shop_id='+encodeURIComponent(shops[0])+
   '&oa_id=spoofed&order_id='+id(),headers:{authorization:'Bearer '+sessionB.token}});
  assert.equal(spoof.statusCode,200,spoof.payload);
  assert.equal(spoof.headers['cache-control'],'no-store');
  assert.deepEqual(json(spoof).items.map(item=>item.id),[ids[1]],'query tenant/OA/order values must not override authenticated shop');
  assert.deepEqual(Object.keys(json(spoof).items[0]).sort(),
   ['id','kind','status','media_state','raw_event_sha256','received_at','mapped_customer'].sort());

  const after=(await pool.query(
   "SELECT (SELECT count(*)::int FROM core_inbound_review_items WHERE shop_id=ANY($1::text[])) items,"+
   "(SELECT count(*)::int FROM core_inbound_review_audit_events WHERE shop_id=ANY($1::text[])) audit,"+
   "(SELECT count(*)::int FROM core_orders WHERE shop_id=ANY($1::text[])) orders,"+
   "(SELECT count(*)::int FROM core_approvals a JOIN core_orders o ON o.id=a.order_id WHERE o.shop_id=ANY($1::text[])) approvals,"+
   "(SELECT count(*)::int FROM core_print_jobs j JOIN core_orders o ON o.id=j.order_id WHERE o.shop_id=ANY($1::text[])) jobs",
   [shops])).rows[0];
  assert.deepEqual(after,before,'GET must not mutate queue/audit/order/approval/print state');
 }finally{
  await app?.close().catch(()=>{});
  await pool.query('DELETE FROM core_inbound_review_audit_events WHERE shop_id=ANY($1::text[])',[shops]).catch(()=>{});
  await pool.query('DELETE FROM core_inbound_review_items WHERE shop_id=ANY($1::text[])',[shops]).catch(()=>{});
  await pool.query('DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=ANY($1::text[]))',[shops]).catch(()=>{});
  await pool.query('DELETE FROM core_users WHERE shop_id=ANY($1::text[])',[shops]).catch(()=>{});
  await pool.query('DELETE FROM core_shop_settings WHERE shop_id=ANY($1::text[])',[shops]).catch(()=>{});
  await pool.end();
 }
});
