import {createHash} from 'node:crypto';
import {canonical,DomainError,sha,type Principal} from './model.js';
import {pilotRevisionSourceBinding} from './pilot-intake-request.js';
import type {SqlConnection} from '../storage/database.js';

/** Core-facing contract shared with AI0/AI3. Bytes travel only through this
 * server-side reader; callers must never supply references, hashes or data. */
export interface WordReviewSourceV1 {
 schema:'ai0.word_review_source.v1';shop_id:string;order_id:string;
 active_revision:number;request_hash:string;request_data:unknown;
 source:{format:'DOCX';artifact_ref:string;sha256:string;size_bytes:number};
 manifest:{ref:string;sha256:string};
}
export interface WordReviewSourceScope {
 readonly shop_id:string;readonly order_id:string;readonly active_revision:number;
 readonly request_hash:string;readonly request_data:unknown;
}
export interface TrustedWordReviewBytes {
 source:{artifact_ref:string;bytes:Uint8Array};manifest:{ref:string;bytes:Uint8Array};
 /** Required for pilot authorization; copied from the server-owned source registry, never client input. */
 provider_event_id?:string;
}
/** Adapter must resolve both objects from the server-owned tenant/order/revision
 * registry and immutable private storage. It must not dereference caller URLs. */
export interface TrustedWordReviewSourceReader {
 read_registered(db:SqlConnection,scope:Readonly<WordReviewSourceScope>):Promise<TrustedWordReviewBytes|null>;
}
export interface WordReviewSnapshot extends WordReviewSourceV1 {
 /** Private server-to-processor bytes; never serialize these as a browser response. */
 private_bytes:{source:Uint8Array;manifest:Uint8Array};
}

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const deny=()=>new DomainError('WORD_SOURCE_NOT_VERIFIED','Nguồn Word/manifest không hợp lệ; giữ đơn để nhân viên xử lý',409);
const MAX_SOURCE_BYTES=25*1024*1024;
const MAX_MANIFEST_BYTES=256*1024;
const supportedDocumentFields=new Set(['artifact_name','copies','duplex','paper','orientation','binding','page_range']);
/** Locator syntax is deliberately narrower than a general URL/path. It is a
 * two-segment private bundle key, never a filesystem path or network address. */
const boundedRef=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&
 v===v.trim()&&!/[\u0000-\u0020\\:?#[\]]/.test(v)&&!v.startsWith('/')&&
 !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)&&(()=>{
  const parts=v.split('/');return parts.length===2&&parts.every(x=>x!==''&&x!=='.'&&x!=='..')&&
   /^[A-Za-z0-9_-]+$/.test(parts[0]??'')&&/^[A-Za-z0-9._-]+$/.test(parts[1]??'');
 })();

/** JSON.parse accepts duplicate object keys (last key wins). Reject them before
 * parsing so the manifest bytes have one unambiguous interpretation. */
function rejectDuplicateJsonKeys(text:string){
 let i=0;const ws=()=>{while(/[\u0009\u000a\u000d\u0020]/.test(text[i]??''))i++;};
 const string=()=>{const start=i++;let escaped=false;while(i<text.length){const c=text[i++];
  if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c==='"'){
   try{return JSON.parse(text.slice(start,i)) as string;}catch{throw deny();}}
  if((c??'')<' ')throw deny();}throw deny();};
 const value=():void=>{ws();const c=text[i];
  if(c==='{'){i++;ws();const keys=new Set<string>();if(text[i]==='}'){i++;return;}
   while(true){ws();if(text[i]!=='"')throw deny();const key=string();if(keys.has(key))throw deny();keys.add(key);
    ws();if(text[i++]!==':')throw deny();value();ws();const end=text[i++];if(end==='}')return;if(end!==',')throw deny();}
  }
  if(c==='['){i++;ws();if(text[i]===']'){i++;return;}while(true){value();ws();const end=text[i++];if(end===']')return;if(end!==',')throw deny();}}
  if(c==='"'){string();return;}
  const rest=text.slice(i);const literal=/^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(rest);
  if(literal){i+=literal[0].length;return;}
  const number=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
  if(number){i+=number[0].length;return;}throw deny();
 };
 value();ws();if(i!==text.length)throw deny();
}

type Manifest={schema:'ai0.word_review_manifest.v1';manifest_ref:string;shop_id:string;order_id:string;
 active_revision:number;request_hash:string;source:{format:'DOCX';artifact_ref:string;sha256:string;size_bytes:number}};
