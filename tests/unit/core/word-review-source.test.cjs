const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {sha,canonical}=require(path.join(root,'core/model.js'));
const {checkedWordReviewSnapshot,readWordReviewSnapshot}=require(path.join(root,'core/word-review-source.js'));
const {OrderService}=require(path.join(root,'core/service.js'));
const {PgStore}=require(path.join(root,'storage/database.js'));

const data={documents:[{artifact_name:'source.docx',copies:1,duplex:false,paper:'A4'}]};
const request_hash=sha(canonical(data));
const scope={shop_id:'shop-a',order_id:'order-a',active_revision:3,request_hash,request_data:data};
function scopeFor(request_data,overrides={}){
 return {...scope,...overrides,request_hash:sha(canonical(request_data)),request_data};
}
function fixture(currentScope=scope){
 const source=Buffer.from('synthetic-docx-bytes');
 const manifestBody={schema:'ai0.word_review_manifest.v1',manifest_ref:'bundle-1/manifest.json',shop_id:currentScope.shop_id,order_id:currentScope.order_id,
  active_revision:currentScope.active_revision,request_hash:currentScope.request_hash,
  source:{format:'DOCX',artifact_ref:'bundle-1/source.docx',sha256:sha(source.toString('hex')),size_bytes:source.length}};
 // Hash the raw source bytes, not a path or caller-provided name.
 manifestBody.source.sha256=require('node:crypto').createHash('sha256').update(source).digest('hex');
 const raw={source:{artifact_ref:'bundle-1/source.docx',bytes:source},
  manifest:{ref:'bundle-1/manifest.json',bytes:Buffer.from(JSON.stringify(manifestBody))}};
 return {raw,manifestBody};
}
const bad=fn=>assert.throws(fn,e=>e&&['WORD_SOURCE_NOT_VERIFIED','WORD_SOURCE_UNAVAILABLE'].includes(e.code));

test('V1-CORE-10 returns exact DB-scoped review contract and private bytes only after verification',()=>{
 const f=fixture();const result=checkedWordReviewSnapshot(scope,f.raw);
 assert.deepEqual({schema:result.schema,shop_id:result.shop_id,order_id:result.order_id,
  active_revision:result.active_revision,request_hash:result.request_hash,request_data:result.request_data},
  {schema:'ai0.word_review_source.v1',...scope});
 assert.equal(result.source.format,'DOCX');assert.equal(result.source.artifact_ref,'bundle-1/source.docx');
 assert.equal(result.source.size_bytes,f.raw.source.bytes.length);
 assert.equal(result.source.sha256,require('node:crypto').createHash('sha256').update(f.raw.source.bytes).digest('hex'));
 assert.equal(result.manifest.ref,'bundle-1/manifest.json');
 assert.deepEqual(Buffer.from(result.private_bytes.source),f.raw.source.bytes);
 assert.deepEqual(Buffer.from(result.private_bytes.manifest),f.raw.manifest.bytes);
 assert.equal(Object.keys(result).includes('private_bytes'),false);
 assert.equal(JSON.stringify(result).includes('DOCX-PG-FIXTURE'),false);
});

test('V1-CORE-16 accepts the unchanged supported DOCX request and binds full ref or exact basename',()=>{
 const f=fixture(),basenameResult=checkedWordReviewSnapshot(scope,f.raw);
 assert.deepEqual(basenameResult.request_data,data);
 assert.equal(basenameResult.request_hash,request_hash);
 assert.equal(sha(canonical(basenameResult.request_data)),request_hash);
 assert.equal(basenameResult.request_data.documents[0].artifact_name,'source.docx');
 const fullData={documents:[{...data.documents[0],artifact_name:'bundle-1/source.docx'}]};
 const fullScope=scopeFor(fullData),fullResult=checkedWordReviewSnapshot(fullScope,fixture(fullScope).raw);
 assert.deepEqual(fullResult.request_data,fullData,'Core preserves the full-ref request without rewriting it');
 assert.equal(fullResult.request_hash,fullScope.request_hash);
});

