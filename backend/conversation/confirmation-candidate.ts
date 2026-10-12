import type {Batch} from "./batch.ts";
import type {InboundEvent} from "../integrations/zalo/protocol.ts";

/** Only a literal, standalone reply is a *possible* response to a challenge.
 * Classification never proves customer identity or creates a confirmation.
 * Multiple messages, attachments and arbitrary model prose are NOT confirmations.
 */
export function confirmationIntent(batch:Batch):InboundEvent|undefined {
  if(batch.events.length!==1)return undefined;
  const event=batch.events[0];
  if(!event || event.kind!=="text" || typeof event.text!=="string")return undefined;
  const text=event.text.normalize("NFC").trim().replace(/\s+/gu," ").toLocaleLowerCase("vi");
  return /^(ok|oke|đồng ý|toi dong y|tôi đồng ý|xác nhận|xac nhan|đúng rồi|dung roi)$/.test(text)
    ?event:undefined;
}

/** A candidate means "may be reviewed by AI1", NOT "customer confirmed".
 * With no server-issued, event-bound challenge, the answer is always PENDING.
 */
export type CandidateDecision =
  | {status:"candidate"|"existing";candidate_id:string}
  | {status:"pending"|"needs_human"|"stale_generation";reason:string};
export interface CandidateInput {
  batch:Batch;
  expected_generation:number;
}
export interface ConfirmationCandidatePort {
  consider(input:CandidateInput):Promise<CandidateDecision>;
}
