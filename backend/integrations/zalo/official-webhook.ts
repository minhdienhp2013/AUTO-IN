import {createHash,timingSafeEqual} from "node:crypto";
import type {EventNormalizer,InboundEvent,WebhookVerifier} from "./protocol.ts";

/** Official Zalo OA webhook subset, verified against the documented
 * X-ZEvent-Signature SHA-256 scheme. Not an enabled live runtime/sender.
 *
 * Docs (reviewed 2026-10-14):
 * https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan
 * https://developers.zalo.me/docs/official-account/webhook/tong-quan
 * mac=sha256(appId + RAW_JSON_BODY + timestamp + OAsecretKey).
 * The app, OA, secret and conversation binding come from trusted SERVER config.
 *
 * ONLY user_send_text is mapped. Images/files/postback require verified
 * official event-specific contracts and immutable artifact handling.
 * No interpretation of arbitrary button/payload as CODE-401 consent.
 */
export interface OfficialZaloWebhookConfig {
  readonly app_id:string;
  readonly oa_id:string;
  readonly oa_secret_key:string;
  /** Server-authoritative, verified mapping (never based on untrusted JSON). */
  readonly resolve_conversation_id:(user_id:string)=>string|null;
  /** Milliseconds since epoch, injected for deterministic tests. */
  readonly now?:()=>number;
}
type Wire={app_id?:unknown;event_name?:unknown;timestamp?:unknown;sender?:unknown;
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
    typeof c.resolve_conversation_id!=="function")
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
        // Byte-level computation, not JSON.stringify(JSON.parse(raw)).
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
      // This function is used ONLY inside ZaloIngress AFTER raw signature
      // verification. Never export it as proof of verification on its own.
      if(value.event_name!=="user_send_text")
        throw new Error("INVALID_OFFICIAL_EVENT");
      if(stringField(value.sender,"id")===undefined ||
         stringField(value.recipient,"id")!==config.oa_id)
        throw new Error("INVALID_OFFICIAL_EVENT");
      const userId=stringField(value.sender,"id");
      const msgId=stringField(value.message,"msg_id");
      const bodyText=stringField(value.message,"text");
      if(!exactId(userId,128)||!exactId(msgId,128)||
        typeof bodyText!=="string"||bodyText.length<1||bodyText.length>4000||
        !bodyText.trim())throw new Error("INVALID_OFFICIAL_EVENT");
      const conversation=config.resolve_conversation_id(userId);
      if(!exactId(conversation,256))
        throw new Error("INVALID_OFFICIAL_EVENT");
      // Trust only confirmed server mapper; do not invent chat/order identity.
      const event:InboundEvent={
        event_id:msgId,oa_id:config.oa_id,customer_id:userId,
        conversation_id:conversation,occurred_at:new Date(Number(timestamp)).toISOString(),
        kind:"text",text:bodyText
      };
      return event; // Never populate confirmation_postback from official text.
    }
  };
  return {verifier,normalizer};
}
