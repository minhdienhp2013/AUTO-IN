const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
let pg;try{pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL;
const error=code=>e=>e&&e.code===code;
test('V1-CORE-12 PostgreSQL: PDF source handoff is scoped, read-only, and detects revision race',
 {skip:!(pg&&url)&&'NOT RUN - TEST_DATABASE_URL isolated PostgreSQL required',timeout:120000},async()=>{
 const {OrderService}=require(path.join(root,'core/service.js'));
 const {PgStore}=require(path.join(root,'storage/database.js'));
 const {sha,canonical}=require(path.join(root,'core/model.js'));
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'test DB must be local');
 assert.match(parsed.pathname,/test/i,'test DB name must include test');
 const admin=new pg.Pool({connectionString:url,max:2});
 const schema='ai1_pdf_source_'+randomUUID().replaceAll('-','');
 const pool=new pg.Pool({connectionString:url,max:1,options:`-c search_path=${schema}`});
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/001_core.sql'),'utf8'));
  const configured=await pool.connect();
  await configured.query('SET default_transaction_isolation TO REPEATABLE READ');
  configured.release();
  const isolation=(await pool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation;
  assert.equal(isolation,'repeatable read','test exercises a pool whose default is not READ COMMITTED');
  const shop='shop-'+randomUUID(),orderId=randomUUID(),staffId=randomUUID();
  await pool.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await pool.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','test-only','staff')",[staffId,shop]);
  const data={documents:[{format:'PDF',copies:1}],settings:{paper:'A4'}},requestHash=sha(canonical(data));
  await pool.query('INSERT INTO core_orders(id,shop_id,customer_id,active_revision) VALUES($1,$2,$3,1)',[orderId,shop,'test-customer']);
  await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',[orderId,requestHash,JSON.stringify(data)]);
  const source=Buffer.from('%PDF-1.7\nsynthetic registered PDF bytes');
  const manifest=scope=>Buffer.from(JSON.stringify({schema:'ai0.pdf_review_manifest.v1',
   manifest_ref:'test-bundle/manifest.json',shop_id:shop,order_id:orderId,active_revision:scope.active_revision,
   request_hash:scope.request_hash,source:{format:'PDF',artifact_ref:'test-bundle/source.pdf',
    sha256:createHash('sha256').update(source).digest('hex'),size_bytes:source.length}}));
  const reader={async read_registered(_db,scope){return {source:{artifact_ref:'test-bundle/source.pdf',bytes:source},
   manifest:{ref:'test-bundle/manifest.json',bytes:manifest(scope)}};}};
  const service=new OrderService(new PgStore(pool),undefined,undefined,undefined,reader);
  const staff={id:staffId,role:'staff',shop_id:shop,verified:true};
  const result=await service.readPdfReviewSource(staff,orderId);
  assert.equal(result.schema,'ai0.pdf_review_source.v1');
  assert.equal(result.active_revision,1);assert.equal(result.request_hash,requestHash);
  assert.deepEqual(Buffer.from(result.private_bytes.source),source);
  assert.equal(Object.keys(result).includes('private_bytes'),false);
  const before=(await pool.query('SELECT (SELECT count(*) FROM core_confirmations)::int c,'+
   '(SELECT count(*) FROM core_approvals)::int a,(SELECT count(*) FROM core_print_jobs)::int j,'+
   '(SELECT count(*) FROM core_audit)::int u,(SELECT count(*) FROM core_idempotency)::int i')).rows[0];
  let reads=0;
  const racing={async read_registered(_db,scope){
   reads++;
   if(reads===1){
    const next={documents:[{format:'PDF',copies:2}],settings:{paper:'A4'}};
    const hash=sha(canonical(next));
    await admin.query(`INSERT INTO ${schema}.core_revisions(order_id,revision,request_hash,request_data) VALUES($1,2,$2,$3::jsonb)`,
     [orderId,hash,JSON.stringify(next)]);
    await admin.query(`UPDATE ${schema}.core_orders SET active_revision=2 WHERE id=$1`,[orderId]);
   }
   return {source:{artifact_ref:'test-bundle/source.pdf',bytes:source},manifest:{ref:'test-bundle/manifest.json',bytes:manifest(scope)}};
  }};
  const raceService=new OrderService(new PgStore(pool),undefined,undefined,undefined,racing);
  await assert.rejects(raceService.readPdfReviewSource(staff,orderId),error('STALE_PDF_SOURCE'));
  assert.equal(reads,2);
  const after=(await pool.query('SELECT (SELECT count(*) FROM core_confirmations)::int c,'+
   '(SELECT count(*) FROM core_approvals)::int a,(SELECT count(*) FROM core_print_jobs)::int j,'+
   '(SELECT count(*) FROM core_audit)::int u,(SELECT count(*) FROM core_idempotency)::int i')).rows[0];
  assert.deepEqual(after,before,'source handoff creates no confirmation, approval, job, audit, or idempotency row');
 }finally{
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
 }
});
