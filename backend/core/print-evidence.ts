import {canonical,DomainError,sha,type PrintPlan} from './model.js';
import type {SqlConnection} from '../storage/database.js';

/** PR150 internal contract. Only AI0/AI3 may provide a source that actually
 * recomputes sealed source, manifest, preview, settings and capability bytes.
 * Client/AI2-supplied digests are never trustworthy.
 */
export interface PrintEvidenceV1 {
 schema:'ai0.print_evidence.v1';shop_id:string;order_id:string;revision:number;request_hash:string;
 sources:{source_artifact_ref:string;format:string;size_bytes:number;source_sha256:string}[];
 source_set_sha256:string;settings_sha256:string;manifest_ref:string;manifest_sha256:string;
 previews:{index:number;bytes:number;sha256:string}[];
 renderer_sha256:string;plan_sha256:string;printer_id:string;printer_capability_sha256:string;
 evidence_sha256:string;
}
export interface PrintEvidenceScope {
 readonly shop_id:string;readonly order_id:string;readonly revision:number;
 readonly request_hash:string;readonly plan:Readonly<PrintPlan>;
}
export interface TrustedPrintEvidencePort {
 read_verified(db:SqlConnection,scope:Readonly<PrintEvidenceScope>):Promise<PrintEvidenceV1|null>;
}
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const keys='evidence_sha256,manifest_ref,manifest_sha256,order_id,plan_sha256,previews,printer_capability_sha256,printer_id,renderer_sha256,request_hash,revision,schema,settings_sha256,shop_id,source_set_sha256,sources';
export function checkedEvidence(scope:PrintEvidenceScope,proof:PrintEvidenceV1|null):string {
 const deny=():never=>{throw new DomainError('STALE_PRINT_EVIDENCE','Bằng chứng file/manifest/preview/settings không còn hợp lệ',409);};
 if(!proof||typeof proof!=='object'||Array.isArray(proof)||
    Object.keys(proof).sort().join(',')!==keys||proof.schema!=='ai0.print_evidence.v1'||
    proof.shop_id!==scope.shop_id||proof.order_id!==scope.order_id||
    proof.revision!==scope.revision||proof.request_hash!==scope.request_hash||
    proof.printer_id!==scope.plan.printer_id||proof.plan_sha256!==sha(canonical(scope.plan))||
    !digest(proof.source_set_sha256)||!digest(proof.settings_sha256)||
    !digest(proof.manifest_sha256)||!digest(proof.renderer_sha256)||
    !digest(proof.printer_capability_sha256)||!digest(proof.evidence_sha256)||
    typeof proof.manifest_ref!=='string'||!proof.manifest_ref||
    !Array.isArray(proof.sources)||!proof.sources.length||
    !Array.isArray(proof.previews)||!proof.previews.length)return deny();
 if(proof.sources.some(s=>!s||!s.source_artifact_ref||!s.format||
    !Number.isSafeInteger(s.size_bytes)||s.size_bytes<0||!digest(s.source_sha256))||
    proof.previews.some(p=>!p||!Number.isSafeInteger(p.index)||p.index<0||
    !Number.isSafeInteger(p.bytes)||p.bytes<1||!digest(p.sha256))||
    proof.source_set_sha256!==sha(canonical(proof.sources)))return deny();
 const {evidence_sha256,...body}=proof;
 if(sha(canonical(body))!==evidence_sha256)return deny();
 return evidence_sha256;
}
export async function currentEvidence(db:SqlConnection,port:TrustedPrintEvidencePort,scope:PrintEvidenceScope):Promise<string>{
 if(!port||typeof port.read_verified!=='function')
  throw new DomainError('PRINT_EVIDENCE_NOT_CONFIGURED','Thiếu Port byte nguồn của AI0/AI3',503);
 try {return checkedEvidence(scope,await port.read_verified(db,Object.freeze(scope)));}
 catch(e){if(e instanceof DomainError)throw e;
  throw new DomainError('PRINT_EVIDENCE_UNAVAILABLE','Lỗi kiểm chứng bằng chứng in',503,true);}
}
