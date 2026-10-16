import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {assertStaff,DomainError,type Principal} from '../core/model.js';
import type {SqlPool} from '../storage/database.js';
import {verifiedSyntheticSource} from './inbound-draft.js';
import type {SyntheticArtifactScope} from './synthetic-ingest.js';

type Metadata={schema_version:'tn005.first_page.v1';status:'SUGGESTED'|'UNKNOWN'|'NEEDS_HUMAN';
  category:string;confidence_label:'high'|'none';analyzed_page_count:0|1;
  method:string;reason_code:string};
type BoundRow={request_hash:string;request_data:unknown;active_revision:number;
  event_id:string;oa_id:string;customer_id:string;conversation_id:string};
type StoredRow={request_hash:string;artifact_sha256:string;metadata:Metadata};
type Worker=(bytes:Buffer,format:string,sha256:string)=>Promise<Metadata>;
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const fail=(code:string,status=409):never=>{throw new DomainError(code,
  'First-page suggestion unavailable',status)};

function validMetadata(input:unknown):input is Metadata {
  if(!input||typeof input!=='object'||Array.isArray(input))return false;
  const m=input as Record<string,unknown>;
  return Object.keys(m).sort().join(',')===
    'analyzed_page_count,category,confidence_label,method,reason_code,schema_version,status'&&
    m.schema_version==='tn005.first_page.v1'&&
    ['SUGGESTED','UNKNOWN','NEEDS_HUMAN'].includes(String(m.status))&&
    ['WORKSHEET','EXAM','APPLICATION_FORM','CONTRACT_MINUTES','LESSON_PLAN',
      'CV_PROFILE','ADMINISTRATIVE','GENERAL_DOCUMENT','UNKNOWN'].includes(String(m.category))&&
    ['high','none'].includes(String(m.confidence_label))&&
    (m.analyzed_page_count===0||m.analyzed_page_count===1)&&
    typeof m.method==='string'&&/^[a-z0-9_]{1,64}$/.test(m.method)&&
    typeof m.reason_code==='string'&&/^[A-Z0-9_]{1,80}$/.test(m.reason_code)&&
    (m.status==='SUGGESTED' ? m.category!=='UNKNOWN'&&m.confidence_label==='high'&&
      m.analyzed_page_count===1&&m.reason_code==='NONE' :
      m.category==='UNKNOWN'&&m.confidence_label==='none');
}

async function sealedBytes(root:string,ref:string,expected:string):Promise<Buffer>{
  if(!/^doc-[A-Za-z0-9_-]{6,64}\/source-000-[a-f0-9]{64}\.(?:pdf|png|jpg|jpeg|tif|tiff|bmp|webp|docx)$/.test(ref)||
     !ref.includes('-'+expected+'.'))return fail('SOURCE_UNVERIFIED');
  const base=resolve(root),directory=resolve(base,ref.split('/')[0]!);
  const target=resolve(base,ref);
  if(!target.startsWith(base+sep))return fail('SOURCE_UNVERIFIED');
  const [baseStat,dirStat]=await Promise.all([lstat(base).catch(()=>null),lstat(directory).catch(()=>null)]);
  if(!baseStat?.isDirectory()||baseStat.isSymbolicLink()||(baseStat.mode&0o022)||
     !dirStat?.isDirectory()||dirStat.isSymbolicLink()||(dirStat.mode&0o022))
    return fail('SOURCE_STORAGE_UNAVAILABLE',503);
  let fd;
  try{
    fd=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
    const st=await fd.stat();
    if(!st.isFile()||st.size<1||st.size>25*1024*1024)return fail('SOURCE_UNVERIFIED');
    const bytes=await fd.readFile();
    if(bytes.length!==st.size||hash(bytes)!==expected)return fail('SOURCE_UNVERIFIED');
    return bytes;
  }catch{return fail('SOURCE_UNVERIFIED')}
  finally{await fd?.close()}
}

/** The child has POSIX address-space/CPU limits; parent kills its process group
 * on a hard deadline. No source or stderr is emitted in errors or logs. */
export const isolatedFirstPageWorker=(bytes:Buffer,format:string,sha256:string,
  deadlineMs=10_000):Promise<Metadata>=>new Promise((done,reject)=>{
  if(process.platform==='win32')return reject(new DomainError('CLASSIFIER_UNAVAILABLE','Classifier unavailable',503));
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<100||deadlineMs>10_000)
    return reject(new DomainError('CLASSIFIER_CONFIG_INVALID','Classifier unavailable',503));
  const payload=JSON.stringify({content_base64:bytes.toString('base64'),format_hint:format,expected_sha256:sha256});
  const child=spawn(process.env.AUTOIN_PYTHON??'python3',['-m','scripts.first_page_classify'],{
    cwd:process.cwd(),detached:true,stdio:['pipe','pipe','ignore'],
    env:{PATH:process.env.PATH,PYTHONPATH:process.cwd(),PYTHONNOUSERSITE:'1'}
  });
  let finished=false,total=0;const chunks:Buffer[]=[];
  const stop=(code:string)=>{if(finished)return;finished=true;clearTimeout(timer);
    try{if(child.pid)process.kill(-child.pid,'SIGKILL')}catch{child.kill('SIGKILL')}
    reject(new DomainError(code,'Classifier unavailable',503,true))};
  const timer=setTimeout(()=>stop('CLASSIFIER_TIMEOUT'),deadlineMs);
  child.stdout.on('data',(chunk:Buffer)=>{total+=chunk.length;
    if(total>4096)stop('CLASSIFIER_OUTPUT_INVALID');else chunks.push(chunk)});
  child.on('error',()=>stop('CLASSIFIER_UNAVAILABLE'));
  child.stdin.on('error',()=>stop('CLASSIFIER_UNAVAILABLE'));
  child.on('close',code=>{if(finished)return;finished=true;clearTimeout(timer);
    if(code!==0)return reject(new DomainError('CLASSIFIER_UNAVAILABLE','Classifier unavailable',503));
    try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!validMetadata(value))throw Error('invalid');done(value)}
    catch{reject(new DomainError('CLASSIFIER_OUTPUT_INVALID','Classifier unavailable',503))}
  });
  child.stdin.end(payload);
});

