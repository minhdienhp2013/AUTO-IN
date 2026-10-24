const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {enforceModeScope,hasControlledTestScope,controlledTestScopeExistsSql}=require(path.join(root,'core/controlled-test-scope.js'));

const scope={shop_id:'shop-a',order_id:'00000000-0000-4000-8000-000000000001',printer_id:'RMP7000'};
const row={...scope,enabled:true,active:true,duration_valid:true,order_shop_id:'shop-a',configured_by_role:'owner',configured_by_active:true};
function fakeDb(result,{failure}={}){
 const calls=[];
 return {calls,query:async(sql,args)=>{
  calls.push({sql,args});
  if(failure)throw failure;
  return {rows:result===null?[]:[result],rowCount:result===null?0:1};
 }};
}

test('controlled_test allows only an active owner-configured exact shop/order/printer tuple',async()=>{
 const db=fakeDb(row);
 await enforceModeScope(db,'controlled_test',scope);
 assert.equal(db.calls.length,1);
 assert.deepEqual(db.calls[0].args,[scope.shop_id,scope.order_id,scope.printer_id]);
 assert.match(db.calls[0].sql,/s\.updated_at<=clock_timestamp\(\) AND s\.expires_at<=s\.updated_at\+interval '30 minutes'/);
 assert.match(db.calls[0].sql,/FOR UPDATE OF s,u$/);
});

test('simulation remains unchanged while production remains a distinct mode',async()=>{
 const db=fakeDb(null);
 await enforceModeScope(db,'simulation',scope);
 await enforceModeScope(db,'production',scope);
 assert.equal(db.calls.length,0);
});

test('disabled, missing, expired and non-owner configurations fail closed',async()=>{
 const cases=[
  ['disabled',{...row,enabled:false}],
  ['expired',{...row,active:false}],
  ['grant exceeds 30-minute cap',{...row,duration_valid:false}],
  ['future-dated grant',{...row,duration_valid:false}],
  ['wrong order shop',{...row,order_shop_id:'shop-other'}],
  ['inactive owner',{...row,configured_by_active:false}],
  ['staff configured',{...row,configured_by_role:'staff'}],
  ['missing',null]
 ];
 for(const [name,value] of cases){
  const db=fakeDb(value);
  await assert.rejects(enforceModeScope(db,'controlled_test',scope),error=>{
   assert.equal(error.code,'CONTROLLED_TEST_SCOPE_REQUIRED',name);return true;
  });
 }
});

test('wrong shop/order/printer row cannot satisfy the exact requested scope',async()=>{
 for(const mismatch of [
  {...row,shop_id:'shop-other'},
  {...row,order_id:'00000000-0000-4000-8000-000000000002'},
  {...row,printer_id:'OTHER-PRINTER'}
 ]){
  assert.equal(await hasControlledTestScope(fakeDb(mismatch),scope),false);
 }
});

test('database errors return an unavailable error instead of opening the scope',async()=>{
 const db=fakeDb(null,{failure:new Error('synthetic database failure')});
 await assert.rejects(enforceModeScope(db,'controlled_test',scope),error=>
  error.code==='CONTROLLED_TEST_SCOPE_UNAVAILABLE'&&error.status===503&&error.retryable===true);
});

test('queue predicate requires the exact active scope and rejects unsafe SQL aliases',()=>{
 const predicate=controlledTestScopeExistsSql('j');
 assert.match(predicate,/c\.shop_id=o\.shop_id/);
 assert.match(predicate,/c\.order_id=o\.id/);
 assert.match(predicate,/c\.printer_id=j\.printer_id/);
 assert.match(predicate,/cu\.role='owner' AND cu\.active/);
 assert.match(predicate,/c\.enabled AND c\.expires_at>clock_timestamp\(\)/);
 assert.match(predicate,/c\.updated_at<=clock_timestamp\(\) AND c\.expires_at<=c\.updated_at\+interval '30 minutes'/);
 assert.throws(()=>controlledTestScopeExistsSql('j;drop'),error=>error.code==='INVALID_INPUT');
});
