import {createHash,randomUUID} from "node:crypto";
import {createOfficialZaloWebhookAdapter,type OfficialZaloWebhookConfig} from "./official-webhook.ts";
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
      if(!record(payload)||!id(payload.event_name,100)||
         payload.event_name==="user_send_text")
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
      const kind=classify(payload.event_name);
      const digest=createHash("sha256").update(raw).digest("hex");
      // No raw payload, arbitrary filename, click data, free text, or OA
      // secret is persisted. DB receipt time is authoritative.
      return db.transaction(async tx=>{
        const newId=randomUUID();
        const inserted=await tx.query<{id:string;status:string}>(
          "INSERT INTO zalo_official_quarantine "+
          "(id,oa_id,raw_sha256,kind,customer_id,conversation_id,status) "+
          "VALUES($1,$2,$3,$4,$5,$6,'NEEDS_HUMAN') "+
          "ON CONFLICT (oa_id,raw_sha256) DO NOTHING RETURNING id,status",
          [newId,config.oa_id,digest,kind,customer,conversation]);
        if(inserted.rowCount===1){
          return {status:"held",receipt_id:newId,pending:true,kind,mapped:customer!==null};
        }
        if(inserted.rowCount!==0)throw new Error("QUARANTINE_INSERT_UNCERTAIN");
        const existing=await tx.query<{id:string;status:string;kind:QuarantineKind;customer_id:string|null}>(
          "SELECT id,status,kind,customer_id FROM zalo_official_quarantine "+
          "WHERE oa_id=$1 AND raw_sha256=$2 FOR UPDATE",[config.oa_id,digest]);
        const found=existing.rows[0];
        if(existing.rows.length!==1||!found)throw new Error("QUARANTINE_REPLAY_UNCERTAIN");
        return {status:"duplicate",receipt_id:found.id,
          pending:found.status!=="REVIEWED",kind:found.kind,mapped:found.customer_id!==null};
      });
    }
  };
}