test('V1-CORE-16 rejects wrong source binding and unsupported DOCX request/settings shapes',()=>{
 const requests=[
  {documents:[{...data.documents[0],artifact_name:'bundle-other/source.docx'}]},
  {documents:[{...data.documents[0],unknown:'value'}]},
  {documents:[{copies:1,duplex:false,paper:'A4'}]},
  {documents:[data.documents[0],data.documents[0]]},
  {...data,settings:{paper:'A3'}},
  {documents:[{...data.documents[0],artifact_name:'bundle-1/source.pdf'}]},
  {documents:[{...data.documents[0],copies:true}]},
  {documents:[{...data.documents[0],copies:1000}]},
  {documents:[{...data.documents[0],duplex:1}]},
  {documents:[{...data.documents[0],paper:'Letter'}]},
  {documents:[{...data.documents[0],orientation:'sideways'}]},
  {documents:[{...data.documents[0],binding:'unknown'}]},
  {documents:[{...data.documents[0],page_range:[]}]},
 ];
 for(const request of requests){
  const candidate=scopeFor(request);
  bad(()=>checkedWordReviewSnapshot(candidate,fixture(candidate).raw));
 }
});

test('V1-CORE-16 rejects invalid current scope/hash and source or manifest over size caps',()=>{
 const f=fixture();
 for(const invalid of [
  {...scope,shop_id:''},{...scope,order_id:''},{...scope,active_revision:0},
  {...scope,active_revision:1.5},{...scope,request_hash:'F'.repeat(64)},
 ])bad(()=>checkedWordReviewSnapshot(invalid,f.raw));
 const oversizedSource=fixture();oversizedSource.raw.source.bytes=Buffer.alloc(25*1024*1024+1);
 bad(()=>checkedWordReviewSnapshot(scope,oversizedSource.raw));
 const oversizedManifest=fixture();oversizedManifest.raw.manifest.bytes=Buffer.alloc(256*1024+1,0x20);
 bad(()=>checkedWordReviewSnapshot(scope,oversizedManifest.raw));
});

test('V1-CORE-16 rejects stale request binding before private registry I/O',async()=>{
 let reads=0;
 const db={async query(){return {rows:[],rowCount:0};},release(){}};
 await assert.rejects(readWordReviewSnapshot(db,{async read_registered(){reads++;return fixture().raw;}},
  {...scope,request_hash:'0'.repeat(64)}),e=>e.code==='WORD_SOURCE_NOT_VERIFIED');
 assert.equal(reads,0);
});

