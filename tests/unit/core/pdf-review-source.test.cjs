const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createHash}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {sha,canonical,DomainError}=require(path.join(root,'core/model.js'));
const {checkedPdfReviewSnapshot,readPdfReviewSnapshot}=require(path.join(root,'core/pdf-review-source.js'));
const {OrderService}=require(path.join(root,'core/service.js'));
const {PgStore}=require(path.join(root,'storage/database.js'));

const request_data={documents:[{format:'PDF',copies:1}],settings:{paper:'A4'}};
const request_hash=sha(canonical(request_data));
const scope={shop_id:'shop-a',order_id:'order-a',active_revision:3,request_hash,request_data};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const source=Buffer.from('%PDF-1.7\nsynthetic verified PDF bytes');
 const manifestBody={schema:'ai0.pdf_review_manifest.v1',manifest_ref:'bundle-1/manifest.json',
  shop_id:scope.shop_id,order_id:scope.order_id,active_revision:scope.active_revision,request_hash:scope.request_hash,
  source:{format:'PDF',artifact_ref:'bundle-1/source.pdf',sha256:digest(source),size_bytes:source.length}};
 return {source,manifestBody,raw:{source:{artifact_ref:'bundle-1/source.pdf',bytes:source},
  manifest:{ref:'bundle-1/manifest.json',bytes:Buffer.from(JSON.stringify(manifestBody))}}};
}
const bad=fn=>assert.throws(fn,e=>e&&['PDF_SOURCE_NOT_VERIFIED','PDF_SOURCE_UNAVAILABLE'].includes(e.code));

test('V1-CORE-12 returns exact DB-scoped PDF contract with private bytes omitted from serialization',()=>{
 const f=fixture(),result=checkedPdfReviewSnapshot(scope,f.raw);
 assert.deepEqual({schema:result.schema,shop_id:result.shop_id,order_id:result.order_id,
  active_revision:result.active_revision,request_hash:result.request_hash,request_data:result.request_data},
  {schema:'ai0.pdf_review_source.v1',...scope});
 assert.deepEqual(result.source,{format:'PDF',artifact_ref:'bundle-1/source.pdf',sha256:digest(f.source),size_bytes:f.source.length});
 assert.deepEqual(result.manifest,{ref:'bundle-1/manifest.json',sha256:digest(f.raw.manifest.bytes)});
 assert.deepEqual(Buffer.from(result.private_bytes.source),f.source);
 assert.deepEqual(Buffer.from(result.private_bytes.manifest),f.raw.manifest.bytes);
 assert.equal(Object.keys(result).includes('private_bytes'),false);
 assert.equal(JSON.stringify(result).includes('synthetic verified PDF bytes'),false);
});

