import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSafeDatabase,createAcceptanceAdapter} from './product-adapter.mjs';
function accepted(url){
 const old=process.env.AUTOIN_ALLOW_PG_ACCEPTANCE;
 process.env.AUTOIN_ALLOW_PG_ACCEPTANCE='YES_ISOLATED_TEST_DB';
 try{return assertSafeDatabase(url)}finally{
  if(old===undefined)delete process.env.AUTOIN_ALLOW_PG_ACCEPTANCE;
  else process.env.AUTOIN_ALLOW_PG_ACCEPTANCE=old;
 }
}
test('ADAPTER: production and remote DB URLs rejected',()=>{
 for(const url of ['postgres://x:y@localhost:5432/production','postgres://x:y@db.example.com/autoin_test','postgres://x:y@192.168.1.2/autoin_test','invalid'])
  assert.throws(()=>accepted(url));
});
test('ADAPTER: explicit isolated database opt-in required',()=>{
 const old=process.env.AUTOIN_ALLOW_PG_ACCEPTANCE;delete process.env.AUTOIN_ALLOW_PG_ACCEPTANCE;
 try{assert.throws(()=>assertSafeDatabase('postgres://x:y@localhost/autoin_test'))}
 finally{if(old!==undefined)process.env.AUTOIN_ALLOW_PG_ACCEPTANCE=old}
});
test('ADAPTER: isolated local PostgreSQL URL allowed',()=>{
 assert.equal(accepted('postgres://x:y@127.0.0.1:5432/autoin_test_205').pathname,'/autoin_test_205');
});
test('ADAPTER: fail closed on non-simulation/real printer',async()=>{
 await assert.rejects(createAcceptanceAdapter({mode:'production',printer:'WindowsPrinter'}),/Real printing strictly forbidden/);
});
