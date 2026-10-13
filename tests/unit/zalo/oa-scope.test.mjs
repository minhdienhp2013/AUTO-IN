import test from 'node:test';
import assert from 'node:assert/strict';
import {PostgresConversationQueue,PostgresOutboundRepository} from '../../../backend/integrations/zalo/postgres-durable.ts';
test('two queue workers filter inbound and claimed batches by their trusted OA',async()=>{
 const seen=[],db={async transaction(fn){return fn({async query(sql,params=[]){seen.push({sql,params});return {rows:[],rowCount:0}}})}};
 const q1=new PostgresConversationQueue(db,'oa-one'),q2=new PostgresConversationQueue(db,'oa-two');
 assert.equal(await q1.ingest_pending(),0);assert.equal((await q2.claim_due()).length,0);
 assert.equal(seen[0].params[1],'oa-one');assert.match(seen[0].sql,/q\.oa_id=\$2/);
 assert.equal(seen[1].params[1],'oa-two');assert.match(seen[1].sql,/oa_id=\$2/);
});
test('outbound SELECT and reconcile include shop and OA scope',async()=>{
 const seen=[],db={async transaction(fn){return fn({async query(sql,params=[]){seen.push({sql,params});return {rows:[],rowCount:0}}})}};
 const repo=new PostgresOutboundRepository(db,{async lock_if_current(){return false}},{shop_id:'shop-1',oa_id:'oa-one'});
 assert.deepEqual(await repo.list_queued(),[]);
 assert.equal(await repo.reconcile_stale_reserved(),0);
 for(const call of seen){assert.deepEqual(call.params.slice(-2),['shop-1','oa-one']);assert.match(call.sql,/shop_id=\$\d+ AND oa_id=\$\d+/);}
});