test('V1-CORE-12 rejects wrong scope, source/manifest digest or size, schema drift, and unsafe refs',()=>{
 for(const field of ['shop_id','order_id','active_revision','request_hash']){
  const f=fixture();f.manifestBody[field]=field==='active_revision'?9:'wrong';
  f.raw.manifest.bytes=Buffer.from(JSON.stringify(f.manifestBody));
  bad(()=>checkedPdfReviewSnapshot(scope,f.raw));
 }
 {const f=fixture();f.raw.source.bytes=Buffer.from('%PDF-1.7 changed');bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.manifestBody.source.size_bytes++;f.raw.manifest.bytes=Buffer.from(JSON.stringify(f.manifestBody));bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.manifestBody.extra=true;f.raw.manifest.bytes=Buffer.from(JSON.stringify(f.manifestBody));bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.manifestBody.source.format='DOCX';f.raw.manifest.bytes=Buffer.from(JSON.stringify(f.manifestBody));bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.raw.manifest.ref='bundle-2/manifest.json';bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 for(const ref of ['https://host/file.pdf','/etc/file.pdf','C:/file.pdf','bundle/../file.pdf',
  'bundle\\file.pdf','bundle/file.pdf?x','bundle/file.pdf#x']){
  const f=fixture();f.raw.source.artifact_ref=ref;f.manifestBody.source.artifact_ref=ref;
  f.raw.manifest.bytes=Buffer.from(JSON.stringify(f.manifestBody));bad(()=>checkedPdfReviewSnapshot(scope,f.raw));
 }
});

test('V1-CORE-12 rejects absent, malformed, duplicate-key, non-PDF, and hash-mismatched inputs',()=>{
 bad(()=>checkedPdfReviewSnapshot(scope,null));
 {const f=fixture();f.raw.source.bytes=Buffer.alloc(0);bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.raw.source.bytes=Buffer.from('not pdf');bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.raw.source.bytes=Buffer.alloc(25*1024*1024+1);bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.raw.manifest.bytes=Buffer.from('{"schema":"ai0.pdf_review_manifest.v1","schema":"ai0.pdf_review_manifest.v1"}');bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.raw.manifest.bytes=Buffer.from([0xc3,0x28]);bad(()=>checkedPdfReviewSnapshot(scope,f.raw));}
 bad(()=>checkedPdfReviewSnapshot({...scope,request_data:{changed:true}},fixture().raw));
});

test('V1-CORE-12 registry reads are frozen, repeated, and reject byte drift',async()=>{
 const f=fixture();let calls=0;
 const reader={async read_registered(_db,passed){
  calls++;assert.ok(Object.isFrozen(passed));assert.ok(Object.isFrozen(passed.request_data));
  assert.ok(Object.isFrozen(passed.request_data.documents));return f.raw;
 }};
 const emptyDb={async query(){return {rows:[],rowCount:0};},release(){}};
 const result=await readPdfReviewSnapshot(emptyDb,reader,scope);
 assert.equal(result.schema,'ai0.pdf_review_source.v1');assert.equal(calls,2);
 const changed={...fixture(),source:Buffer.from('%PDF-1.7 other bytes')};
 changed.manifestBody.source.sha256=digest(changed.source);
 changed.manifestBody.source.size_bytes=changed.source.length;
 changed.raw.source.bytes=changed.source;
 changed.raw.manifest.bytes=Buffer.from(JSON.stringify(changed.manifestBody));
 calls=0;
 await assert.rejects(readPdfReviewSnapshot(emptyDb,{async read_registered(){return ++calls===1?f.raw:changed.raw;}},scope),
  e=>e.code==='PDF_SOURCE_NOT_VERIFIED');
 assert.equal(calls,2);
});

function fakeStore(state){
 const statements=[],operations=[];
 const db={async query(sql,args=[]){
  statements.push(sql.trim().replace(/\s+/g,' '));
  operations.push(sql.trim().split(/\s+/)[0].toUpperCase());
  if(sql.includes('FROM core_orders'))return {rows:state.order.shop_id===args[1]&&state.order.id===args[0]?[{...state.order}]:[],rowCount:1};
  if(sql.includes('FROM core_revisions'))return {rows:[{revision:state.order.active_revision,
   request_hash:state.revision.request_hash,request_data:state.revision.request_data}],rowCount:1};
  if(['BEGIN','COMMIT','ROLLBACK','SET'].includes(sql.trim().split(/\s+/)[0].toUpperCase()))return {rows:[],rowCount:0};
  throw new Error('unexpected SQL: '+sql);
 },release(){}};
 const pool={async connect(){return db},async query(sql,args){return db.query(sql,args)}};
 return {store:new PgStore(pool),statements,operations};
}

test('V1-CORE-12 Core service scopes staff/order, rechecks current revision after I/O, and makes no writes',async()=>{
 const state={order:{id:scope.order_id,shop_id:scope.shop_id,active_revision:3},revision:{request_hash,request_data}};
 const f=fixture();let reads=0;
 const reader={async read_registered(_db,passed){
  reads++;
  if(reads===1){const next={changed:'revision'};state.order.active_revision=4;
   state.revision={request_hash:sha(canonical(next)),request_data:next};}
  const b=Buffer.from(passed.request_hash===request_hash?f.source:'%PDF-1.7 updated');
  const manifestBody={schema:'ai0.pdf_review_manifest.v1',manifest_ref:'bundle-1/manifest.json',
   shop_id:passed.shop_id,order_id:passed.order_id,active_revision:passed.active_revision,request_hash:passed.request_hash,
   source:{format:'PDF',artifact_ref:'bundle-1/source.pdf',sha256:digest(b),size_bytes:b.length}};
  return {source:{artifact_ref:'bundle-1/source.pdf',bytes:b},manifest:{ref:'bundle-1/manifest.json',bytes:Buffer.from(JSON.stringify(manifestBody))}};
 }};
 const {store,statements,operations}=fakeStore(state),service=new OrderService(store,undefined,undefined,undefined,reader);
 const staff={id:'staff-a',role:'staff',shop_id:scope.shop_id,verified:true};
 await assert.rejects(service.readPdfReviewSource(staff,scope.order_id),e=>e.code==='STALE_PDF_SOURCE');
 assert.equal(reads,2);
 assert.ok(statements.includes('SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ ONLY'));
 assert.equal(operations.some(op=>['INSERT','UPDATE','DELETE'].includes(op)),false);
});

test('V1-CORE-12 rejects unauthorized and foreign-shop reads before calling private source reader',async()=>{
 const state={order:{id:scope.order_id,shop_id:scope.shop_id,active_revision:3},revision:{request_hash,request_data}};
 let reads=0;const reader={async read_registered(){reads++;return fixture().raw;}};
 const {store,operations}=fakeStore(state),service=new OrderService(store,undefined,undefined,undefined,reader);
 await assert.rejects(service.readPdfReviewSource({id:'customer',role:'customer',shop_id:scope.shop_id,verified:true},scope.order_id),e=>e.code==='FORBIDDEN');
 await assert.rejects(service.readPdfReviewSource({id:'staff',role:'staff',shop_id:'shop-other',verified:true},scope.order_id),e=>e.code==='NOT_FOUND');
 assert.equal(reads,0);assert.equal(operations.some(op=>['INSERT','UPDATE','DELETE'].includes(op)),false);
});

test('V1-CORE-12 missing trusted reader fails closed before opening a transaction',async()=>{
 const {store}=fakeStore({order:{id:scope.order_id,shop_id:scope.shop_id,active_revision:3},revision:{request_hash,request_data}});
 const service=new OrderService(store);
 await assert.rejects(service.readPdfReviewSource({id:'staff',role:'staff',shop_id:scope.shop_id,verified:true},scope.order_id),
  e=>e.code==='PDF_SOURCE_NOT_CONFIGURED'&&e.status===503);
});
