import {createHash} from 'node:crypto';
import {assertStaff,canonical,DomainError,type Principal} from '../core/model.js';
import type {OrderService} from '../core/service.js';
import type {SqlPool} from '../storage/database.js';
import type {SyntheticArtifactScope} from './synthetic-ingest.js';
import {verifiedSyntheticSource} from './inbound-draft.js';
import {adoptSyntheticSuggestedSource} from './synthetic-suggestion-adopt.js';

type Result=Awaited<ReturnType<typeof adoptSyntheticSuggestedSource>>;
const fail=(code:string,status=409):never=>{
  throw new DomainError(code,'Staff source adoption requires review',status);
};
/** No connection/transaction is held while Core revises: this avoids starving
 * the bounded pool when several independent HTTP requests adopt concurrently.
 * A crash between reservation, Core commit and receipt commit stays PENDING.
 * It never invokes Core again automatically to guess what happened.
 */
export async function adoptSyntheticSourceHttp(
  pool:SqlPool,service:Pick<OrderService,'revise'>,root:string,
  scope:SyntheticArtifactScope,actor:Principal,eventId:string,input:unknown
):Promise<Result>{
  assertStaff(actor);
  if(actor.shop_id!==scope.shop_id)return fail('FORBIDDEN',403);
  if(!input||typeof input!=='object'||Array.isArray(input))return fail('INVALID_INPUT',422);
  const i=input as Record<string,unknown>;
  if(Object.keys(i).sort().join(',')!=='copies,duplex,idempotency_key,order_id,paper'||
    typeof i.order_id!=='string'||! /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(i.order_id)||
    typeof i.idempotency_key!=='string'||! /^[A-Za-z0-9:_-]{1,128}$/.test(i.idempotency_key)||
    !/^[A-Za-z0-9_-]{1,128}$/.test(eventId)||
    (i.paper!=='A4'&&i.paper!=='A3')||!Number.isSafeInteger(i.copies)||
    (i.copies as number)<1||(i.copies as number)>20||typeof i.duplex!=='boolean')
    return fail('INVALID_INPUT',422);
  const settings={order_id:i.order_id,event_id:eventId,paper:i.paper as 'A4'|'A3',
    copies:i.copies as number,duplex:i.duplex};
  const key=i.idempotency_key;
  const digest=createHash('sha256').update(canonical(settings)).digest('hex');
  const mode=await pool.query<{mode:string}>(
    'SELECT mode FROM core_shop_settings WHERE shop_id=$1',[scope.shop_id]);
  if(mode.rows[0]?.mode!=='simulation')return fail('SIMULATION_REQUIRED');
  const previous=await pool.query<{actor_id:string;idempotency_key:string;oa_id:string;event_id:string;
    payload_sha256:string;response:Result|null}>(
    'SELECT actor_id,idempotency_key,oa_id,event_id,payload_sha256,response FROM ai0_source_adoption_receipts '+
    'WHERE shop_id=$1 AND ((actor_id=$2 AND idempotency_key=$3) OR (oa_id=$4 AND event_id=$5))',
    [scope.shop_id,actor.id,key,scope.oa_id,eventId]);
  const replay=()=>{
    const row=previous.rows[0];
    if(previous.rows.length!==1||row?.actor_id!==actor.id||row.idempotency_key!==key||
      row.oa_id!==scope.oa_id||row.event_id!==eventId||row.payload_sha256!==digest)
      return fail('IDEMPOTENCY_CONFLICT');
    if(!row.response)return fail('SOURCE_ADOPTION_PENDING_RECONCILIATION');
    if(row.response.status!=='adopted'||row.response.order_id!==settings.order_id||
      row.response.revision!==2||row.response.requires_customer_confirmation!==true||
      row.response.preview_trusted!==false)return fail('SOURCE_ADOPTION_RECEIPT_INVALID');
    return row.response;
  };
  if(previous.rows.length)return replay();
  // Validate the server-bound frozen source before reserving its receipt.
  await verifiedSyntheticSource(pool,root,scope,eventId);
  const inserted=await pool.query(
    'INSERT INTO ai0_source_adoption_receipts '+
    '(shop_id,actor_id,idempotency_key,oa_id,event_id,payload_sha256) '+
    "SELECT $1,$2,$3,$4,$5,$6 FROM core_shop_settings WHERE shop_id=$1 AND mode='simulation' "+
    'ON CONFLICT DO NOTHING RETURNING event_id',
    [scope.shop_id,actor.id,key,scope.oa_id,eventId,digest]);
  if(inserted.rowCount!==1)return fail('SOURCE_ADOPTION_IN_PROGRESS');
  const result=await adoptSyntheticSuggestedSource(pool,service,root,scope,actor,settings);
  const stored=await pool.query(
    'UPDATE ai0_source_adoption_receipts SET response=$4::jsonb,completed_at=now() '+
    'WHERE shop_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND response IS NULL RETURNING event_id',
    [scope.shop_id,actor.id,key,JSON.stringify(result)]);
  if(stored.rowCount!==1)return fail('SOURCE_ADOPTION_PENDING_RECONCILIATION');
  return result;
}
