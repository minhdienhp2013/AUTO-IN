import type {InboundEventRepository,WebhookVerifier,EventNormalizer} from './protocol.ts';
import {RejectUnverifiedLiveZalo,ZaloIngress} from './protocol.ts';
import {handleZaloWebhook} from './handler.ts';
import {PostgresInboundEventRepository} from './postgres-events.ts';
import {CoreConversationGate} from './core-gate.ts';
import {PostgresConversationQueue,PostgresOutboundRepository,type PgTransactions} from './postgres-durable.ts';
import {ConversationProcessor,type FirstPageSuggestionIntegration,
  type OrderDraftPort,type ClassifierPort,type DocumentFactsPort} from '../../conversation/processor.ts';
import {DurableConversationWorker} from '../../conversation/durable-worker.ts';
import {OutboundDispatcher,type ReplySchedule,type ZaloSender} from '../../conversation/gate.ts';
import {PostgresConfirmationCandidates,type VerifiedChallengePort} from './confirmation-candidates.ts';
import type {FirstPageQuestionReadPort,FirstPageQuestionScope} from '../../conversation/first-page-question.ts';
import type {FirstPageCoreCasPort} from '../../conversation/first-page-core-cas.ts';

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
  /** Trusted server-side challenge resolver; absent means PENDING/NEEDS_HUMAN. */
  confirmation_challenges?: VerifiedChallengePort;
  /** Optional trusted internal TN005 ports. Neither is derived from webhook
   * input; absent/incomplete wiring leaves the suggestion path blocked.
   */
  first_page_question_reader?: FirstPageQuestionReadPort;
  first_page_core_cas?: FirstPageCoreCasPort;
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
  const confirmations=new PostgresConfirmationCandidates(options.db,
    options.trusted_shop_id,options.trusted_oa_id,options.confirmation_challenges);
  const firstPage:FirstPageSuggestionIntegration|undefined=
    options.first_page_question_reader&&options.first_page_core_cas
      ?{trusted_shop_id:options.trusted_shop_id,trusted_oa_id:options.trusted_oa_id,
        questions:options.first_page_question_reader,core:options.first_page_core_cas}
      :undefined;
  const processor=new ConversationProcessor(gate,options.documents,options.orders,outbox,
    options.classifier,confirmations,firstPage);
  const worker=new DurableConversationWorker(queue,processor);
  const dispatcher=provider?.sender ? new OutboundDispatcher(gate,outbox,provider.sender,
    options.clock,options.schedule):undefined;
  return {
    ingress,gate,queue,outbox,confirmations,processor,worker,
    /** Composition-only, trusted-scope path; no HTTP/OA route is registered. */
    queue_first_page_suggested_question(input:{outbound_id:string;
      scope:Readonly<FirstPageQuestionScope>}) {
      return processor.queueFirstPageSuggestedQuestion(input);
    },
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
