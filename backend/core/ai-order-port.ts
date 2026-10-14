import { canonical, dbSafeInteger, DomainError, newId, sha } from './model.js';
import type { PgStore, SqlConnection } from '../storage/database.js';

/** Trusted OA/shop mapping is supplied by server composition, never by inbound input. */
export interface TrustedAiOrderScope { readonly shop_id: string; readonly oa_id: string }
export interface SuggestDraftInput {
  conversation_id: string; customer_id: string; event_ids: readonly string[];
  text: string; idempotency_key: string; expected_generation: number;
}
export interface RouteHumanInput {
  conversation_id: string; reason: string; event_ids: readonly string[]; expected_generation: number;
}
export type SuggestDraftResult = {status:'created'|'existing';order_id:string} | {status:'stale_generation'};
export type RouteHumanResult = {status:'routed'|'already_routed';generation:number} | {status:'stale_generation'};

function bounded(value:string, field:string, max:number):string {
  if(typeof value!=='string'||!value.trim()||value.length>max)
    throw new DomainError('INVALID_AI_INPUT','Invalid '+field,422);
  return value;
}
function normalizedEvents(value:readonly string[]):string[] {
  if(!Array.isArray(value)||value.length<1||value.length>100)
    throw new DomainError('INVALID_AI_EVENTS','Expected 1-100 verified event IDs',422);
  const ids=value.map(x=>bounded(x,'event_id',256));
  if(new Set(ids).size!==ids.length)
    throw new DomainError('DUPLICATE_AI_EVENTS','Duplicate event IDs',422);
  return ids.sort();
}
function validGeneration(value:number):number {
  if(!Number.isSafeInteger(value)||value<0)
    throw new DomainError('INVALID_AI_GENERATION','Invalid generation',422);
  return value;
}

