import {createHash,timingSafeEqual} from 'node:crypto';
import type {SqlPool} from '../storage/database.js';
import {DomainError} from '../core/model.js';
import {extractPilotPrintIntent} from '../conversation/pilot-print-intent.js';
import type {PilotCandidateBindingPort,SealedPilotSource} from '../conversation/pilot-word-pdf-intake.js';
import type {PilotWordPdfCandidate} from '../core/pilot-shop-code.js';
import type {InboundEvent} from '../integrations/zalo/protocol.js';

const deny=()=>new DomainError('PILOT_INGRESS_UNAVAILABLE','Verified OA event binding required',503);
const id=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256?v:null;
const digest=(v:string)=>createHash('sha256').update(v).digest();
/** Scoped server-to-server ingress; caller supplies event selectors only. Identity,
 * code and candidate are re-derived from durable verified events and private custody. */
export function createPilotIngressResolvers(db:SqlPool,token:string,binding:PilotCandidateBindingPort,
 readSealed:(input:{oa_id:string;provider_event_id:string;artifact_ref:string})=>Promise<Uint8Array|null>){
 if(token.length<32)throw deny();
 const authenticate=(request:{headers:Record<string,string|undefined>})=>{
  const supplied=request.headers.authorization?.startsWith('Bearer ')?request.headers.authorization.slice(7):'';
  if(!timingSafeEqual(digest(supplied),digest(token)))throw new DomainError('UNAUTHENTICATED','Service credential required',401);
 };
 const selected=async(oa:string,event:string):Promise<InboundEvent>=>{
  const rows=(await db.query<{payload_json:InboundEvent}>(
   'SELECT payload_json FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[oa,event])).rows;
  if(rows.length!==1||rows[0]?.payload_json.oa_id!==oa||rows[0].payload_json.event_id!==event)throw deny();
  return rows[0].payload_json;
 };
 return {
  async resolveCandidate(request:{headers:Record<string,string|undefined>;body?:unknown}){
   authenticate(request);
   const body=request.body as Record<string,unknown>|null;
   const oa=id(body?.oa_id),event=id(body?.source_event_id);
   if(!oa||!event||Object.keys(body??{}).sort().join(',')!=='oa_id,source_event_id')throw deny();
   const sourceEvent=await selected(oa,event);
   if(sourceEvent.kind!=='file')throw deny();
   const rows=(await db.query<SealedPilotSource&{shop_id:string}>(
    `SELECT s.shop_id,s.oa_id,s.customer_id,s.conversation_id,s.event_id AS provider_event_id,
     s.format,s.artifact_ref,s.sha256,s.size_bytes FROM ai0_pilot_private_sources s
     JOIN core_shop_zalo_oa_registry m ON m.shop_id=s.shop_id AND m.oa_id=s.oa_id
     WHERE s.oa_id=$1 AND s.event_id=$2`,[oa,event])).rows;
   if(rows.length!==1)throw deny();
   const row=rows[0]!;
   if(row.customer_id!==sourceEvent.customer_id||row.conversation_id!==sourceEvent.conversation_id||
      !(await readSealed({oa_id:oa,provider_event_id:event,artifact_ref:row.artifact_ref})))throw deny();
   const source={schema:'ai0.pilot_sealed_source.v1' as const,oa_id:oa,customer_id:row.customer_id,
    conversation_id:row.conversation_id,provider_event_id:event,format:row.format,
    artifact_ref:row.artifact_ref,sha256:row.sha256,size_bytes:Number(row.size_bytes)};
   const revisions=(await db.query<{request_data:{documents?:{copies:number;duplex:boolean}[]}}>(
    `SELECT v.request_data FROM core_orders o JOIN core_revisions v
     ON v.order_id=o.id AND v.revision=o.active_revision
     WHERE o.shop_id=$1 AND o.customer_id=$2 AND o.conversation_id=$3
      AND v.request_data->'documents'->0->>'artifact_name'=$4`,
    [row.shop_id,row.customer_id,row.conversation_id,row.artifact_ref])).rows;
   if(revisions.length!==1||revisions[0]?.request_data.documents?.length!==1)throw deny();
   const doc=revisions[0]!.request_data.documents![0]!;
   const candidate=await binding.bind({shop_id:row.shop_id,oa_id:oa,customer_id:row.customer_id,
    conversation_id:row.conversation_id,text_event_ids:[],source,
    settings:{copies:doc.copies,duplex:doc.duplex,paper:'A4',color:'black_white'}});
   if(!candidate)throw deny();
   return candidate;
  },
  async resolveCodeSubmission(request:{headers:Record<string,string|undefined>;body?:unknown}){
   authenticate(request);
   const body=request.body as Record<string,unknown>|null;
   const oa=id(body?.oa_id),event=id(body?.provider_event_id);
   if(!oa||!event||Object.keys(body??{}).sort().join(',')!=='oa_id,provider_event_id')throw deny();
   const text=await selected(oa,event);
   if(text.kind!=='text')throw deny();
   const intent=extractPilotPrintIntent([text]);
   if(intent?.code_event_id!==event||!intent.code_candidate)throw deny();
   const rows=(await db.query<PilotWordPdfCandidate>(
    `SELECT c.shop_id,c.oa_id,c.customer_id,c.conversation_id,c.order_id,c.revision,
     c.request_hash,c.settings_sha256,c.printer_id,
     jsonb_build_object('format',c.source_format,'artifact_ref',c.source_artifact_ref,
      'sha256',c.source_sha256,'size_bytes',c.source_size_bytes,
      'provider_event_id',c.source_event_id) AS source,c.settings
     FROM core_pilot_candidates c JOIN core_orders o ON o.id=c.order_id
     WHERE c.oa_id=$1 AND c.customer_id=$2 AND c.conversation_id=$3
      AND o.active_revision=c.revision AND NOT o.manual_lock AND NOT o.print_closed`,
    [oa,text.customer_id,text.conversation_id])).rows;
   if(rows.length!==1)throw deny();
   const candidate=rows[0]!;
   const rebound=await binding.bind({shop_id:candidate.shop_id,oa_id:oa,
    customer_id:text.customer_id,conversation_id:text.conversation_id,
    text_event_ids:[event],source:{schema:'ai0.pilot_sealed_source.v1',oa_id:oa,
     customer_id:text.customer_id,conversation_id:text.conversation_id,
     provider_event_id:candidate.source.provider_event_id,format:candidate.source.format,
     artifact_ref:candidate.source.artifact_ref,sha256:candidate.source.sha256,
     size_bytes:Number(candidate.source.size_bytes)},settings:candidate.settings});
   if(!rebound||rebound.order_id!==candidate.order_id||rebound.revision!==candidate.revision)throw deny();
   return {schema:'ai0.pilot_code_submission.v1' as const,shop_id:candidate.shop_id,oa_id:oa,
    customer_id:text.customer_id,conversation_id:text.conversation_id,
    order_id:candidate.order_id,revision:candidate.revision,provider_event_id:event,
    code:intent.code_candidate,idempotency_key:`ai0-event:${digest(`${oa}\0${event}`).toString('hex')}`};
  }
 };
}
