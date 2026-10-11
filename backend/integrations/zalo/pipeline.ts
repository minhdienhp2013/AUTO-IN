import type {InboundEventRepository,WebhookVerifier,EventNormalizer} from './protocol.ts';
import {RejectUnverifiedLiveZalo,ZaloIngress} from './protocol.ts';
import {handleZaloWebhook} from './handler.ts';
import {PostgresInboundEventRepository} from './postgres-events.ts';
import {CoreConversationGate} from './core-gate.ts';
import {PostgresConversationQueue,PostgresOutboundRepository,type PgTransactions} from './postgres-durable.ts';
import {ConversationProcessor,type OrderDraftPort,type ClassifierPort,type DocumentFactsPort} from '../../conversation/processor.ts';
import {DurableConversationWorker} from '../../conversation/durable-worker.ts';
import {OutboundDispatcher,type ReplySchedule,type ZaloSender} from '../../conversation/gate.ts';

/** Safe simulation entry. AI0 supplies a real PG transaction runner and a trusted
 * OA->shop mapping; neither is derived from unverified webhook payload/header.
 * Provider fields deliberately require an explicit *synthetic* label. This factory
 * cannot activate a real OA sender even if a caller requests live mode.
 */
export interface SyntheticProvider {
  kind: 'synthetic_fixture';
  verifier: WebhookVerifier;
  normalizer: EventNormalizer;
  /** Synthetic stub only; never a real OA network sender. */
  sender?: ZaloSender;
}
export interface ZaloPipelineOptions {
  db: PgTransactions;
  trusted_shop_id: string;
  trusted_oa_id: string;
  orders: OrderDraftPort;
  documents: DocumentFactsPort;
  schedule: ReplySchedule;
  clock: {now():Date};
  classifier?: ClassifierPort;
  /** Without this, inbound webhook is always 403 and outbound is never sent. */
  synthetic_provider?: SyntheticProvider;
  mode?: 'simulation' | 'controlled_test' | 'production' | 'safe';
}
export function createZaloPipeline(options:ZaloPipelineOptions) {
  if((options.mode ?? 'simulation')!=='simulation')throw new Error('ZALO_LIVE_DISABLED');
  if(!options.trusted_oa_id||options.trusted_oa_id.length>128)throw new Error('INVALID_TRUSTED_OA');
  const gate=new CoreConversationGate(options.db,options.trusted_shop_id,options.trusted_oa_id);
  const queue=new PostgresConversationQueue(options.db,options.trusted_oa_id);
  const outbox=new PostgresOutboundRepository(options.db,gate,{shop_id:options.trusted_shop_id,oa_id:options.trusted_oa_id});
  const provider=options.synthetic_provider;
  if(provider&&provider.kind!=='synthetic_fixture')throw new Error('UNVERIFIED_PROVIDER');
  const reject=new RejectUnverifiedLiveZalo();
  const verifier=provider?.verifier ?? reject;
  const upstreamNormalizer=provider?.normalizer ?? reject;
  const normalizer:EventNormalizer={normalize(raw:Uint8Array){
    const event=upstreamNormalizer.normalize(raw);
    if(event.oa_id!==options.trusted_oa_id)throw new Error('INVALID_OA_SCOPE');
    return event;
  }};
  const ingress=new ZaloIngress(verifier,normalizer,
    new PostgresInboundEventRepository(options.db) as InboundEventRepository);
  const processor=new ConversationProcessor(gate,options.documents,options.orders,outbox,options.classifier);
  const worker=new DurableConversationWorker(queue,processor);
  const dispatcher=provider?.sender ? new OutboundDispatcher(gate,outbox,provider.sender,
    options.clock,options.schedule):undefined;
  return {
    ingress,gate,queue,outbox,processor,worker,
    receive_webhook(raw:Uint8Array,headers:Readonly<Record<string,string>>) {
      return handleZaloWebhook(ingress,raw,headers);
    },
    /** Inbound/processor only; no network sending. Always safe to schedule in simulation. */
    tick_inbound(limits:{ingest_limit?:number;batch_limit?:number}={}) {
      return worker.tick(limits);
    },
    /** Disabled unless a deliberately injected simulation-only sender exists. */
    async tick_outbound(limit=20):Promise<{attempted:number;sent:number;unknown:number;blocked:number;disabled:boolean}> {
      if(!dispatcher)return {attempted:0,sent:0,unknown:0,blocked:0,disabled:true};
      const waiting=await outbox.list_queued(limit);
      let sent=0,unknown=0,blocked=0;
      for(const message of waiting) {
        const result=await dispatcher.deliver(message);
        if(result==='sent')sent++;
        else if(result==='unknown')unknown++;
        else blocked++;
      }
      return {attempted:waiting.length,sent,unknown,blocked,disabled:false};
    },
    /** Call this on startup before any outbound dispatch; RESERVED is never requeued. */
    reconcile_uncertain_outbound(seconds=120) {
      return outbox.reconcile_stale_reserved(seconds);
    }
  };
}