/** Internal-only transactional AI2 port: no staff principal, confirmation, quote, approval or print job. */
export function createAiOrderPort(options:{store:PgStore;trusted:TrustedAiOrderScope}) {
  const {store,trusted}=options;
  if(!store?.tx||!trusted||typeof trusted.shop_id!=='string'||
      typeof trusted.oa_id!=='string'||!trusted.shop_id.trim()||!trusted.oa_id.trim()||
      trusted.shop_id.length>128||trusted.oa_id.length>256)
    throw new DomainError('AI_PORT_NOT_CONFIGURED','Missing trusted OA/shop server configuration',503);
  const shopId=trusted.shop_id,oaId=trusted.oa_id; // snapshot, not mutable caller settings

  async function verifiedBinding(db:SqlConnection,conversationId:string,eventIds:string[],customerId?:string):Promise<string> {
    const shop=await db.query('SELECT shop_id FROM core_shop_settings WHERE shop_id=$1 FOR SHARE',[shopId]);
    if(shop.rows.length!==1)throw new DomainError('AI_SHOP_NOT_FOUND','Unknown shop',403);
    const rows=await db.query<{event_id:string;conversation_id:string;customer_id:string}>(
      'SELECT event_id,conversation_id,customer_id FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[]) FOR SHARE',
      [oaId,eventIds]);
    if(rows.rows.length!==eventIds.length)throw new DomainError('UNVERIFIED_AI_EVENTS','Verified inbound events missing',403);
    const bound=rows.rows[0]?.customer_id;
    if(!bound||rows.rows.some(row=>row.conversation_id!==conversationId||row.customer_id!==bound))
      throw new DomainError('AI_EVENT_BINDING_MISMATCH','Events belong to different conversations/customers',403);
    if(customerId!==undefined&&customerId!==bound)
      throw new DomainError('AI_CUSTOMER_MISMATCH','Customer differs from verified Zalo event',403);
    const linked=await db.query(
      'SELECT id FROM core_orders WHERE shop_id=$1 AND conversation_id=$2 AND customer_id<>$3 LIMIT 1 FOR SHARE',
      [shopId,conversationId,bound]);
    if(linked.rows.length)throw new DomainError('AI_CONVERSATION_CUSTOMER_CONFLICT','Conversation linked to another customer',409);
    return bound;
  }
  async function lockedControl(db:SqlConnection,conversationId:string,expected:number) {
    type ControlRow={status:'AI'|'HUMAN';generation:string|number;
      claimed_by:string|null;ai_route_fingerprint:string|null};
    const query='SELECT status,generation,claimed_by,ai_route_fingerprint FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE';
    const first=await db.query<ControlRow>(query,[shopId,conversationId]);
    if(!first.rows[0] && expected!==0)
      return null; // Stale generation may not create a conversation control as a side effect.
    if(!first.rows[0]) {
      // Verified first event may initialize generation 0. Concurrent inserts serialize by PK.
      await db.query('INSERT INTO core_conversation_controls(shop_id,conversation_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [shopId,conversationId]);
    }
    const c=first.rows[0]??(await db.query<ControlRow>(query,[shopId,conversationId])).rows[0];
    if(!c)throw new DomainError('AI_CONVERSATION_NOT_FOUND','Conversation control missing',409);
    return {...c,generation:dbSafeInteger(c.generation,'conversation.generation')};
  }

  async function suggest_draft(input:SuggestDraftInput):Promise<SuggestDraftResult> {
    const conv=bounded(input.conversation_id,'conversation_id',256);
    const customer=bounded(input.customer_id,'customer_id',256);
    const ids=normalizedEvents(input.event_ids);
    const text=bounded(input.text,'text',4000);
    const key=bounded(input.idempotency_key,'idempotency_key',128);
    const expected=validGeneration(input.expected_generation);
    const fingerprint=sha(canonical({conversation_id:conv,event_ids:ids}));
    const contentHash=sha(canonical({conversation_id:conv,customer_id:customer,text,expected_generation:expected}));
    return store.tx(async db=>{
      await verifiedBinding(db,conv,ids,customer);
      const control=await lockedControl(db,conv,expected);
      if(!control||control.generation!==expected||control.status!=='AI')return {status:'stale_generation'};
      const old=await db.query<{order_id:string;event_fingerprint:string;content_hash:string}>(
        'SELECT order_id,event_fingerprint,content_hash FROM core_ai_draft_proposals WHERE shop_id=$1 AND oa_id=$2 AND (event_fingerprint=$3 OR idempotency_key=$4) FOR UPDATE',
        [shopId,oaId,fingerprint,key]);
      if(old.rows.length) {
        const match=old.rows[0];
        if(old.rows.length!==1||match?.event_fingerprint!==fingerprint||match.content_hash!==contentHash)
          throw new DomainError('AI_DRAFT_IDEMPOTENCY_CONFLICT','Conflicting event/key or payload',409);
        return {status:'existing',order_id:match.order_id};
      }
      const orderId=newId();
      const requestData={source:'zalo_ai_suggestion',conversation_id:conv,event_ids:ids,text};
      const requestHash=sha(canonical(requestData));
      await db.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id) VALUES($1,$2,$3,$4)',
        [orderId,shopId,customer,conv]);
      await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
        [orderId,requestHash,JSON.stringify(requestData)]);
      await db.query('INSERT INTO core_ai_draft_proposals(shop_id,oa_id,conversation_id,customer_id,event_fingerprint,idempotency_key,content_hash,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [shopId,oaId,conv,customer,fingerprint,key,contentHash,orderId]);
      await db.query('INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [newId(),shopId,'zalo:service:'+oaId,'ai.draft_suggested',orderId,
         JSON.stringify({event_count:ids.length,event_fingerprint:fingerprint})]);
      return {status:'created',order_id:orderId};
    });
  }

  async function route_human(input:RouteHumanInput):Promise<RouteHumanResult> {
    const conv=bounded(input.conversation_id,'conversation_id',256);
    const reason=bounded(input.reason,'reason',500);
    const ids=normalizedEvents(input.event_ids);
    const expected=validGeneration(input.expected_generation);
    const fingerprint=sha(canonical({conversation_id:conv,event_ids:ids}));
    return store.tx(async db=>{
      await verifiedBinding(db,conv,ids);
      const control=await lockedControl(db,conv,expected);
      // Strict generation CAS: an identical retry with an outdated generation is STALE.
      // Only a HUMAN conversation at the CURRENT generation can return already_routed.
      if(!control||control.generation!==expected)return {status:'stale_generation'};
      if(control.status==='HUMAN')return {status:'already_routed',generation:control.generation};
      if(expected>=Number.MAX_SAFE_INTEGER)
        throw new DomainError('AI_GENERATION_OVERFLOW','Generation limit reached',409);
      const next=expected+1;
      await db.query("UPDATE core_conversation_controls SET status='HUMAN',claimed_by=NULL,generation=$3,ai_route_fingerprint=$4,ai_route_reason=$5,updated_at=now() WHERE shop_id=$1 AND conversation_id=$2",
        [shopId,conv,next,fingerprint,reason]);
      return {status:'routed',generation:next};
    });
  }
  return {suggest_draft,route_human};
}
