import {createHash} from 'node:crypto';
import {canonical,DomainError,sha,type Principal} from './model.js';
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
 let value:unknown;
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);rejectDuplicateJsonKeys(text);value=JSON.parse(text);}catch{throw deny();}
 if(!value||typeof value!=='object'||Array.isArray(value))throw deny();
 const m=value as Record<string,unknown>,s=m.source;
 if(Object.keys(m).sort().join(',')!=='active_revision,manifest_ref,order_id,request_hash,schema,shop_id,source'||
    !s||typeof s!=='object'||Array.isArray(s))throw deny();
 const source=s as Record<string,unknown>;
 if(Object.keys(source).sort().join(',')!=='artifact_ref,format,sha256,size_bytes'||
    m.schema!=='ai0.word_review_manifest.v1'||!boundedRef(m.manifest_ref)||typeof m.shop_id!=='string'||
    typeof m.order_id!=='string'||!Number.isSafeInteger(m.active_revision)||
    !hex(m.request_hash)||source.format!=='DOCX'||!boundedRef(source.artifact_ref)||
    !hex(source.sha256)||!Number.isSafeInteger(source.size_bytes)||Number(source.size_bytes)<1||
    m.manifest_ref.split('/')[0]!==source.artifact_ref.split('/')[0])throw deny();
 return m as unknown as Manifest;
}
function sameBytes(a:Uint8Array,b:Uint8Array){return digest(a)===digest(b)&&a.byteLength===b.byteLength;}

/** Pure fail-closed validation; also called after a second registry read to
 * catch a source/manifest replacement while the first read was in flight. */
export function checkedWordReviewSnapshot(scope:WordReviewSourceScope,raw:TrustedWordReviewBytes|null):WordReviewSnapshot{
 if(!raw||!raw.source||!raw.manifest||!(raw.source.bytes instanceof Uint8Array)||
    !(raw.manifest.bytes instanceof Uint8Array)||raw.source.bytes.byteLength<1||
    !boundedRef(raw.source.artifact_ref)||!boundedRef(raw.manifest.ref))throw deny();
 const sha256=digest(raw.source.bytes),manifestSha=digest(raw.manifest.bytes);
 const manifest=parseManifest(raw.manifest.bytes);
 if(manifest.manifest_ref!==raw.manifest.ref||manifest.shop_id!==scope.shop_id||manifest.order_id!==scope.order_id||
    manifest.active_revision!==scope.active_revision||manifest.request_hash!==scope.request_hash||
    manifest.source.format!=='DOCX'||manifest.source.artifact_ref!==raw.source.artifact_ref||
    manifest.source.sha256!==sha256||manifest.source.size_bytes!==raw.source.bytes.byteLength||
    raw.manifest.bytes.byteLength<2||!hex(scope.request_hash)||
    sha(canonical(scope.request_data))!==scope.request_hash)throw deny();
 const snapshot={schema:'ai0.word_review_source.v1' as const,shop_id:scope.shop_id,order_id:scope.order_id,
  active_revision:scope.active_revision,request_hash:scope.request_hash,request_data:scope.request_data,
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
 let first:TrustedWordReviewBytes|null,second:TrustedWordReviewBytes|null;
 try{
  first=await reader.read_registered(db,Object.freeze(scope));
  const checked=checkedWordReviewSnapshot(scope,first);
  second=await reader.read_registered(db,Object.freeze(scope));
  const again=checkedWordReviewSnapshot(scope,second);
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
