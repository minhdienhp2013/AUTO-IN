import {createHash} from 'node:crypto';
import {canonical,DomainError,sha,type Principal} from './model.js';
import type {SqlConnection} from '../storage/database.js';

/** Internal AI1-to-AI3 contract for one verified PDF source per order revision. */
export interface PdfReviewSourceV1 {
 schema:'ai0.pdf_review_source.v1';shop_id:string;order_id:string;
 active_revision:number;request_hash:string;request_data:unknown;
 source:{format:'PDF';artifact_ref:string;sha256:string;size_bytes:number};
 manifest:{ref:string;sha256:string};
}
export interface PdfReviewSourceScope {
 readonly shop_id:string;readonly order_id:string;readonly active_revision:number;
 readonly request_hash:string;readonly request_data:unknown;
}
export interface TrustedPdfReviewBytes {
 source:{artifact_ref:string;bytes:Uint8Array};manifest:{ref:string;bytes:Uint8Array};
 /** Required for pilot authorization; copied from the server-owned source registry, never client input. */
 provider_event_id?:string;
}
/** Implemented by AI0 composition against its server-owned registry/private store.
 * Return null unless exactly one current PDF is registered for this revision;
 * never infer a source from request_data or dereference a caller-provided locator.
 */
export interface TrustedPdfReviewSourceReader {
 read_registered(db:SqlConnection,scope:Readonly<PdfReviewSourceScope>):Promise<TrustedPdfReviewBytes|null>;
}
export interface PdfReviewSnapshot extends PdfReviewSourceV1 {
 /** Private server-to-worker bytes; never serialize as a browser response. */
 private_bytes:{source:Uint8Array;manifest:Uint8Array};
}

const MAX_PDF_BYTES=25*1024*1024;
const MAX_MANIFEST_BYTES=256*1024;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const deny=()=>new DomainError('PDF_SOURCE_NOT_VERIFIED','Nguồn PDF/manifest không hợp lệ; giữ đơn để nhân viên xử lý',409);
const boundedRef=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512&&
 v===v.trim()&&!/[\u0000-\u0020\\:?#[\]]/.test(v)&&!v.startsWith('/')&&
 !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)&&(()=>{
  const parts=v.split('/');return parts.length===2&&parts.every(x=>x!==''&&x!=='.'&&x!=='..')&&
   /^[A-Za-z0-9_-]+$/.test(parts[0]??'')&&/^[A-Za-z0-9._-]+$/.test(parts[1]??'');
 })();
const pdfHeader=(bytes:Uint8Array)=>bytes.byteLength>=5&&bytes[0]===0x25&&bytes[1]===0x50&&
 bytes[2]===0x44&&bytes[3]===0x46&&bytes[4]===0x2d;

/** JSON.parse accepts duplicate keys (last key wins); reject ambiguous bytes. */
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
  const literal=/^(?:true|false|null)(?![A-Za-z0-9_$])/.exec(text.slice(i));
  if(literal){i+=literal[0].length;return;}
  const number=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
  if(number){i+=number[0].length;return;}throw deny();
 };
 value();ws();if(i!==text.length)throw deny();
}

type PdfManifest={schema:'ai0.pdf_review_manifest.v1';manifest_ref:string;shop_id:string;order_id:string;
 active_revision:number;request_hash:string;source:{format:'PDF';artifact_ref:string;sha256:string;size_bytes:number}};
function parseManifest(bytes:Uint8Array):PdfManifest{
 if(bytes.byteLength<2||bytes.byteLength>MAX_MANIFEST_BYTES)throw deny();
 let value:unknown;
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);rejectDuplicateJsonKeys(text);value=JSON.parse(text);}catch{throw deny();}
 if(!value||typeof value!=='object'||Array.isArray(value))throw deny();
 const m=value as Record<string,unknown>,s=m.source;
 if(Object.keys(m).sort().join(',')!=='active_revision,manifest_ref,order_id,request_hash,schema,shop_id,source'||
    !s||typeof s!=='object'||Array.isArray(s))throw deny();
 const source=s as Record<string,unknown>;
 if(Object.keys(source).sort().join(',')!=='artifact_ref,format,sha256,size_bytes'||
    m.schema!=='ai0.pdf_review_manifest.v1'||!boundedRef(m.manifest_ref)||typeof m.shop_id!=='string'||!m.shop_id||
    typeof m.order_id!=='string'||!m.order_id||!Number.isSafeInteger(m.active_revision)||Number(m.active_revision)<1||
    !hex(m.request_hash)||source.format!=='PDF'||!boundedRef(source.artifact_ref)||
    !hex(source.sha256)||!Number.isSafeInteger(source.size_bytes)||Number(source.size_bytes)<1||
    Number(source.size_bytes)>MAX_PDF_BYTES||m.manifest_ref.split('/')[0]!==source.artifact_ref.split('/')[0])throw deny();
 return m as unknown as PdfManifest;
}
function sameBytes(a:Uint8Array,b:Uint8Array){return a.byteLength===b.byteLength&&digest(a)===digest(b);}
function requestDataHash(data:unknown):string{
 try{const serialized=canonical(data);if(typeof serialized!=='string')throw deny();return sha(serialized);}catch{throw deny();}
}
/** Accept only the unchanged one-PDF Core request understood by the native PDF review worker. */
function validatePdfRequestData(data:unknown,artifactRef:string):void{
 if(!data||typeof data!=='object'||Array.isArray(data))throw deny();
 const request=data as Record<string,unknown>;
 if(Object.keys(request).sort().join(',')!=='documents'||!Array.isArray(request.documents)||
    request.documents.length!==1)throw deny();
 const document=request.documents[0];
 if(!document||typeof document!=='object'||Array.isArray(document))throw deny();
 const fields=document as Record<string,unknown>;
 if(Object.keys(fields).sort().join(',')!=='artifact_name,copies,duplex,paper'||
    fields.artifact_name!==artifactRef||!Number.isSafeInteger(fields.copies)||
    Number(fields.copies)<1||Number(fields.copies)>999||typeof fields.duplex!=='boolean'||
    (fields.paper!=='A4'&&fields.paper!=='A3'))throw deny();
}
function cloneData(data:unknown):unknown{
 try{return structuredClone(data);}catch{throw deny();}
}
function freezeDeep<T>(value:T):T{
 if(value&&typeof value==='object'&&!Object.isFrozen(value)){
  for(const child of Object.values(value as Record<string,unknown>))freezeDeep(child);
  Object.freeze(value);
 }
 return value;
}
function readonlyScope(scope:PdfReviewSourceScope):Readonly<PdfReviewSourceScope>{
 return Object.freeze({...scope,request_data:freezeDeep(cloneData(scope.request_data))});
}