test('V1-CORE-10 rejects wrong tenant, order, revision, request hash, source ref, source SHA, and manifest bytes',()=>{
 for(const field of ['shop_id','order_id','active_revision','request_hash']){
  const f=fixture();f.manifestBody[field]=field==='active_revision'?99:'wrong';
  f.raw.manifest.bytes=Buffer.from(JSON.stringify(f.manifestBody));
  bad(()=>checkedWordReviewSnapshot(scope,f.raw));
 }
 {const f=fixture();f.raw.source.artifact_ref='bundle-2/source.docx';bad(()=>checkedWordReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.raw.manifest.ref='bundle-2/manifest.json';bad(()=>checkedWordReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.raw.source.bytes=Buffer.from('other bytes');bad(()=>checkedWordReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.raw.manifest.bytes=Buffer.from('{bad json');bad(()=>checkedWordReviewSnapshot(scope,f.raw));}
 {const f=fixture();f.manifestBody.source.format='PDF';f.raw.manifest.bytes=Buffer.from(JSON.stringify(f.manifestBody));bad(()=>checkedWordReviewSnapshot(scope,f.raw));}
 for(const ref of ['https://host/file','/etc/passwd','C:/secret.docx','bundle/../secret.docx','bundle\\secret.docx','bundle/a?b','bundle/a#b']){
  const f=fixture();f.raw.source.artifact_ref=ref;f.manifestBody.source.artifact_ref=ref;
  f.raw.manifest.bytes=Buffer.from(JSON.stringify(f.manifestBody));bad(()=>checkedWordReviewSnapshot(scope,f.raw));
 }
 {const f=fixture();const text=JSON.stringify(f.manifestBody).replace('"schema":"ai0.word_review_manifest.v1"','"schema":"bad","schema":"ai0.word_review_manifest.v1"');
  f.raw.manifest.bytes=Buffer.from(text);bad(()=>checkedWordReviewSnapshot(scope,f.raw));}
});

test('V1-CORE-10 rejects absent/empty source, malformed refs and request_data hash mismatch',()=>{
 bad(()=>checkedWordReviewSnapshot(scope,null));
 const f=fixture();f.raw.source.bytes=Buffer.alloc(0);bad(()=>checkedWordReviewSnapshot(scope,f.raw));
 const g=fixture();g.raw.manifest.ref='';bad(()=>checkedWordReviewSnapshot(scope,g.raw));
 bad(()=>checkedWordReviewSnapshot({...scope,request_data:{changed:true}},fixture().raw));
});

function fakeStore(state){
 const log=[];
 const db={async query(sql,args=[]){log.push(sql.trim().split(/\s+/)[0].toUpperCase());
  if(sql.includes('FROM core_orders'))return {rows:state.order.shop_id===args[1]&&state.order.id===args[0]?[{...state.order}]:[],rowCount:1};
  if(sql.includes('FROM core_revisions'))return {rows:[{revision:state.order.active_revision,
   request_hash:state.revision.request_hash,request_data:state.revision.request_data}],rowCount:1};
  if(['BEGIN','COMMIT','ROLLBACK','SET'].includes(sql.trim().split(/\s+/)[0].toUpperCase()))return {rows:[],rowCount:0};
  throw new Error('unexpected SQL: '+sql);
 },release(){}};
 const pool={async connect(){return db},async query(sql,args){return db.query(sql,args)}};
 return {store:new PgStore(pool),log};
}

test('V1-CORE-10 stale revision during private read is rejected with no business writes',async()=>{
 const state={order:{id:scope.order_id,shop_id:scope.shop_id,active_revision:3},
  revision:{request_hash,request_data:data}};
 const f=fixture();let reads=0;
 const reader={async read_registered(_db,passed){
  reads++;assert.deepEqual(passed,scope);assert.ok(Object.isFrozen(passed.request_data));
  if(reads===1){state.order.active_revision=4;state.revision={request_hash:sha(canonical({changed:true})),request_data:{changed:true}};}
  return f.raw;
 }};
 const {store,log}=fakeStore(state),service=new OrderService(store,undefined,undefined,reader);
 const staff={id:'staff-1',shop_id:scope.shop_id,role:'staff',verified:true};
 await assert.rejects(service.readWordReviewSource(staff,scope.order_id),e=>e.code==='STALE_WORD_SOURCE');
 assert.equal(reads,2);
 assert.equal(log.some(op=>['INSERT','UPDATE','DELETE'].includes(op)),false);
});

test('V1-CORE-10 enforces authenticated shop scope before trusted reader and has no write side effects',async()=>{
 const state={order:{id:scope.order_id,shop_id:scope.shop_id,active_revision:3},revision:{request_hash,request_data:data}};
 let reads=0;const reader={async read_registered(){reads++;return fixture().raw;}};
 const {store,log}=fakeStore(state),service=new OrderService(store,undefined,undefined,reader);
 await assert.rejects(service.readWordReviewSource({id:'customer',shop_id:scope.shop_id,role:'customer',verified:true},scope.order_id),e=>e.code==='FORBIDDEN');
 await assert.rejects(service.readWordReviewSource({id:'staff',shop_id:'other-shop',role:'staff',verified:true},scope.order_id),e=>e.code==='NOT_FOUND');
 assert.equal(reads,0);assert.equal(log.some(op=>['INSERT','UPDATE','DELETE'].includes(op)),false);
});
