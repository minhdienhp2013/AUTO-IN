import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {SqlPool,SqlConnection} from '../storage/database.js';
import {canonical,sha} from '../core/model.js';
import {pilotSettingsHash,type PilotWordPdfCandidate} from '../core/pilot-shop-code.js';
import type {PilotSourceCustodyPort,PilotCandidateBindingPort,SealedPilotSource} from '../conversation/pilot-word-pdf-intake.js';
import type {TrustedPdfReviewSourceReader} from '../core/pdf-review-source.js';
import type {TrustedWordReviewSourceReader} from '../core/word-review-source.js';

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const refPattern=/^doc-[a-f0-9]{32}\/source-000-([a-f0-9]{64})\.(pdf|docx)$/;
const fail=()=>new Error('PILOT_PRIVATE_SOURCE_UNVERIFIED');
type Row={shop_id:string;oa_id:string;event_id:string;customer_id:string;conversation_id:string;
 format:'PDF'|'DOCX';artifact_ref:string;sha256:string;size_bytes:string|number};
type Bound=Row&{order_id:string;revision:number;request_hash:string;request_data:unknown;
 plan:unknown;active_revision:number;order_customer:string;order_conversation:string|null;
 manual_lock:boolean;print_closed:boolean;printer_id:string;enabled:boolean;allow_real_print:boolean};
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

/** Server-owned custody: only a trusted media port may call seal. The durable
 * verified event and OA/shop registry must already exist before bytes are written. */
