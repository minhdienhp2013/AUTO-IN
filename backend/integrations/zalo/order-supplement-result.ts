import type {ApplyIncomingBatchResult} from "../../conversation/processor.ts";

/** AI1 CODE-008 uses append_verified_events(actor,{order_id,expected_revision,...}),
 * whereas AI2's transactional order-session Port returns active_revision.
 * This translates only a response shape. It DOES NOT create an actor, resolve
 * an active order, acquire generation locks, or authorize an append.
 *
 * AI0 must provide those proofs in one authoritative Core transaction before
 * invoking this mapper. Unsafe separate preflight+append must not be wired.
 */
export function mapVerifiedSupplementResult(
  raw:unknown, expected:{order_id:string;expected_revision:number}
):ApplyIncomingBatchResult {
  if(!expected.order_id || !Number.isSafeInteger(expected.expected_revision) ||
     expected.expected_revision<1)throw new Error("AI1_SUPPLEMENT_EXPECTATION_INVALID");
  if(!raw || typeof raw!=="object")throw new Error("AI1_SUPPLEMENT_RESULT_INVALID");
  const output=raw as Record<string,unknown>;
  if(output.status==="stale_revision") {
    if(!Number.isSafeInteger(output.current_revision) ||
       (output.current_revision as number)<1)
      throw new Error("AI1_SUPPLEMENT_RESULT_INVALID");
    return {status:"needs_human"};
  }
  if(output.status!=="appended"&&output.status!=="existing")
    throw new Error("AI1_SUPPLEMENT_RESULT_INVALID");
  if(output.order_id!==expected.order_id ||
     !Number.isSafeInteger(output.revision) ||
     (output.revision as number)<2 ||
     typeof output.request_hash!=="string" ||
     !/^[a-f0-9]{64}$/i.test(output.request_hash) ||
     output.requires_reconfirmation!==true)
    throw new Error("AI1_SUPPLEMENT_RESULT_INVALID");
  const revision=output.revision as number;
  if(output.status==="appended") {
    if(revision!==expected.expected_revision+1)
      throw new Error("AI1_SUPPLEMENT_RESULT_INVALID");
    return {status:"appended",order_id:expected.order_id,
      active_revision:revision,requires_reconfirmation:true};
  }
  // Replay after a newer revision can return an earlier existing revision.
  // Core owns idempotency, event fingerprints and the authoritative order.
  return {status:"existing",order_id:expected.order_id,active_revision:revision};
}
