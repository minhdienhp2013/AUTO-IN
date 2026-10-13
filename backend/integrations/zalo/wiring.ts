import {createZaloPipeline,type ZaloPipelineOptions} from './pipeline.ts';
import {createZaloTransactions,type PostgreSqlPool} from './transaction-runner.ts';

/** CODE-302 handoff to AI0's backend/composition/zalo-http.ts.
 *
 * Usage:
 *   const pipeline = createZaloComposition({pool, trusted_shop_id, trusted_oa_id,
 *     orders, documents, schedule, clock, mode:'simulation'});
 *   app.register(createZaloRawWebhook(pipeline)); // receiver.receive_webhook(raw,headers)
 *   // Optionally schedule pipeline.tick_inbound() (never send to actual OA).
 *
 * trusted IDs must come from server-side verified OA/shop registry, NEVER raw
 * webhook JSON, HTTP headers, query params, or customer-controlled fields.
 * Neither this function nor createZaloPipeline accepts a live mode/provider.
 */
export interface ZaloCompositionOptions extends Omit<ZaloPipelineOptions,'db'> {
  pool:PostgreSqlPool;
}
export function createZaloComposition(options:ZaloCompositionOptions) {
  const {pool,...pipelineOptions}=options;
  return createZaloPipeline({...pipelineOptions,db:createZaloTransactions(pool)});
}
