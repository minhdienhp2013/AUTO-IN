import {createHash,randomUUID} from "node:crypto";
import {createOfficialZaloWebhookAdapter,createOfficialZaloIngress,type OfficialZaloWebhookConfig} from "./official-webhook.ts";
import type {InboundEventRepository} from "./protocol.ts";
import type {PgTransactions} from "./postgres-durable.ts";

/** Durable quarantine for verified, but UNRECOGNIZED, official OA events.
 * Does NOT register an HTTP route and is NOT an acknowledgement, consent or
 * completion of AI1 inbound review. AI0 MUST add an authoritative, atomic
 * Core approval gate covering this table BEFORE enabling a live OA route.
 */
export type QuarantineKind="image"|"file"|"click"|"unknown";
export interface OfficialQuarantineReceipt {
  status:"held"|"duplicate";
  receipt_id:string;
  pending:boolean;
  kind:QuarantineKind;
  /** Verified server mapping when possible; null means hold at OA level. */
  mapped:boolean;
  /** Event identifier asserted by signed provider JSON, NOT validated schema. */
  provider_claimed_event_id:string|null;
}
function record(v:unknown):v is Record<string,unknown>{
  return !!v&&typeof v==="object"&&!Array.isArray(v);
}
function id(v:unknown,max=128):v is string{
  return typeof v==="string"&&v.length>0&&v.length<=max&&
    /^[A-Za-z0-9._:-]+$/.test(v);
}
function classify(name:string):QuarantineKind{
  if(/(?:^|_)image(?:$|_)/i.test(name))return "image";
  if(/(?:^|_)file(?:$|_)/i.test(name))return "file";
  if(/(?:^|_)click|response_button|postback/i.test(name))return "click";
  return "unknown";
}
export function createOfficialZaloQuarantineReceiver(
  config:OfficialZaloWebhookConfig,db:PgTransactions
):{receive:(raw:Uint8Array,headers:Readonly<Record<string,string>>)=>Promise<OfficialQuarantineReceipt>}{
  if(!db||typeof db.transaction!=="function")throw new Error("OFFICIAL_QUARANTINE_PG_REQUIRED");
  const {verifier}=createOfficialZaloWebhookAdapter(config);
  return {
    async receive(raw,headers){
      if(!await verifier.verify(raw,headers))throw new Error("WEBHOOK_SIGNATURE_REJECTED");
      let payload:unknown;
      try{payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw))}
      catch{throw new Error("INVALID_OFFICIAL_EVENT")}
      if(!record(payload)||!id(payload.event_name,100))
        throw new Error("UNSUPPORTED_OFFICIAL_QUARANTINE_EVENT");
      // A signed payload claiming a DIFFERENT OA must never be attributed
      // to our configured OA. Omitted OA / recipient is OA-level held only.
      if(payload.oa_id!==undefined&&payload.oa_id!==config.oa_id)
        throw new Error("INVALID_OFFICIAL_EVENT_SCOPE");
      const recipient=record(payload.recipient)?payload.recipient:null;
      if(recipient?.id!==undefined&&recipient.id!==config.oa_id)
        throw new Error("INVALID_OFFICIAL_EVENT_SCOPE");
      let customer:string|null=null,conversation:string|null=null;
      const sender=record(payload.sender)?payload.sender:null;
      if(recipient?.id===config.oa_id&&id(sender?.id)){
        const trusted=config.resolve_verified_user(sender.id);
        if(trusted&&id(trusted.customer_id)&&id(trusted.conversation_id,256)){
          customer=trusted.customer_id;conversation=trusted.conversation_id;
        }
      }
      // An already-mapped TEXT event belongs ONLY in the ordinary durable
      // queue, never in quarantine. Signed TEXT without a server mapping must
      // be held at OA level with no body, customer or conversation persisted.
      if(payload.event_name==="user_send_text"){
        if(customer!==null)
          throw new Error("UNSUPPORTED_OFFICIAL_QUARANTINE_EVENT");
        customer=null;conversation=null;
      }
      // Keep DB enum unchanged: kind=unknown is the conservative custody
      // category for unbound text. Do not guess an official provider schema.
      const kind=classify(payload.event_name);
      // No universal provider event ID schema is validated yet. Preserve this
      // bounded, SIGNED-but-UNVERIFIED claim only for manual correlation, never
      // as an authority/idempotency key; sha256(raw) remains replay key.
      const message=record(payload.message)?payload.message:null;
      const claimed=id(message?.msg_id,128)?message.msg_id:null;
      const digest=createHash("sha256").update(raw).digest("hex");
      // No raw payload, arbitrary filename, click data, free text, or OA
      // secret is persisted. DB receipt time is authoritative.
      return db.transaction(async tx=>{
        // Shared DB serialization point for AI0's future approval gate.
        // AI0 MUST acquire this same row FOR UPDATE before testing pending
        // quarantine in the SAME approval transaction (Core owner action).
        // Never rely on a non-locking count outside Core's approval tx.
        await tx.query(
          "INSERT INTO zalo_official_quarantine_scopes(oa_id) VALUES($1) "+
          "ON CONFLICT (oa_id) DO NOTHING",[config.oa_id]);
        const scope=await tx.query<{oa_id:string}>(
          "SELECT oa_id FROM zalo_official_quarantine_scopes "+
          "WHERE oa_id=$1 FOR UPDATE",[config.oa_id]);
        if(scope.rowCount!==1||scope.rows[0]?.oa_id!==config.oa_id)
          throw new Error("OFFICIAL_QUARANTINE_SCOPE_LOCK_REQUIRED");
        // PostgreSQL now()/CURRENT_TIMESTAMP denote transaction start,
        // possibly BEFORE waiting for this OA row lock. clock_timestamp()
        // at the INSERT above records the actual post-lock receipt time.
        const newId=randomUUID();
        const inserted=await tx.query<{id:string;status:string}>(
          "INSERT INTO zalo_official_quarantine "+
          "(id,oa_id,raw_sha256,kind,customer_id,conversation_id,provider_claimed_event_id,status,received_at) "+
          "VALUES($1,$2,$3,$4,$5,$6,$7,'NEEDS_HUMAN',clock_timestamp()) "+
          "ON CONFLICT (oa_id,raw_sha256) DO NOTHING RETURNING id,status",
          [newId,config.oa_id,digest,kind,customer,conversation,claimed]);
        if(inserted.rowCount===1){
          return {status:"held",receipt_id:newId,pending:true,kind,mapped:customer!==null,
            provider_claimed_event_id:claimed};
        }
        if(inserted.rowCount!==0)throw new Error("QUARANTINE_INSERT_UNCERTAIN");
        const existing=await tx.query<{id:string;status:string;kind:QuarantineKind;customer_id:string|null;provider_claimed_event_id:string|null}>(
          "SELECT id,status,kind,customer_id,provider_claimed_event_id FROM zalo_official_quarantine "+
          "WHERE oa_id=$1 AND raw_sha256=$2 FOR UPDATE",[config.oa_id,digest]);
        const found=existing.rows[0];
        if(existing.rows.length!==1||!found)throw new Error("QUARANTINE_REPLAY_UNCERTAIN");
        return {status:"duplicate",receipt_id:found.id,
          pending:found.status!=="REVIEWED",kind:found.kind,mapped:found.customer_id!==null,
          provider_claimed_event_id:found.provider_claimed_event_id};
      });
    }
  };
}

