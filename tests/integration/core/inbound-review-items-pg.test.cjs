const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {createOfficialInboundReviewItems}=require(path.join(root,'core/inbound-review-items.js'));
let pg;try{pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL,uid=()=>randomUUID();
const sha=x=>createHash('sha256').update(x).digest('hex');
test('V1-CORE-05 REAL PG two pools: official media event is held once for staff, unlinked and tenant-scoped',
 {skip:!(pg&&url)&&'NOT RUN - isolated PostgreSQL TEST_DATABASE_URL required',timeout:30000},async()=>{
 const u=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname));
 assert.match(u.pathname,/test/i);
 const a=new pg.Pool({connectionString:url,max:4}),b=new pg.Pool({connectionString:url,max:4});
 const shopA='review-a-'+uid(),shopB='review-b-'+uid();
 const oaA='review-oa-a-'+uid(),oaB='review-oa-b-'+uid();
 const qA=uid(),qB=uid(),rawA=sha('signed synthetic event A'),rawB=sha('signed synthetic event B');
 try{
  for(const file of [
   '../../../backend/integrations/zalo/migrations/004_official_quarantine.sql',
   '../../../backend/composition/migrations/005_official_zalo_shop_registry.sql',
   '../../../backend/storage/migrations/013_inbound_review_items.sql'])
   await a.query(fs.readFileSync(path.resolve(__dirname,file),'utf8'));
  await a.query("INSERT INTO core_shop_settings(shop_id,open_at,close_at) VALUES($1,'00:00','24:00'),($2,'00:00','24:00')",[shopA,shopB]);
  await a.query('INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3),($4,$5,$6)',
   [shopA,oaA,'app-a-'+uid(),shopB,oaB,'app-b-'+uid()]);
  await a.query('INSERT INTO zalo_official_quarantine_scopes(oa_id) VALUES($1),($2)',[oaA,oaB]);
  await a.query("INSERT INTO zalo_official_quarantine(id,oa_id,raw_sha256,kind,customer_id,conversation_id,status,received_at) "+
   "VALUES($1,$2,$3,'image',$4,$5,'NEEDS_HUMAN',clock_timestamp()),($6,$7,$8,'file',$9,$10,'NEEDS_HUMAN',clock_timestamp())",
   [qA,oaA,rawA,'customer-a-'+uid(),'conversation-a-'+uid(),qB,oaB,rawB,'customer-b-'+uid(),'conversation-b-'+uid()]);
  const A=createOfficialInboundReviewItems({store:new PgStore(a),trusted:{shop_id:shopA,oa_id:oaA}});
  const A2=createOfficialInboundReviewItems({store:new PgStore(b),trusted:{shop_id:shopA,oa_id:oaA}});
  const B=createOfficialInboundReviewItems({store:new PgStore(b),trusted:{shop_id:shopB,oa_id:oaB}});
  const staffA={id:uid(),shop_id:shopA,role:'staff',verified:true};
  const staffB={id:uid(),shop_id:shopB,role:'staff',verified:true};
  const [first,replay]=await Promise.all([A.enqueue_quarantined_event(qA),A2.enqueue_quarantined_event(qA)]);
  assert.deepEqual(new Set([first.status,replay.status]),new Set(['created','existing']));
  assert.equal(first.item_id,replay.item_id);
  const other=await B.enqueue_quarantined_event(qB);
  assert.equal(other.status,'created');
  await assert.rejects(A.enqueue_quarantined_event(qB),e=>e.code==='QUARANTINE_SOURCE_NOT_PENDING');
  const listA=await A.list_for_staff(staffA),listB=await B.list_for_staff(staffB);
  assert.equal(listA.length,1);assert.equal(listA[0].quarantine_id,qA);
  assert.equal(listA[0].signed_event_sha256,rawA);assert.equal(listA[0].media_state,'AWAITING_MEDIA');
  assert.equal(listB.length,1);assert.equal(listB[0].quarantine_id,qB);
  assert.ok(listB.every(item=>item.quarantine_id!==qA));
  const rows=await a.query('SELECT quarantine_id::text,kind,status,media_state,signed_event_sha256 FROM core_inbound_review_items WHERE shop_id=ANY($1::text[]) ORDER BY shop_id',[[shopA,shopB]]);
  assert.equal(rows.rows.length,2);assert.ok(rows.rows.every(row=>row.status==='NEEDS_HUMAN'&&row.media_state==='AWAITING_MEDIA'));
  assert.equal((await a.query("SELECT count(*)::int n FROM core_inbound_review_audit_events WHERE action='inbound.file_held_for_staff' AND shop_id=ANY($1::text[])",[[shopA,shopB]])).rows[0].n,2);
  const custody=await a.query('SELECT id::text,status,raw_sha256 FROM zalo_official_quarantine WHERE id=ANY($1::uuid[]) ORDER BY id',[ [qA,qB] ]);
  assert.equal(custody.rows.length,2);assert.ok(custody.rows.every(row=>row.status==='NEEDS_HUMAN'));
  assert.equal((await a.query("SELECT count(*)::int n FROM core_approvals WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=ANY($1::text[]))",[[shopA,shopB]])).rows[0].n,0);
  assert.equal((await a.query("SELECT count(*)::int n FROM core_print_jobs WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=ANY($1::text[]))",[[shopA,shopB]])).rows[0].n,0);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_orders WHERE shop_id=ANY($1::text[])',[[shopA,shopB]])).rows[0].n,0);
 }finally{
  await a.query('DELETE FROM core_inbound_review_items WHERE shop_id=ANY($1::text[])',[ [shopA,shopB] ]).catch(()=>{});
  await a.query('DELETE FROM zalo_official_quarantine WHERE id=ANY($1::uuid[])',[[qA,qB]]).catch(()=>{});
  await a.query('DELETE FROM zalo_official_quarantine_scopes WHERE oa_id=ANY($1::text[])',[[oaA,oaB]]).catch(()=>{});
  await a.query('DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=ANY($1::text[])',[[shopA,shopB]]).catch(()=>{});
  await a.query('DELETE FROM core_shop_settings WHERE shop_id=ANY($1::text[])',[[shopA,shopB]]).catch(()=>{});
  await a.end();await b.end();
 }
});
