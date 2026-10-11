import type {ConversationProcessor} from "./processor.ts";
import type {PostgresConversationQueue,LeasedBatch} from "../integrations/zalo/postgres-durable.ts";

/** CODE-202 worker: inbound is always retained, outside hours/handover never
 * discards messages. Processed effects must be idempotent in AI1 by event IDs.
 * AI0 schedules tick(); no timers, no OA/live calls are started here.
 */
export class DurableConversationWorker {
  private readonly queue:PostgresConversationQueue;
  private readonly processor:Pick<ConversationProcessor,"consume">;
  constructor(queue:PostgresConversationQueue,processor:Pick<ConversationProcessor,"consume">){
    this.queue=queue;this.processor=processor;
  }
  async tick(options:{ingest_limit?:number;batch_limit?:number}={}):Promise<{
    ingested:number;claimed:number;processed:number;held:number;needs_human:number;retry:number;
  }> {
    const ingested=await this.queue.ingest_pending(options.ingest_limit??100);
    const claimed=await this.queue.claim_due(options.batch_limit??10);
    let processed=0,held=0,needs_human=0,retry=0;
    for(const batch of claimed) {
      try {
        const result=await this.processor.consume(batch);
        if(!await this.queue.complete(batch)) throw new Error("BATCH_LEASE_LOST");
        if(result==="held") held++;
        else processed++; // includes a legitimate route_human via AI1
      } catch(error) {
        // Do not put side-effecting calls on an in-memory retry loop.
        const code=error instanceof Error?error.message:"PROCESSING_FAILED";
        const outcome=await this.queue.fail(batch,code);
        if(outcome==="needs_human") needs_human++;
        else if(outcome==="retry") retry++;
        else held++; // another worker owns it; check real DB state
      }
    }
    return {ingested,claimed:claimed.length,processed,held,needs_human,retry};
  }
}