function parseManifest(bytes:Uint8Array):Manifest{
 if(bytes.byteLength<2||bytes.byteLength>MAX_MANIFEST_BYTES)throw deny();
 let value:unknown;
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);rejectDuplicateJsonKeys(text);value=JSON.parse(text);}catch{throw deny();}
 if(!value||typeof value!=='object'||Array.isArray(value))throw deny();
 const m=value as Record<string,unknown>,s=m.source;
 if(Object.keys(m).sort().join(',')!=='active_revision,manifest_ref,order_id,request_hash,schema,shop_id,source'||
    !s||typeof s!=='object'||Array.isArray(s))throw deny();
 const source=s as Record<string,unknown>;
 if(Object.keys(source).sort().join(',')!=='artifact_ref,format,sha256,size_bytes'||
    m.schema!=='ai0.word_review_manifest.v1'||!boundedRef(m.manifest_ref)||typeof m.shop_id!=='string'||!m.shop_id||
    typeof m.order_id!=='string'||!m.order_id||!Number.isSafeInteger(m.active_revision)||Number(m.active_revision)<1||
    !hex(m.request_hash)||source.format!=='DOCX'||!boundedRef(source.artifact_ref)||
    !source.artifact_ref.toLowerCase().endsWith('.docx')||!hex(source.sha256)||
    !Number.isSafeInteger(source.size_bytes)||Number(source.size_bytes)<1||Number(source.size_bytes)>MAX_SOURCE_BYTES||
    m.manifest_ref.split('/')[0]!==source.artifact_ref.split('/')[0])throw deny();
 return m as unknown as Manifest;
}
function sameBytes(a:Uint8Array,b:Uint8Array){return digest(a)===digest(b)&&a.byteLength===b.byteLength;}
function requestDataHash(data:unknown):string{
 try{const serialized=canonical(data);if(typeof serialized!=='string')throw deny();return sha(serialized);}catch{throw deny();}
}
function cloneData(data:unknown):unknown{try{return structuredClone(data);}catch{throw deny();}}
function freezeDeep<T>(value:T):T{
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const child of Object.values(value as Record<string,unknown>))freezeDeep(child);
  Object.freeze(value);
 }
 return value;
}
/** Core only hands the worker a raw, single-DOCX request shape it explicitly supports. */
function validateWordRequestData(data:unknown,artifactRef?:string):void{
 if(!data||typeof data!=='object'||Array.isArray(data))throw deny();
 const request=data as Record<string,unknown>;
 let pilotBinding:ReturnType<typeof pilotRevisionSourceBinding>;
 try{pilotBinding=pilotRevisionSourceBinding(request);}catch{throw deny();}
 if((!pilotBinding&&Object.keys(request).sort().join(',')!=='documents')||
    !Array.isArray(request.documents)||request.documents.length!==1)
  throw deny();
 const document=request.documents[0];
 if(!document||typeof document!=='object'||Array.isArray(document))throw deny();
 const fields=document as Record<string,unknown>;
 if(Object.keys(fields).some(key=>!supportedDocumentFields.has(key))||typeof fields.artifact_name!=='string'||
    !fields.artifact_name.toLowerCase().endsWith('.docx'))throw deny();
 if(artifactRef!==undefined){
  if(!boundedRef(artifactRef)||!artifactRef.toLowerCase().endsWith('.docx'))throw deny();
  const basename=artifactRef.split('/').pop();
  if(fields.artifact_name!==artifactRef&&fields.artifact_name!==basename)throw deny();
 }
 if(('copies' in fields)&&(typeof fields.copies!=='number'||!Number.isSafeInteger(fields.copies)||fields.copies<1||fields.copies>999))
  throw deny();
 if(('duplex' in fields)&&typeof fields.duplex!=='boolean')throw deny();
 if(('paper' in fields)&&fields.paper!=='A3'&&fields.paper!=='A4')throw deny();
 if(('orientation' in fields)&&fields.orientation!=='portrait'&&fields.orientation!=='landscape')throw deny();
 if(('binding' in fields)&&fields.binding!=='long_edge'&&fields.binding!=='short_edge')throw deny();
 if(('page_range' in fields)&&(typeof fields.page_range!=='string'||fields.page_range.length>256||
    !/^(?:all|\s*\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)$/i.test(fields.page_range)))throw deny();
}
function checkedScope(scope:WordReviewSourceScope):Readonly<WordReviewSourceScope>{
 if(!scope||typeof scope.shop_id!=='string'||!scope.shop_id||typeof scope.order_id!=='string'||!scope.order_id||
    !Number.isSafeInteger(scope.active_revision)||scope.active_revision<1||!hex(scope.request_hash))throw deny();
 const requestData=cloneData(scope.request_data);
 validateWordRequestData(requestData);
 if(requestDataHash(requestData)!==scope.request_hash)throw deny();
 return Object.freeze({...scope,request_data:freezeDeep(requestData)});
}

