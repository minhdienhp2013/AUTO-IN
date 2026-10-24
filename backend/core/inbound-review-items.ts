import {randomUUID} from 'node:crypto';
import {assertStaff,DomainError,type Principal} from './model.js';
import type {PgStore,SqlConnection} from '../storage/database.js';

export interface TrustedOfficialInboundScope {readonly shop_id:string;readonly oa_id:string}
export interface QuarantinedInboundReviewItem {
 source:'quarantine';id:string;raw_event_sha256:string;
 kind:'image'|'file';mapped_customer:boolean;status:'NEEDS_HUMAN';
 media_state:'AWAITING_MEDIA';received_at:string;
}
export interface PilotIntakeReviewItem {
 source:'pilot_intake';id:string;kind:'pilot_intake';status:'NEEDS_HUMAN';
 received_at:string;reason_code?:'COLOR_PRINT';
}
export type InboundReviewItem=QuarantinedInboundReviewItem|PilotIntakeReviewItem;
type QuarantineRow={id:string;raw_sha256:string;kind:string;status:string;
 customer_id:string|null;conversation_id:string|null;received_at:Date|string};
type QuarantineReviewRow={id:string;raw_event_sha256:string;kind:'image'|'file';
 mapped_customer:boolean;status:'NEEDS_HUMAN';media_state:'AWAITING_MEDIA';received_at:Date|string};
type PilotIntakeReviewRow={id:string;status:'NEEDS_HUMAN';close_reason:string|null;opened_at:Date|string};

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=/^[0-9a-f]{64}$/;
const unavailable=()=>new DomainError('INBOUND_REVIEW_UNAVAILABLE',
 'Không thể lưu hàng chờ nhân viên cho sự kiện OA',503,true);

/** Server-internal AI1 port. The trusted scope is created by composition from
 * the registered OA/shop map; no event or tenant fields are accepted from a client.
 * It references signed quarantine metadata only. Media download/materialization
 * remains pending until AI0/AI2 supplies a verified private artifact store.
 */
export function createOfficialInboundReviewItems(options:{store:PgStore;trusted:TrustedOfficialInboundScope}){
 const {store,trusted}=options;
 if(!store?.tx||!trusted||typeof trusted.shop_id!=='string'||!trusted.shop_id.trim()||
    typeof trusted.oa_id!=='string'||!trusted.oa_id.trim()||trusted.shop_id.length>128||trusted.oa_id.length>128)
  throw new DomainError('INBOUND_REVIEW_NOT_CONFIGURED','Thiếu scope OA/shop tin cậy',503);
 const shopId=trusted.shop_id,oaId=trusted.oa_id;

 async function enqueue_quarantined_event(quarantineId:string):Promise<{status:'created'|'existing';item_id:string;media_state:'AWAITING_MEDIA'}>{
  if(typeof quarantineId!=='string'||!uuid.test(quarantineId))
   throw new DomainError('INVALID_QUARANTINE_ID','ID quarantine không hợp lệ',422);
  return store.tx(async db=>{
   try{
    const relations=(await db.query<{registry:string|null;quarantine:string|null;scopes:string|null;items:string|null}>(
     "SELECT to_regclass('public.core_shop_zalo_oa_registry')::text AS registry,"+
     "to_regclass('public.zalo_official_quarantine')::text AS quarantine,"+
     "to_regclass('public.zalo_official_quarantine_scopes')::text AS scopes,"+
     "to_regclass('public.core_inbound_review_items')::text AS items")).rows[0];
    if(!relations?.registry||!relations.quarantine||!relations.scopes||!relations.items)throw unavailable();
    await db.query('INSERT INTO public.zalo_official_quarantine_scopes(oa_id) VALUES($1) ON CONFLICT(oa_id) DO NOTHING',[oaId]);
    const scope=(await db.query<{oa_id:string}>(
     'SELECT oa_id FROM public.zalo_official_quarantine_scopes WHERE oa_id=$1 FOR UPDATE',[oaId])).rows[0];
    if(scope?.oa_id!==oaId)throw unavailable();
    const row=(await db.query<QuarantineRow>(
     'SELECT q.id::text,q.raw_sha256,q.kind,q.status,q.customer_id,q.conversation_id,q.received_at '+
     'FROM public.zalo_official_quarantine q '+
     'JOIN public.core_shop_zalo_oa_registry r ON r.oa_id=q.oa_id '+
     'WHERE r.shop_id=$1 AND q.oa_id=$2 AND q.id=$3 FOR SHARE OF q,r',
     [shopId,oaId,quarantineId])).rows[0];
    if(!row||!['image','file'].includes(row.kind)||row.status!=='NEEDS_HUMAN'||
       !digest.test(row.raw_sha256.trim())||((row.customer_id===null)!==(row.conversation_id===null)))
     throw new DomainError('QUARANTINE_SOURCE_NOT_PENDING',
      'Sự kiện không thuộc OA/shop này hoặc không còn ở trạng thái cần nhân viên',409);
    const itemId=randomUUID();
    const inserted=await db.query<{id:string}>(
     'INSERT INTO core_inbound_review_items '+
     '(id,shop_id,oa_id,quarantine_id,raw_event_sha256,kind,customer_id,conversation_id,received_at) '+
     'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(shop_id,oa_id,quarantine_id) DO NOTHING RETURNING id',
     [itemId,shopId,oaId,quarantineId,row.raw_sha256.trim(),row.kind,row.customer_id,row.conversation_id,row.received_at]);
    if(inserted.rowCount===1){
     await db.query('INSERT INTO core_inbound_review_audit_events(id,item_id,shop_id,actor_id,action,details) '+
      "VALUES($1,$2,$3,$4,'inbound.file_held_for_staff',$5::jsonb)",
      [randomUUID(),itemId,shopId,'zalo:quarantine:'+oaId,JSON.stringify({item_id:itemId,
       quarantine_id:quarantineId,raw_event_sha256:row.raw_sha256.trim(),kind:row.kind,
       media_state:'AWAITING_MEDIA'})]);
     return {status:'created',item_id:itemId,media_state:'AWAITING_MEDIA'};
    }
    const old=(await db.query<{id:string;raw_event_sha256:string;kind:string;
      customer_id:string|null;conversation_id:string|null;status:string;media_state:string}>(
     'SELECT id::text,raw_event_sha256,kind,customer_id,conversation_id,status,media_state '+
     'FROM core_inbound_review_items WHERE shop_id=$1 AND oa_id=$2 AND quarantine_id=$3 FOR UPDATE',
     [shopId,oaId,quarantineId])).rows[0];
    if(!old||old.raw_event_sha256.trim()!==row.raw_sha256.trim()||old.kind!==row.kind||
       old.customer_id!==row.customer_id||old.conversation_id!==row.conversation_id||
       old.status!=='NEEDS_HUMAN'||old.media_state!=='AWAITING_MEDIA')
     throw new DomainError('INBOUND_REVIEW_REPLAY_CONFLICT','Nguồn đã lưu có provenance khác',409);
    return {status:'existing',item_id:old.id,media_state:'AWAITING_MEDIA'};
   }catch(error){
    if(error instanceof DomainError)throw error;
    throw unavailable();
   }
  });
 }

 return {enqueue_quarantined_event};
}