/** Read-only order/scope binding followed by a CAS INSERT. This metadata never
 * touches Core request, print plan, confirmation, approval or job tables. */
export async function classifyBoundFirstPage(pool:SqlPool,root:string,scope:SyntheticArtifactScope,
  actor:Principal,orderId:string,revision:number,worker:Worker=isolatedFirstPageWorker){
  assertStaff(actor);
  if(actor.shop_id!==scope.shop_id)return fail('FORBIDDEN',403);
  if(!uuid.test(orderId)||!Number.isSafeInteger(revision)||revision<1)return fail('INVALID_INPUT',422);
  const bound=(await pool.query<BoundRow>(
    'SELECT r.request_hash,r.request_data,o.active_revision,d.event_id,d.oa_id,o.customer_id,o.conversation_id '+
    'FROM core_orders o JOIN core_revisions r ON r.order_id=o.id AND r.revision=$3 '+
    "JOIN ai0_inbound_artifact_drafts d ON d.order_id=o.id AND d.shop_id=o.shop_id AND d.status='CREATED' "+
    "JOIN core_shop_settings s ON s.shop_id=o.shop_id AND s.mode='simulation' "+
    'WHERE o.shop_id=$1 AND o.id=$2::uuid',
    [actor.shop_id,orderId,revision])).rows[0];
  if(!bound)return fail('SUGGESTION_SCOPE_NOT_FOUND',404);
  if(bound.active_revision!==revision||bound.oa_id!==scope.oa_id)
    return fail('SUGGESTION_STALE');
  const source=await verifiedSyntheticSource(pool,root,scope,bound.event_id);
  const documents=(bound.request_data as {documents?:unknown})?.documents;
  if(source.customer_id!==bound.customer_id||source.conversation_id!==bound.conversation_id||
     !Array.isArray(documents)||documents.length!==1||
     (documents[0] as {artifact_name?:unknown})?.artifact_name!==source.artifact_ref)
    return fail('SUGGESTION_SOURCE_MISMATCH');
  const bytes=await sealedBytes(root,source.artifact_ref,source.sha256);
  const prior=(await pool.query<StoredRow>(
    'SELECT request_hash,artifact_sha256,metadata FROM ai0_first_page_suggestions '+
    'WHERE shop_id=$1 AND order_id=$2::uuid AND revision=$3',
    [actor.shop_id,orderId,revision])).rows[0];
  if(prior){
    if(prior.request_hash!==bound.request_hash||prior.artifact_sha256!==source.sha256||
       !validMetadata(prior.metadata))return fail('SUGGESTION_CONFLICT');
    return {order_id:orderId,revision,request_hash:bound.request_hash,
      artifact_sha256:source.sha256,metadata:prior.metadata};
  }
  const format=source.artifact_ref.split('.').at(-1)!;
  const metadata=await worker(bytes,format,source.sha256);
  if(!validMetadata(metadata))return fail('CLASSIFIER_OUTPUT_INVALID',503);
  // Detect a replaced private source after the child has finished, before CAS.
  await sealedBytes(root,source.artifact_ref,source.sha256);
  const inserted=await pool.query<StoredRow>(
    'INSERT INTO ai0_first_page_suggestions '+
    '(shop_id,order_id,revision,request_hash,artifact_sha256,metadata) '+
    'SELECT o.shop_id,o.id,r.revision,r.request_hash,$5,$6::jsonb '+
    'FROM core_orders o JOIN core_revisions r ON r.order_id=o.id AND r.revision=$3 '+
    "JOIN ai0_inbound_artifact_drafts d ON d.order_id=o.id AND d.shop_id=o.shop_id AND d.status='CREATED' "+
    'JOIN ai0_inbound_document_artifacts a ON a.shop_id=d.shop_id AND a.oa_id=d.oa_id AND a.event_id=d.event_id '+
    'WHERE o.shop_id=$1 AND o.id=$2::uuid AND o.active_revision=$3 AND r.request_hash=$4 '+
    'AND a.sha256=$5 AND a.artifact_ref=$7 '+
    'FOR UPDATE OF o ON CONFLICT (shop_id,order_id,revision) DO NOTHING '+
    'RETURNING request_hash,artifact_sha256,metadata',
    [actor.shop_id,orderId,revision,bound.request_hash,source.sha256,JSON.stringify(metadata),source.artifact_ref]);
  if(inserted.rowCount!==1)return fail('SUGGESTION_STALE_OR_CONCURRENT');
  return {order_id:orderId,revision,request_hash:bound.request_hash,
    artifact_sha256:source.sha256,metadata};
}