/** AI2 single entry point for AI0 controlled Fastify raw-body wiring.
 * Official signed user_send_text -> atomically stored in inbound events+queue.
 * Any authenticated, well-formed yet unsupported event -> distinct durable
 * OA quarantine, NOT a synthetic postback, customer confirmation or AI1 order.
 * A verified-but-unmapped event stays OA-level; never invent customer/chat.
 * Invalid signature, app/OA scope and malformed JSON cause ZERO database writes.
 * No live route, worker or network transport is registered here.
 */
export function createOfficialZaloVerifiedIngress(
  config:OfficialZaloWebhookConfig,
  events:InboundEventRepository,
  quarantineDb:PgTransactions
) {
  if(!events||typeof events.insert_once!=="function")
    throw new Error("OFFICIAL_ZALO_DURABLE_STORE_REQUIRED");
  if(!quarantineDb||typeof quarantineDb.transaction!=="function")
    throw new Error("OFFICIAL_QUARANTINE_PG_REQUIRED");
  const {verifier}=createOfficialZaloWebhookAdapter(config);
  const text=createOfficialZaloIngress(config,events);
  const quarantine=createOfficialZaloQuarantineReceiver(config,quarantineDb);
  const receive=async(raw:Uint8Array,headers:Readonly<Record<string,string>>)=>{
    if(!(raw instanceof Uint8Array)||raw.length===0||raw.length>1024*1024)
      throw new Error("WEBHOOK_SIZE_REJECTED");
    // Dispatch ONLY after signature/authentication; never infer a real
    // Zalo postback schema or allow text with embedded click metadata.
    if(!await verifier.verify(raw,headers))
      throw new Error("WEBHOOK_SIGNATURE_REJECTED");
    let input:unknown;
    try {input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));}
    catch{throw new Error("INVALID_OFFICIAL_EVENT");}
    if(!record(input))throw new Error("INVALID_OFFICIAL_EVENT");
    // Unknown provider fields cannot silently select a different OA; the
    // configured server OA stays authoritative for both ingress branches.
    if(input.oa_id!==undefined&&input.oa_id!==config.oa_id)
      throw new Error("INVALID_OFFICIAL_EVENT_SCOPE");
    if(record(input.recipient)&&input.recipient.id!==undefined&&
       input.recipient.id!==config.oa_id)
      throw new Error("INVALID_OFFICIAL_EVENT_SCOPE");
    if(input.event_name==="user_send_text"){
      // Only a configured recipient and a verified server identity can enter
      // conversation processing. A signed text event from an unknown sender
      // MUST remain durably OA-level even though its body is untrusted.
      const recipient=record(input.recipient)?input.recipient:null;
      const sender=record(input.sender)?input.sender:null;
      const user=sender?.id;
      if(recipient?.id===config.oa_id&&id(user)){
        const mapping=config.resolve_verified_user(user);
        if(mapping&&id(mapping.customer_id)&&id(mapping.conversation_id,256))
          return text.receive(raw,headers);
      }
      return quarantine.receive(raw,headers);
    }
    return quarantine.receive(raw,headers);
  };
  return {
    receive,
    /** Narrow AI0-owned createZaloRawWebhook-compatible receiving Port.
     * Return 200 only after the transaction COMMITTED; 503/500 must retry.
     * Never translate a DB outage into a successful acknowledgement.
     */
    async receive_webhook(raw:Uint8Array,headers:Readonly<Record<string,string>>):
      Promise<{status_code:number;body:unknown}> {
      try {
        const receipt=await receive(raw,headers);
        return {status_code:200,body:receipt};
      }catch(error){
        const reason=error instanceof Error?error.message:"UNKNOWN";
        if(reason==="WEBHOOK_SIGNATURE_REJECTED")
          return {status_code:403,body:{error:{code:"WEBHOOK_SIGNATURE_REJECTED"}}};
        if(reason==="WEBHOOK_SIZE_REJECTED"||
          reason==="INVALID_OFFICIAL_EVENT"||
          reason==="INVALID_OFFICIAL_EVENT_SCOPE"||
          reason==="UNSUPPORTED_OFFICIAL_QUARANTINE_EVENT")
          return {status_code:422,body:{error:{code:"INVALID_OFFICIAL_EVENT"}}};
        // Missing migration, PG fault, or unknown transaction outcome MUST
        // remain a retriable failure with no false 200 acknowledgement.
        return {status_code:503,body:{error:{code:"OFFICIAL_INGRESS_UNAVAILABLE"}}};
      }
    }
  };
}
