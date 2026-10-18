const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {OrderService}=require(path.join(root,'core/service.js'));
const {PgStore}=require(path.join(root,'storage/database.js'));
const {sha,canonical}=require(path.join(root,'core/model.js'));
let pg;try{pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL;
const error=code=>e=>e&&e.code===code;
test('V1-CORE-10 PostgreSQL: authenticated read-only source handoff and stale revision race',
 {skip:!(pg&&url)&&'NOT RUN - TEST_DATABASE_URL isolated PostgreSQL required',timeout:120000},async t=>{
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'test DB must be local');
 assert.match(parsed.pathname,/test/i,'test DB name must include test');
 const admin=new pg.Pool({connectionString:url,max:2});
 const schema='ai1_word_source_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:url,max:3,options:`-c search_path=${schema}`});
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/001_core.sql'),'utf8'));
  const shop='shop-'+randomUUID(),orderId=randomUUID(),staffId=randomUUID();
  await pool.query("INSERT INTO core_shop_settings(shop_id) VALUES($1)",[shop]);
  await pool.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','test-only','staff')",[staffId,shop]);
  const data={files:[{format:'DOCX'}],settings:{paper:'A4'}},requestHash=sha(canonical(data));
  await pool.query('INSERT INTO core_orders(id,shop_id,customer_id,active_revision) VALUES($1,$2,$3,1)',[orderId,shop,'test-customer']);
  await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',[orderId,requestHash,JSON.stringify(data)]);
  const source=Buffer.from('DOCX-PG-FIXTURE');
  const manifest=scope=>Buffer.from(JSON.stringify({schema:'ai0.word_review_manifest.v1',manifest_ref:'test-bundle/manifest.json',shop_id:shop,
   order_id:orderId,active_revision:scope.active_revision,request_hash:scope.request_hash,
   source:{format:'DOCX',artifact_ref:'test-bundle/source.docx',sha256:createHash('sha256').update(source).digest('hex'),size_bytes:source.length}}));
  const reader={async read_registered(_db,scope){return {source:{artifact_ref:'test-bundle/source.docx',bytes:source},
   manifest:{ref:'test-bundle/manifest.json',bytes:manifest(scope)}};}};
  const service=new OrderService(new PgStore(pool),undefined,undefined,reader);
  const staff={id:staffId,role:'staff',shop_id:shop,verified:true};
  const result=await service.readWordReviewSource(staff,orderId);
  assert.equal(result.schema,'ai0.word_review_source.v1');assert.equal(result.active_revision,1);
  assert.deepEqual(result.private_bytes.source,source);
  const before=(await pool.query('SELECT (SELECT count(*) FROM core_confirmations)::int c,(SELECT count(*) FROM core_approvals)::int a,(SELECT count(*) FROM core_print_jobs)::int j,(SELECT count(*) FROM core_audit)::int u,(SELECT count(*) FROM core_idempotency)::int i')).rows[0];
  let reads=0;
  const racing={async read_registered(_db,scope){reads++;
   if(reads===1){
    const next={changed:'revision'};const hash=sha(canonical(next));
    await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,2,$2,$3::jsonb)',[orderId,hash,JSON.stringify(next)]);
    await pool.query('UPDATE core_orders SET active_revision=2 WHERE id=$1',[orderId]);
   }
   return {source:{artifact_ref:'test-bundle/source.docx',bytes:source},manifest:{ref:'test-bundle/manifest.json',bytes:manifest(scope)}};
  }};
  const raceService=new OrderService(new PgStore(pool),undefined,undefined,racing);
  await assert.rejects(raceService.readWordReviewSource(staff,orderId),error('STALE_WORD_SOURCE'));
  assert.equal(reads,2);
  const after=(await pool.query('SELECT (SELECT count(*) FROM core_confirmations)::int c,(SELECT count(*) FROM core_approvals)::int a,(SELECT count(*) FROM core_print_jobs)::int j,(SELECT count(*) FROM core_audit)::int u,(SELECT count(*) FROM core_idempotency)::int i')).rows[0];
  assert.deepEqual(after,before,'reader creates no confirmation/approval/job/audit/idempotency rows');
 }finally{
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
 }
});
