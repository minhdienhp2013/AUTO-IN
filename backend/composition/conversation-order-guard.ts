import type pg from 'pg';
import type {OrderDraftPort} from '../conversation/processor.js';
import {canonical,sha,DomainError} from '../core/model.js';

export interface ConversationGuardScope {
  readonly shop_id:string;
  readonly oa_id:string;
}
type Verified={event_id:string;customer_id:string;conversation_id:string;occurred_at:Date;received_at:Date};
type OpenRow={id:string;approved:boolean;print_closed:boolean;manual_lock:boolean};
type OldProposal={order_id:string};
type ClockRow={latest_approved_at:Date|null};
const nonempty=(v:unknown,max:number):v is string=>
  typeof v==='string'&&v.trim().length>0&&v.length<=max;

/**
 * CODE-008 bridge (simulation ONLY): batches and orders are different objects.
 * Serialize AI2 *draft decisions* for a trusted OA/shop/customer/conversation.
 *
 * A new batch arriving before staff approves an existing order is NEVER a new
 * order. AI2 will return HELD (durable Zalo batch becomes NEEDS_HUMAN) until
 * AI1 ships its transactionally checked append/revise Port.
 *
 * NO confirmation/approval/print or staff Principal is minted here.
 * A same-event retry still passes through AI1's idempotency contract.
 * This does not replace AI1's future cross-batch transactional gate.
 */
export function guardedSyntheticConversationOrders(
  pool:pg.Pool,scope:ConversationGuardScope,orders:OrderDraftPort
):OrderDraftPort{
  if(!pool||!nonempty(scope?.shop_id,128)||!nonempty(scope?.oa_id,128)||
     typeof orders?.suggest_draft!=='function'||typeof orders.route_human!=='function')
    throw new Error('CONVERSATION_ORDER_GUARD_UNCONFIGURED');
  return {
    route_human:request=>orders.route_human(request),
    async suggest_draft(input){
      if(!nonempty(input.conversation_id,256)||!nonempty(input.customer_id,256)||
         !Array.isArray(input.event_ids)||input.event_ids.length<1||
         input.event_ids.length>100||input.event_ids.some(x=>!nonempty(x,256)))
        throw new DomainError('INVALID_CONVERSATION_BATCH','Invalid verified batch',422);
      if(new Set(input.event_ids).size!==input.event_ids.length)
        throw new DomainError('DUPLICATE_AI_EVENTS','Duplicate verified events',422);
      const conn=await pool.connect();
      let ended=false;
      try{
        await conn.query('BEGIN');
        // PostgreSQL transactional advisory lock spans the downstream AI1
        // create transaction. All synthetic AI2 workers take the same key.
        await conn.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
          [JSON.stringify([scope.shop_id,scope.oa_id,input.customer_id,input.conversation_id])]
        );
        const mode=await conn.query<{mode:string}>(
          'SELECT mode FROM core_shop_settings WHERE shop_id=$1',[scope.shop_id]);
        if(mode.rows[0]?.mode!=='simulation')
          throw new DomainError('SIMULATION_REQUIRED','Live order guard disabled',409);
        const events=await conn.query<Verified>(
          'SELECT event_id,customer_id,conversation_id,occurred_at,received_at '+
          'FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[]) FOR SHARE',
          [scope.oa_id,[...input.event_ids]]
        );
        if(events.rows.length!==input.event_ids.length||
           events.rows.some(x=>x.customer_id!==input.customer_id||
             x.conversation_id!==input.conversation_id))
          throw new DomainError('UNVERIFIED_CONVERSATION_BATCH',
            'Cannot associate unverified batch with an order',403);
        // AI1 owns this fingerprint and revalidates the idempotency payload.
        const fp=sha(canonical({conversation_id:input.conversation_id,
          event_ids:[...input.event_ids].sort()}));
        const replay=await conn.query<OldProposal>(
          'SELECT order_id::text FROM core_ai_draft_proposals '+
          'WHERE shop_id=$1 AND oa_id=$2 AND event_fingerprint=$3',
          [scope.shop_id,scope.oa_id,fp]
        );
        if(!replay.rows.length){
          const open=await conn.query<OpenRow>(
            'SELECT o.id::text,o.manual_lock,o.print_closed, '+
            'EXISTS(SELECT 1 FROM core_approvals a WHERE a.order_id=o.id) AS approved '+
            'FROM core_orders o WHERE o.shop_id=$1 AND o.customer_id=$2 '+
            'AND o.conversation_id=$3 ORDER BY o.created_at DESC,o.id DESC',
            [scope.shop_id,input.customer_id,input.conversation_id]
          );
          // All not-yet-approved orders in the same chat belong to an ongoing
          // session, unless explicit intent to separate is verified by AI2.
          // Never guess which order to merge when more than one is present.
          const pending=open.rows.filter(x=>!x.approved&&!x.print_closed);
          if(pending.length||open.rows.some(x=>x.manual_lock)){
            await conn.query('COMMIT');ended=true;
            return {status:'stale_generation'};
          }
          // Both the provider event time and the DB-owned receipt time matter.
          // A client-controlled occurred_at in the future CANNOT turn a
          // pre-approval message into a fresh post-approval order.
          const prev=await conn.query<ClockRow>(
            'SELECT max(a.created_at) AS latest_approved_at FROM core_approvals a '+
            'JOIN core_orders o ON o.id=a.order_id '+
            'WHERE o.shop_id=$1 AND o.customer_id=$2 AND o.conversation_id=$3',
            [scope.shop_id,input.customer_id,input.conversation_id]
          );
          const closedAt=prev.rows[0]?.latest_approved_at?.getTime();
          if(closedAt!==undefined&&events.rows.some(e=>{
            const occurredAt=new Date(e.occurred_at).getTime();
            const receivedAt=new Date(e.received_at).getTime();
            return !Number.isFinite(occurredAt)||!Number.isFinite(receivedAt)||
              occurredAt<=closedAt||receivedAt<=closedAt;
          })){
            await conn.query('COMMIT');ended=true;
            return {status:'stale_generation'};
          }
        }
        const result=await orders.suggest_draft(input);
        await conn.query('COMMIT');ended=true;
        return result;
      }catch(error){
        if(!ended)try{await conn.query('ROLLBACK')}catch{}
        throw error;
      }finally{conn.release()}
    }
  };
}