/** Read-only staff queue reader: independent from OA-scoped event ingestion. */
export function createInboundReviewReader(options:{store:PgStore}){
 const {store}=options;
 if(!store?.pool||typeof store.pool.query!=='function')
  throw new DomainError('INBOUND_REVIEW_NOT_CONFIGURED','Thiếu PostgreSQL cho hàng chờ nhân viên',503);
 async function list_for_staff(actor:Principal):Promise<InboundReviewItem[]>{
  assertStaff(actor);
  try{
   const [quarantine,intakes]=await Promise.all([
    store.pool.query<QuarantineReviewRow>(
    "SELECT id::text,item.raw_event_sha256,item.kind, "+
    "(item.customer_id IS NOT NULL) AS mapped_customer,item.status,item.media_state,item.received_at "+
    'FROM core_inbound_review_items item WHERE item.shop_id=$1 '+
    'ORDER BY item.received_at,item.id LIMIT 100',[actor.shop_id]),
    store.pool.query<PilotIntakeReviewRow>(
     "SELECT id::text,status,close_reason,opened_at FROM core_oa_intake_batches "+
     "WHERE shop_id=$1 AND purpose='PILOT' AND status='NEEDS_HUMAN' "+
     'ORDER BY opened_at,id LIMIT 100',[actor.shop_id]),
   ]);
   const timestamp=(value:Date|string)=>{
    const parsed=value instanceof Date?value:new Date(value);
    if(!Number.isFinite(parsed.getTime()))throw unavailable();
    return parsed.toISOString();
   };
   const rows:InboundReviewItem[]=[
    ...quarantine.rows.map(row=>({source:'quarantine' as const,id:row.id,
     raw_event_sha256:row.raw_event_sha256,kind:row.kind,mapped_customer:row.mapped_customer,
     status:row.status,media_state:row.media_state,received_at:timestamp(row.received_at)})),
    ...intakes.rows.map(row=>({source:'pilot_intake' as const,id:row.id,kind:'pilot_intake' as const,
     status:row.status,received_at:timestamp(row.opened_at),
     ...(row.close_reason==='COLOR_PRINT'?{reason_code:'COLOR_PRINT' as const}:{})})),
   ];
   rows.sort((a,b)=>Date.parse(a.received_at)-Date.parse(b.received_at)||
    a.source.localeCompare(b.source)||a.id.localeCompare(b.id));
   return rows.length<=100?rows:rows.slice(-100);
  }catch{throw unavailable();}
 }
 return {list_for_staff};
}
