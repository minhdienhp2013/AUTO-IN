import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** A leased durable Zalo queue batch assembled only from already persisted synthetic events. */
export async function acceptPilotQueueFixture(pool,service,{oa,fileEvent,settingsEvent,codeEvent}){
 const eventIds=[fileEvent,settingsEvent,codeEvent];
 const leaseToken=randomUUID();
 const batch=(await pool.query(
  "INSERT INTO zalo_batches(batch_key,oa_id,event_count,status,lease_token,lease_until) "+
  "VALUES($1,$2,$3,'LEASED',$4,clock_timestamp()+interval '10 minutes') RETURNING id::text AS id",
  [JSON.stringify([oa,randomUUID()]),oa,eventIds.length,leaseToken])).rows[0];
 assert.ok(batch?.id);
 for(const eventId of eventIds)await pool.query(
  'INSERT INTO zalo_batch_items(batch_id,oa_id,event_id) VALUES($1,$2,$3)',
  [batch.id,oa,eventId]);
 const accepted=await service.acceptIncomingQueueBatch({queue_batch_id:batch.id,
  lease_token:leaseToken,purpose:'PILOT',event_ids:eventIds,
  selection:{source_event_id:fileEvent,settings_event_ids:[settingsEvent],code_event_id:codeEvent}});
 assert.equal(accepted.status,'OPEN');
 assert.equal(accepted.readiness,'READY');
 assert.equal(accepted.queue_batch_id,batch.id);
 const receiptOrder=(await pool.query(
  'SELECT event_id FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[]) ORDER BY received_at,event_id',
  [oa,eventIds])).rows.map(row=>row.event_id);
 assert.deepEqual(accepted.events.map(event=>event.event_id),receiptOrder);
 assert.deepEqual(Object.fromEntries(accepted.events.map(event=>[event.event_id,event.role])),
  {[fileEvent]:'SOURCE',[settingsEvent]:'SETTINGS',[codeEvent]:'CODE'});
 return {queueBatchId:batch.id,intakeBatchId:accepted.intake_batch_id,leaseToken};
}