/** Verify exact PDF bytes and the registry manifest without parsing/rendering the document. */
export function checkedPdfReviewSnapshot(scope:PdfReviewSourceScope,raw:TrustedPdfReviewBytes|null):PdfReviewSnapshot{
 if(!scope||typeof scope.shop_id!=='string'||!scope.shop_id||typeof scope.order_id!=='string'||!scope.order_id||
    !Number.isSafeInteger(scope.active_revision)||scope.active_revision<1||!hex(scope.request_hash)||
    !raw||!raw.source||!raw.manifest||!(raw.source.bytes instanceof Uint8Array)||
    !(raw.manifest.bytes instanceof Uint8Array)||raw.source.bytes.byteLength<5||
    raw.source.bytes.byteLength>MAX_PDF_BYTES||!pdfHeader(raw.source.bytes)||
    !boundedRef(raw.source.artifact_ref)||!boundedRef(raw.manifest.ref))throw deny();
 const requestData=cloneData(scope.request_data);
 validatePdfRequestData(requestData,raw.source.artifact_ref);
 if(requestDataHash(requestData)!==scope.request_hash)throw deny();
 const manifest=parseManifest(raw.manifest.bytes);
 const sourceSha=digest(raw.source.bytes),manifestSha=digest(raw.manifest.bytes);
 if(manifest.manifest_ref!==raw.manifest.ref||manifest.shop_id!==scope.shop_id||manifest.order_id!==scope.order_id||
    manifest.active_revision!==scope.active_revision||manifest.request_hash!==scope.request_hash||
    manifest.source.format!=='PDF'||manifest.source.artifact_ref!==raw.source.artifact_ref||
    manifest.source.sha256!==sourceSha||manifest.source.size_bytes!==raw.source.bytes.byteLength)throw deny();
 const snapshot={schema:'ai0.pdf_review_source.v1' as const,shop_id:scope.shop_id,order_id:scope.order_id,
  active_revision:scope.active_revision,request_hash:scope.request_hash,request_data:requestData,
  source:{format:'PDF' as const,artifact_ref:raw.source.artifact_ref,sha256:sourceSha,size_bytes:raw.source.bytes.byteLength},
  manifest:{ref:raw.manifest.ref,sha256:manifestSha}} as PdfReviewSnapshot;
 Object.defineProperty(snapshot,'private_bytes',{enumerable:false,configurable:false,writable:false,
  value:{source:new Uint8Array(raw.source.bytes),manifest:new Uint8Array(raw.manifest.bytes)}});
 return snapshot;
}

/** Read the same registered bundle twice and fail closed on registry or byte drift. */
export async function readPdfReviewSnapshot(db:SqlConnection,reader:TrustedPdfReviewSourceReader,
 scope:PdfReviewSourceScope):Promise<PdfReviewSnapshot>{
 if(!reader||typeof reader.read_registered!=='function')
  throw new DomainError('PDF_SOURCE_NOT_CONFIGURED','Thiếu registry/private storage reader tin cậy',503);
 const safeScope=readonlyScope(scope);
 try{
  const first=await reader.read_registered(db,safeScope);
  const checked=checkedPdfReviewSnapshot(safeScope,first);
  const second=await reader.read_registered(db,safeScope);
  const again=checkedPdfReviewSnapshot(safeScope,second);
  if(!first||!second||first.source.artifact_ref!==second.source.artifact_ref||first.manifest.ref!==second.manifest.ref||
     !sameBytes(first.source.bytes,second.source.bytes)||!sameBytes(first.manifest.bytes,second.manifest.bytes)||
     checked.source.sha256!==again.source.sha256||checked.manifest.sha256!==again.manifest.sha256)throw deny();
  return checked;
 }catch(e){
  if(e instanceof DomainError)throw e;
  throw new DomainError('PDF_SOURCE_UNAVAILABLE','Không đọc/kiểm tra được file PDF riêng tư',503,true);
 }
}

/** Enforce staff and order input shape before invoking private storage. */
export function pdfReviewPrincipalScope(p:Principal,id:string){
 if(!p?.verified||!['staff','owner'].includes(p.role)||!p.id||!p.shop_id)
  throw new DomainError('FORBIDDEN','Cần nhân viên đã xác thực',403);
 if(typeof id!=='string'||!id.trim()||id.length>128)throw new DomainError('INVALID_ORDER_ID','Order không hợp lệ',422);
 return {shop_id:p.shop_id,order_id:id};
}
