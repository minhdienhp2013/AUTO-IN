import {createHash,timingSafeEqual} from "node:crypto";
import {ZaloIngress,type EventNormalizer,type InboundEvent,type InboundEventRepository,type WebhookVerifier} from "./protocol.ts";

/** Zalo OA webhook subset implementing the SHA-256 concatenation formula
 * described in public Zalo documentation and clarified by Zalo support; NOT
 * verified with an official Zalo-signed golden vector, and NOT an enabled
 * live runtime/sender.
 *
 * Public documentation references (reviewed 2026-10-14):
 * https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan
 * https://developers.zalo.me/docs/official-account/webhook/tong-quan
 * Documented formula: mac=sha256(appId + data + timestamp + OAsecretKey).
 * The public payload includes user_id_by_app inside data. Zalo support says
 * that is the stable user identity and each event has event_id + timestamp.
 * This implementation ASSUMES data is the exact raw UTF-8 HTTP JSON body and
 * the signed timestamp is the body timestamp. No provider-signed golden
 * vector confirms raw-byte representation, timestamp source, or retry rules.
 * The app, OA, secret and conversation binding come from trusted SERVER config.
 *
 * ONLY user_send_text is mapped. Signed files/images are handled separately
 * by the durable quarantine receiver; their URLs are never fetched here.
 * Buttons in Bot Flow do not create a webhook by themselves; payload delivery
 * requires its explicit HTTP Request card. This adapter does not infer consent.
 * No interpretation of arbitrary button/payload as CODE-401 consent.
 */
export interface OfficialZaloWebhookConfig {
  readonly app_id:string;
  readonly oa_id:string;
  readonly oa_secret_key:string;
  /** Server-authoritative mapping keyed by the signed user_id_by_app field. */
  readonly resolve_verified_user:(user_id_by_app:string)=>
    {customer_id:string;conversation_id:string}|null;
  /** Milliseconds since epoch, injected for deterministic tests. */
  readonly now?:()=>number;
}
type Wire={app_id?:unknown;event_id?:unknown;user_id_by_app?:unknown;
 timestamp?:unknown;event_name?:unknown;sender?:unknown;
 recipient?:unknown;message?:unknown;confirmation_postback?:unknown};
const isRecord=(v:unknown):v is Record<string,unknown> =>
  !!v&&typeof v==="object"&&!Array.isArray(v);
const exactId=(s:unknown,max=128):s is string=>
  typeof s==="string"&&s.length>0&&s.length<=max&&s.trim()===s&&
  /^[A-Za-z0-9._:-]+$/.test(s);
const stringField=(o:unknown,k:string):unknown=>isRecord(o)?o[k]:undefined;
const boundedTimestamp=(v:unknown):string|null=>{
  if((typeof v==="string"&&/^\d{13}$/.test(v))||
     (typeof v==="number"&&Number.isSafeInteger(v)&&v>=1e12&&v<=9999999999999))
    return String(v);
  return null;
};
function decode(raw:Uint8Array):Wire {
  if(!(raw instanceof Uint8Array)||raw.length===0||raw.length>1024*1024)
    throw new Error("INVALID_OFFICIAL_RAW_EVENT");
  let data:unknown;
  try { data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)); }
  catch { throw new Error("INVALID_OFFICIAL_RAW_EVENT"); }
  if(!isRecord(data))throw new Error("INVALID_OFFICIAL_RAW_EVENT");
  return data;
}
function requiredConfig(c:OfficialZaloWebhookConfig) {
  if(!c||!exactId(c.app_id)||!exactId(c.oa_id)||
    typeof c.oa_secret_key!=="string"||c.oa_secret_key.length<16||
    typeof c.resolve_verified_user!=="function")
    throw new Error("OFFICIAL_ZALO_SERVER_CONFIG_REQUIRED");
}
export function createOfficialZaloWebhookAdapter(config:OfficialZaloWebhookConfig):
  {verifier:WebhookVerifier;normalizer:EventNormalizer} {
  requiredConfig(config);
  const clock=config.now??Date.now;
  const readIdentity=(raw:Uint8Array)=>{
    const value=decode(raw),ts=boundedTimestamp(value.timestamp);
    if(value.app_id!==config.app_id||!ts)throw new Error("INVALID_OFFICIAL_EVENT");
    const ms=Number(ts);
    // Conservative app-side maximum delay; official retry horizon remains
    // UNVERIFIED. Rejections are safer than accepting stale signing material.
    if(Math.abs(clock()-ms)>300_000)throw new Error("INVALID_OFFICIAL_EVENT");
    return {value,timestamp:ts};
  };
  const verifier:WebhookVerifier={
    async verify(raw,headers) {
      try {
        const {timestamp}=readIdentity(raw);
        const sig=headers["x-zevent-signature"]??headers["X-ZEvent-Signature"];
        if(typeof sig!=="string"||!/^mac=[0-9a-fA-F]{64}$/.test(sig))return false;
        // Local raw-body byte assumption; not verified against a Zalo-issued signed vector.
        const signature=createHash("sha256")
          .update(config.app_id,"utf8").update(raw)
          .update(timestamp,"utf8").update(config.oa_secret_key,"utf8")
          .digest();
        const declared=Buffer.from(sig.slice(4),"hex");
        return declared.length===signature.length&&timingSafeEqual(signature,declared);
      }catch { return false; }
    }
  };
  const normalizer:EventNormalizer={
    normalize(raw) {
      const {value,timestamp}=readIdentity(raw);
      // Called ONLY after the local, raw-byte-assumption signature check.
      // A passing synthetic check is NOT verification against Zalo-issued bytes.
      if(value.event_name!=="user_send_text")
        throw new Error("INVALID_OFFICIAL_EVENT");
      if(stringField(value.recipient,"id")!==config.oa_id)
        throw new Error("INVALID_OFFICIAL_EVENT");
      const eventId=value.event_id;
      const userId=value.user_id_by_app;
      const bodyText=stringField(value.message,"text");
      if(!exactId(eventId,128)||!exactId(userId,128)||
        typeof bodyText!=="string"||bodyText.length<1||bodyText.length>4000||
        !bodyText.trim())throw new Error("INVALID_OFFICIAL_EVENT");
      const identity=config.resolve_verified_user(userId);
      if(!identity||!exactId(identity.customer_id,128)||
         !exactId(identity.conversation_id,256))
        throw new Error("INVALID_OFFICIAL_EVENT");
      // Trust only confirmed server mapper; do not invent customer, chat or order identity.
      const event:InboundEvent={
        event_id:eventId,oa_id:config.oa_id,customer_id:identity.customer_id,
        conversation_id:identity.conversation_id,occurred_at:new Date(Number(timestamp)).toISOString(),
        kind:"text",text:bodyText
      };
      return event; // Never populate confirmation_postback from official text.
    }
  };
  return {verifier,normalizer};
}

/** Inbound-only integration point for AI0. Uses its server-owned registry and
 * durable repository; deliberately has NO outbound/live toggle, no challenge
 * postback grant, no AI1 write, no printer and no automatic scheduler.
 * AI0 must still own Fastify raw-body routing, secret management, permission
 * checks and controlled feature enablement after real OA credential validation.
 */
export function createOfficialZaloIngress(
  config:OfficialZaloWebhookConfig, events:InboundEventRepository
):ZaloIngress {
  if(!events||typeof events.insert_once!=="function")
    throw new Error("OFFICIAL_ZALO_DURABLE_STORE_REQUIRED");
  const {verifier,normalizer}=createOfficialZaloWebhookAdapter(config);
  return new ZaloIngress(verifier,normalizer,events);
}
