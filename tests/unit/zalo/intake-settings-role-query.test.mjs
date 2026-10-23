import test from 'node:test';
import assert from 'node:assert/strict';
import {PostgresConversationQueue} from '../../../backend/integrations/zalo/postgres-durable.ts';

const scope={
  intake_batch_id:'123e4567-e89b-42d3-a456-426614174000',
  queue_batch_id:'44',lease_token:'123e4567-e89b-42d3-a456-426614174001',
  oa_id:'oa-1',customer_id:'customer-1',conversation_id:'chat-1',event_ids:['settings-1']
};
const settings={event_id:'settings-1',oa_id:'oa-1',customer_id:'customer-1',
  conversation_id:'chat-1',occurred_at:'2026-10-23T00:00:00Z',kind:'text',
  text:'A4, in 2 bản, hai mặt, đen trắng'};

function dbHarness({bound=true}={}){
  const queries=[];
  const db={async transaction(action){
    return action({async query(sql,params=[]){
      queries.push({sql,params});
      if(sql.includes('FROM zalo_batches'))return {rows:[{oa_id:scope.oa_id}],rowCount:1};
      if(sql.includes('FROM core_oa_intake_event_bindings'))
        return {rows:bound?[{event_id:settings.event_id,payload_json:settings}]:[],rowCount:bound?1:0};
      assert.fail(`unexpected query: ${sql}`);
    }});
  }};
  return {db,queries};
}

test('settings reader binds exact event IDs to the active intake scope and SETTINGS role',async()=>{
  const h=dbHarness(),queue=new PostgresConversationQueue(h.db,scope.oa_id);
  assert.deepEqual(await queue.read_intake_settings_events(scope),[settings]);
  const query=h.queries.find(item=>item.sql.includes('FROM core_oa_intake_event_bindings'));
  assert.ok(query);
  assert.match(query.sql,/b\.intake_batch_id=\$1::uuid/);
  assert.match(query.sql,/b\.role='SETTINGS'/);
  assert.match(query.sql,/i\.status IN \('OPEN','BOUND'\)/);
  assert.match(query.sql,/i\.expires_at>clock_timestamp\(\)/);
  assert.deepEqual(query.params,[scope.intake_batch_id,scope.event_ids,scope.oa_id,
    scope.customer_id,scope.conversation_id]);
});

test('settings event without an immutable SETTINGS binding in this intake is rejected',async()=>{
  const h=dbHarness({bound:false}),queue=new PostgresConversationQueue(h.db,scope.oa_id);
  await assert.rejects(queue.read_intake_settings_events(scope),/PILOT_SETTINGS_EVENTS_UNVERIFIED/);
});
