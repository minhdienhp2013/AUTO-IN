import test from 'node:test';
import assert from 'node:assert/strict';
import {createZaloTransactions} from '../../../backend/integrations/zalo/transaction-runner.ts';
import {createZaloComposition} from '../../../backend/integrations/zalo/wiring.ts';

function poolFixture(){
  const operations=[];
  let connection=0,released=0;
  const pool={async connect(){
    const id=++connection;
    return {
      async query(sql,params){operations.push({id,sql,params});return {rows:[],rowCount:0}},
      release(){released++}
    };
  }};
  return {pool,operations,counts:()=>({connection,released})};
}
test('AI1 gate and AI2 outbound queries share one BEGIN/COMMIT connection',async()=>{
  const fixture=poolFixture(),runner=createZaloTransactions(fixture.pool);
  await runner.transaction(async tx=>{
    await tx.query('SELECT generation FROM core_conversation_controls FOR UPDATE',['shop','conversation']);
    await tx.query("UPDATE zalo_outbound SET status='RESERVED' WHERE outbound_id=$1",['id']);
  });
  assert.deepEqual(fixture.operations.map(x=>x.sql),[
    'BEGIN','SELECT generation FROM core_conversation_controls FOR UPDATE',
    "UPDATE zalo_outbound SET status='RESERVED' WHERE outbound_id=$1",'COMMIT'
  ]);
  assert.deepEqual(new Set(fixture.operations.map(x=>x.id)).size,1);
  assert.deepEqual(fixture.counts(),{connection:1,released:1});
});
test('failed query aborts transaction; client is released; no partial acknowledgement',async()=>{
  const fixture=poolFixture(),runner=createZaloTransactions(fixture.pool);
  await assert.rejects(runner.transaction(async tx=>{
    await tx.query('INSERT INTO zalo_inbound_events');
    throw Error('forced-rollback');
  }),/forced-rollback/);
  assert.deepEqual(fixture.operations.map(x=>x.sql),['BEGIN','INSERT INTO zalo_inbound_events','ROLLBACK']);
  assert.equal(fixture.counts().released,1);
});
test('composition receiver is compatible with AI0 raw webhook Port, fail closed without synthetic fixture',async()=>{
  const fixture=poolFixture();
  const pipeline=createZaloComposition({
    pool:fixture.pool, trusted_shop_id:'server-shop',trusted_oa_id:'server-oa',
    documents:{async inspect(){return []}},
    orders:{async suggest_draft(){throw Error('unexpected')},async route_human(){}},
    schedule:{allowed:()=>true},clock:{now:()=>new Date()},mode:'simulation'
  });
  const request=new TextEncoder().encode('{"customer_unverified":"x"}');
  const result=await pipeline.receive_webhook(request,{});
  assert.equal(result.status_code,403);
  assert.equal(fixture.counts().connection,0);
  assert.equal((await pipeline.tick_outbound()).disabled,true);
  assert.throws(()=>createZaloComposition({
    pool:fixture.pool, trusted_shop_id:'server-shop',trusted_oa_id:'server-oa',
    documents:{async inspect(){return []}},
    orders:{async suggest_draft(){return {order_id:'x',revision:1}},async route_human(){}},
    schedule:{allowed:()=>true},clock:{now:()=>new Date()},mode:'production'
  }),/ZALO_LIVE_DISABLED/);
});
