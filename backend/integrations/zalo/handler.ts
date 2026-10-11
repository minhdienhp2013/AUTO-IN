import type {ZaloIngress,WebhookReceipt} from "./protocol.ts";
/** Fastify route adapter for AI0. Fastify must expose UNMODIFIED raw request bytes. */
export async function handleZaloWebhook(
  ingress:ZaloIngress,body:Uint8Array,headers:Readonly<Record<string,string>>,
):Promise<{status_code:number;body:WebhookReceipt|{error:{code:string;message:string;retryable:boolean}}}> {
  try {
    const receipt=await ingress.receive(body,headers);
    return {status_code:200,body:receipt};
  } catch (err) {
    const code=err instanceof Error?err.message:"WEBHOOK_ERROR";
    if (["WEBHOOK_SIGNATURE_REJECTED","WEBHOOK_SIZE_REJECTED"].includes(code))
      return {status_code:403,body:{error:{code,message:"Webhook rejected",retryable:false}}};
    if (/^INVALID_|^MISSING_|^NOT_SYNTHETIC|ZALO_LIVE_MAPPING/.test(code))
      return {status_code:422,body:{error:{code:"INVALID_WEBHOOK",message:"Invalid provider event",retryable:false}}};
    // Storage outage: a retryable error; DO NOT return 200/accepted.
    return {status_code:503,body:{error:{code:"WEBHOOK_PERSISTENCE_UNAVAILABLE",
      message:"Webhook could not be committed",retryable:true}}};
  }
}