/** Pure fail-closed validation; also called after a second registry read to
 * catch a source/manifest replacement while the first read was in flight. */
export function checkedWordReviewSnapshot(scope:WordReviewSourceScope,raw:TrustedWordReviewBytes|null):WordReviewSnapshot{
 const current=checkedScope(scope);
 if(!raw||!raw.source||!raw.manifest||!(raw.source.bytes instanceof Uint8Array)||
    !(raw.manifest.bytes instanceof Uint8Array)||raw.source.bytes.byteLength<1||
    raw.source.bytes.byteLength>MAX_SOURCE_BYTES||raw.manifest.bytes.byteLength<2||
    raw.manifest.bytes.byteLength>MAX_MANIFEST_BYTES||!boundedRef(raw.source.artifact_ref)||
    !raw.source.artifact_ref.toLowerCase().endsWith('.docx')||!boundedRef(raw.manifest.ref))throw deny();
 validateWordRequestData(current.request_data,raw.source.artifact_ref);
 const sha256=digest(raw.source.bytes),manifestSha=digest(raw.manifest.bytes);
 const manifest=parseManifest(raw.manifest.bytes);
 let pilotBinding:ReturnType<typeof pilotRevisionSourceBinding>;
 try{pilotBinding=pilotRevisionSourceBinding(current.request_data);}catch{throw deny();}
 if(pilotBinding&&(pilotBinding.format!=='DOCX'||pilotBinding.artifact_ref!==raw.source.artifact_ref||
    pilotBinding.sha256!==sha256||pilotBinding.size_bytes!==raw.source.bytes.byteLength||
    pilotBinding.provider_event_id!==raw.provider_event_id))throw deny();
 if(manifest.manifest_ref!==raw.manifest.ref||manifest.shop_id!==current.shop_id||manifest.order_id!==current.order_id||
    manifest.active_revision!==current.active_revision||manifest.request_hash!==current.request_hash||
    manifest.source.format!=='DOCX'||manifest.source.artifact_ref!==raw.source.artifact_ref||
    manifest.source.sha256!==sha256||manifest.source.size_bytes!==raw.source.bytes.byteLength)throw deny();
 const snapshot={schema:'ai0.word_review_source.v1' as const,shop_id:current.shop_id,order_id:current.order_id,
  active_revision:current.active_revision,request_hash:current.request_hash,request_data:current.request_data,
  source:{format:'DOCX',artifact_ref:raw.source.artifact_ref,sha256,size_bytes:raw.source.bytes.byteLength},
  manifest:{ref:raw.manifest.ref,sha256:manifestSha}} as WordReviewSnapshot;
 Object.defineProperty(snapshot,'private_bytes',{enumerable:false,configurable:false,writable:false,
  value:{source:new Uint8Array(raw.source.bytes),manifest:new Uint8Array(raw.manifest.bytes)}});
 return snapshot;
}

export async function readWordReviewSnapshot(db:SqlConnection,reader:TrustedWordReviewSourceReader,
 scope:WordReviewSourceScope):Promise<WordReviewSnapshot>{
 if(!reader||typeof reader.read_registered!=='function')
  throw new DomainError('WORD_SOURCE_NOT_CONFIGURED','Thiếu registry/private storage reader tin cậy',503);
 const safeScope=checkedScope(scope);
 let first:TrustedWordReviewBytes|null,second:TrustedWordReviewBytes|null;
 try{
  first=await reader.read_registered(db,safeScope);
  const checked=checkedWordReviewSnapshot(safeScope,first);
  second=await reader.read_registered(db,safeScope);
  const again=checkedWordReviewSnapshot(safeScope,second);
  if(first!.source.artifact_ref!==second?.source.artifact_ref||first!.manifest.ref!==second?.manifest.ref||
     !sameBytes(first!.source.bytes,second!.source.bytes)||!sameBytes(first!.manifest.bytes,second!.manifest.bytes)||
     checked.source.sha256!==again.source.sha256||checked.manifest.sha256!==again.manifest.sha256)throw deny();
  return checked;
 }catch(e){
  if(e instanceof DomainError)throw e;
  throw new DomainError('WORD_SOURCE_UNAVAILABLE','Không đọc/kiểm tra được file Word riêng tư',503,true);
 }
}

/** Enforce principal shop scope before invoking any private reader. */
export function wordReviewPrincipalScope(p:Principal,id:string){
 if(!p?.verified||!['staff','owner'].includes(p.role)||!p.id||!p.shop_id)
  throw new DomainError('FORBIDDEN','Cần nhân viên đã xác thực',403);
 if(typeof id!=='string'||!id.trim()||id.length>128)throw new DomainError('INVALID_ORDER_ID','Order không hợp lệ',422);
 return {shop_id:p.shop_id,order_id:id};
}