export function createPilotPrivateSourcePorts(db:SqlPool,root:string):{
 custody:PilotSourceCustodyPort;binding:PilotCandidateBindingPort;
 pdfSource:TrustedPdfReviewSourceReader;wordSource:TrustedWordReviewSourceReader
}{
 if(!root||!root.startsWith('/'))throw fail();
 const checkedRoot=async()=>{
  await mkdir(root,{recursive:true,mode:0o700});
  const stat=await lstat(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw fail();
 };
 const verified=async(oa:string,event:string,customer:string,conversation:string)=>{
  const rows=(await db.query<{shop_id:string;customer_id:string;conversation_id:string;kind:string}>(
   `SELECT m.shop_id,e.customer_id,e.conversation_id,e.payload_json->>'kind' AS kind
    FROM zalo_inbound_events e JOIN core_shop_zalo_oa_registry m ON m.oa_id=e.oa_id
    WHERE e.oa_id=$1 AND e.event_id=$2`,[oa,event])).rows;
  if(rows.length!==1||rows[0]?.kind!=='file'||rows[0].customer_id!==customer||
   rows[0].conversation_id!==conversation)throw fail();
  return rows[0].shop_id;
 };
 const lookup=async(oa:string,event:string)=>
  (await db.query<Row>('SELECT * FROM ai0_pilot_private_sources WHERE oa_id=$1 AND event_id=$2',[oa,event])).rows[0];
 const read=async(row:Row):Promise<Uint8Array>=>{
  await checkedRoot();
  const match=refPattern.exec(row.artifact_ref);
  if(!match||match[1]!==row.sha256||match[2] !== (row.format==='PDF'?'pdf':'docx'))throw fail();
  const dir=join(root,row.artifact_ref.split('/')[0]!);
  const dirStat=await lstat(dir);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||(dirStat.mode&0o077))throw fail();
  const handle=await open(join(root,row.artifact_ref),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=await handle.stat();
   if(!stat.isFile()||stat.size!==Number(row.size_bytes)||stat.size<1||stat.size>25*1024*1024||
     (stat.mode&0o077))throw fail();
   const bytes=await handle.readFile();
   if(bytes.length!==stat.size||digest(bytes)!==row.sha256)throw fail();
   return bytes;
  }finally{await handle.close();}
 };
 const custody:PilotSourceCustodyPort={
  async seal(input){
   if(!['PDF','DOCX'].includes(input.format)||input.size_bytes!==input.bytes.byteLength||
      input.size_bytes<1||input.size_bytes>25*1024*1024||digest(input.bytes)!==input.sha256)throw fail();
   const shop=await verified(input.oa_id,input.provider_event_id,input.customer_id,input.conversation_id);
   await checkedRoot();
   const existing=await lookup(input.oa_id,input.provider_event_id);
   if(existing){
    if(existing.shop_id!==shop||existing.customer_id!==input.customer_id||
       existing.conversation_id!==input.conversation_id||existing.format!==input.format||
       existing.sha256!==input.sha256||Number(existing.size_bytes)!==input.size_bytes)throw fail();
    await read(existing);
    return {schema:'ai0.pilot_sealed_source.v1',oa_id:existing.oa_id,customer_id:existing.customer_id,
     conversation_id:existing.conversation_id,provider_event_id:existing.event_id,
     format:existing.format,artifact_ref:existing.artifact_ref,sha256:existing.sha256,
     size_bytes:Number(existing.size_bytes)};
   }
   const folder=`doc-${randomUUID().replaceAll('-','')}`;
   const artifact_ref=`${folder}/source-000-${input.sha256}.${input.format==='PDF'?'pdf':'docx'}`;
   const dir=join(root,folder),file=join(root,artifact_ref);
   await mkdir(dir,{mode:0o700});
   try{
    const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
    try{await handle.writeFile(input.bytes);await handle.sync();}finally{await handle.close();}
    const inserted=await db.query<Row>(`INSERT INTO ai0_pilot_private_sources
     (shop_id,oa_id,event_id,customer_id,conversation_id,format,artifact_ref,sha256,size_bytes)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(oa_id,event_id) DO NOTHING RETURNING *`,
     [shop,input.oa_id,input.provider_event_id,input.customer_id,input.conversation_id,input.format,
      artifact_ref,input.sha256,input.size_bytes]);
    const row=inserted.rows[0]??await lookup(input.oa_id,input.provider_event_id);
    if(!row||row.shop_id!==shop||row.customer_id!==input.customer_id||
       row.conversation_id!==input.conversation_id||row.format!==input.format||
       row.sha256!==input.sha256||Number(row.size_bytes)!==input.size_bytes)throw fail();
    await read(row);
    return {schema:'ai0.pilot_sealed_source.v1',oa_id:row.oa_id,customer_id:row.customer_id,
     conversation_id:row.conversation_id,provider_event_id:row.event_id,format:row.format,
     artifact_ref:row.artifact_ref,sha256:row.sha256,size_bytes:Number(row.size_bytes)};
   }finally{
    if(!(await lookup(input.oa_id,input.provider_event_id))?.artifact_ref?.startsWith(`${folder}/`))
     await unlink(file).catch(()=>{});
   }
  },
  async read_sealed(input){
   const row=await lookup(input.oa_id,input.provider_event_id);
   return row?.artifact_ref===input.artifact_ref?read(row):null;
  }
 };
 const bound=async(conn:Pick<SqlConnection,'query'>,scope:{shop_id:string;order_id:string;active_revision:number;request_hash:string;request_data:unknown})=>{
  const rows=(await conn.query<Bound>(`SELECT s.*,o.id AS order_id,v.revision,v.request_hash,v.request_data,v.plan,
    o.active_revision,o.customer_id AS order_customer,o.conversation_id AS order_conversation,
    o.manual_lock,o.print_closed,c.printer_id,c.enabled,c.allow_real_print
    FROM ai0_pilot_private_sources s JOIN core_orders o ON o.shop_id=s.shop_id
      AND o.customer_id=s.customer_id AND o.conversation_id=s.conversation_id
    JOIN core_revisions v ON v.order_id=o.id AND v.revision=o.active_revision
    JOIN core_pilot_shop_config c ON c.shop_id=s.shop_id
    WHERE s.shop_id=$1 AND o.id=$2 AND v.revision=$3 AND v.request_hash=$4
      AND v.request_data->'documents'->0->>'artifact_name'=s.artifact_ref`,
   [scope.shop_id,scope.order_id,scope.active_revision,scope.request_hash])).rows;
  if(rows.length!==1)return null;
  const row=rows[0]!;
  if(row.active_revision!==row.revision||row.manual_lock||row.print_closed||!row.enabled||
     row.allow_real_print||row.order_customer!==row.customer_id||row.order_conversation!==row.conversation_id||
     !equal(row.request_data,scope.request_data)||sha(canonical(row.request_data))!==row.request_hash||
     row.shop_id!==scope.shop_id)return null;
  const doc=(row.request_data as {documents?:unknown[]})?.documents;
  if(!Array.isArray(doc)||doc.length!==1||!equal(doc[0],{
   artifact_name:row.artifact_ref,copies:(doc[0] as any)?.copies,
   duplex:(doc[0] as any)?.duplex,paper:'A4'})||
   (doc[0] as any).artifact_name!==row.artifact_ref)return null;
  const plan=row.plan as Record<string,unknown>|null;
  if(!plan||plan.ready!==true||plan.request_hash!==row.request_hash||
     plan.artifact_ref!==row.artifact_ref||plan.printer_id!==row.printer_id||
     typeof plan.verified_by!=='string'||!plan.verified_by||
     !Number.isSafeInteger(plan.physical_sheets)||Number(plan.physical_sheets)<1||Number(plan.physical_sheets)>150)return null;
  return row;
 };
 const binding:PilotCandidateBindingPort={async bind(input){
  if(input.source.oa_id!==input.oa_id||input.source.customer_id!==input.customer_id||
     input.source.conversation_id!==input.conversation_id)return null;
  const row=await lookup(input.oa_id,input.source.provider_event_id);
  if(!row||row.shop_id!==input.shop_id||row.artifact_ref!==input.source.artifact_ref||
     row.sha256!==input.source.sha256||Number(row.size_bytes)!==input.source.size_bytes||
     row.format!==input.source.format)return null;
  const revisions=(await db.query<{order_id:string;revision:number;request_hash:string;request_data:unknown}>(
   `SELECT v.order_id,v.revision,v.request_hash,v.request_data FROM core_orders o
    JOIN core_revisions v ON v.order_id=o.id AND v.revision=o.active_revision
    WHERE o.shop_id=$1 AND o.customer_id=$2 AND o.conversation_id=$3
     AND v.request_data->'documents'->0->>'artifact_name'=$4`,
   [input.shop_id,input.customer_id,input.conversation_id,row.artifact_ref])).rows;
  if(revisions.length!==1)return null;
  const revision=revisions[0]!;
  const linked=await bound(db,{shop_id:input.shop_id,order_id:revision.order_id,
   active_revision:revision.revision,request_hash:revision.request_hash,request_data:revision.request_data});
  if(!linked)return null;
  const settings={copies:(linked.request_data as any).documents[0].copies,
   duplex:(linked.request_data as any).documents[0].duplex,paper:'A4' as const,color:'black_white' as const};
  if(!equal(settings,input.settings))return null;
  // All associated text events must come from the same verified OA conversation.
  const texts=(await db.query<{event_id:string}>(`SELECT event_id FROM zalo_inbound_events
   WHERE oa_id=$1 AND event_id=ANY($2::text[]) AND customer_id=$3 AND conversation_id=$4
   AND payload_json->>'kind'='text'`,[row.oa_id,input.text_event_ids,row.customer_id,row.conversation_id])).rows;
  if(texts.length!==input.text_event_ids.length)return null;
  await read(row);
  return {shop_id:row.shop_id,oa_id:row.oa_id,customer_id:row.customer_id,
   conversation_id:row.conversation_id,order_id:linked.order_id,revision:linked.revision,
   request_hash:linked.request_hash,source:{format:row.format,artifact_ref:row.artifact_ref,
    sha256:row.sha256,size_bytes:Number(row.size_bytes),provider_event_id:row.event_id},
   settings,settings_sha256:pilotSettingsHash(settings),printer_id:linked.printer_id};
 }};
 const reader={async read_registered(conn:SqlConnection,scope:{shop_id:string;order_id:string;
  active_revision:number;request_hash:string;request_data:unknown}){
  const row=await bound(conn,scope);
  if(!row)return null;
  const bytes=await read(row);
  const manifestRef=`${row.artifact_ref.split('/')[0]}/pilot-review-${row.revision}.json`;
  const manifest=Buffer.from(JSON.stringify({schema:row.format==='PDF'?'ai0.pdf_review_manifest.v1':
   'ai0.word_review_manifest.v1',manifest_ref:manifestRef,shop_id:row.shop_id,order_id:row.order_id,
   active_revision:row.revision,request_hash:row.request_hash,
   source:{...(row.format==='DOCX'?{format:'DOCX'}:{}),artifact_ref:row.artifact_ref,
    sha256:row.sha256,size_bytes:Number(row.size_bytes)}}));
  return {source:{artifact_ref:row.artifact_ref,bytes},manifest:{ref:manifestRef,bytes:manifest},
   provider_event_id:row.event_id};
 }};
 return {custody,binding,pdfSource:reader as TrustedPdfReviewSourceReader,
  wordSource:reader as TrustedWordReviewSourceReader};
}
