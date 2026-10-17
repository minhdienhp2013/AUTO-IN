import {DomainError} from '../core/model.js';
import {isWhitelistedFirstPageSuggestionText} from '../conversation/first-page-question.js';
import type {FirstPageCoreCasPort} from '../conversation/first-page-core-cas.js';
import type {FirstPageSuggestedDeliveryIntent} from '../conversation/first-page-delivery-intent.js';
import {createTn005SealedOutbox} from '../core/tn005-sealed-outbox.js';

type Tn005Outbox=ReturnType<typeof createTn005SealedOutbox>;
const uuid=(value:unknown):value is string=>typeof value==='string'&&
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const bounded=(value:unknown,max:number):value is string=>typeof value==='string'&&
  value.trim().length>0&&value.length<=max;
type FailureStatus='stale_revision'|'stale_request_hash'|'stale_source_sha'|
  'handover'|'cross_shop'|'tampered'|'not_found'|'unavailable';
const unavailable=()=>({status:'unavailable'} as const);

function validIntent(value:unknown):value is FirstPageSuggestedDeliveryIntent {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const intent=value as Record<string,unknown>;
  if(Object.keys(intent).sort().join(',')!=='evidence,kind,text'||
     intent.kind!=='tn005.first_page.suggested.v1'||
     !isWhitelistedFirstPageSuggestionText(intent.text)||
     !intent.evidence||typeof intent.evidence!=='object'||Array.isArray(intent.evidence))return false;
  const evidence=intent.evidence as Record<string,unknown>;
  return Object.keys(evidence).sort().join(',')===
      'conversation_id,customer_id,generation,oa_id,order_id,request_hash,revision,shop_id,source_sha256'&&
    bounded(evidence.shop_id,128)&&bounded(evidence.oa_id,128)&&uuid(evidence.order_id)&&
    Number.isSafeInteger(evidence.revision)&&Number(evidence.revision)>0&&
    Number.isSafeInteger(evidence.generation)&&Number(evidence.generation)>=0&&
    bounded(evidence.customer_id,128)&&bounded(evidence.conversation_id,128)&&
    sha(evidence.request_hash)&&sha(evidence.source_sha256);
}

function statusFor(error:unknown):FailureStatus {
  if(!(error instanceof DomainError))return 'unavailable';
  switch(error.code){
    case 'TN005_STALE':return 'stale_revision';
    case 'TN005_HANDOVER':return 'handover';
    case 'TN005_IDEMPOTENCY_CONFLICT':
    case 'TN005_TEXT_UNVERIFIED':
    case 'TN005_INVALID_INPUT':return 'tampered';
    default:return 'unavailable';
  }
}

/** Composition-only bridge from AI2's typed CAS consumer to AI1's sealed
 * PostgreSQL outbox. AI1 continues to own reserve/deliverReserved; this bridge
 * never authorizes or performs provider I/O.
 */
export function createFirstPageCoreCasAdapter(options:{
  readonly outbox:Tn005Outbox;
  readonly trusted:{readonly shop_id:string;readonly oa_id:string};
}):FirstPageCoreCasPort {
  if(!options?.outbox?.enqueue||!bounded(options.trusted?.shop_id,128)||
     !bounded(options.trusted?.oa_id,128))throw new DomainError(
    'TN005_ADAPTER_UNCONFIGURED','Trusted TN005 outbox adapter required',503);

  return Object.freeze({
    async compare_and_enqueue_suggested(input:Readonly<{
      outbound_id:string;intent:FirstPageSuggestedDeliveryIntent;
    }>) {
      const {outbound_id,intent}=input;
      if(!uuid(outbound_id)||!validIntent(intent))return {status:'tampered'} as const;
      const evidence=intent.evidence;
      if(evidence.shop_id!==options.trusted.shop_id||evidence.oa_id!==options.trusted.oa_id)
        return {status:'cross_shop'} as const;
      try{
        const result=await options.outbox.enqueue({
          outbound_id,idempotency_key:'tn005:'+outbound_id,
          order_id:evidence.order_id,revision:evidence.revision,
          generation:evidence.generation,request_hash:evidence.request_hash,
          source_sha256:evidence.source_sha256,text:intent.text
        });
        if(result?.status!=='queued'||result.outbound_id!==outbound_id)return unavailable();
        return {status:'queued',outbound_id} as const;
      }catch(error){return {status:statusFor(error)};}
    },
    async compare_reserved_before_provider_io(_input:Readonly<{
      outbound_id:string;intent:FirstPageSuggestedDeliveryIntent;
    }>){
      // A compare-only check would create a TOCTOU gap. AI1's
      // deliverReserved performs the fresh locked check and SENDING transition
      // itself, so this composition bridge deliberately fails closed here.
      return {status:'unavailable'} as const;
    }
  });
}
