import {DomainError,type Principal} from '../core/model.js';
import type {OrderService} from '../core/service.js';
import type {ApplyIncomingBatchInput,IncomingSealedSourceReader} from '../core/incoming-batch-port.js';
import type {PilotSourceCustodyPort} from '../conversation/pilot-word-pdf-intake.js';
import type {PilotSourceCapturePort} from '../conversation/core-pilot-intake.js';

/** Server-only bridge. The reader always comes from private custody, never
 * from an inbound event, HTTP payload, or caller-provided artifact locator. */
export function createPilotCoreBatchPort(input:{
 service:Pick<OrderService,'createIncomingBatchPort'|'acceptIncomingQueueBatch'|'closeIncomingQueueBatch'>;
 trusted:{readonly shop_id:string;readonly oa_id:string};
 processor:Principal;
 custody:PilotSourceCustodyPort;
 source_capture?:PilotSourceCapturePort;
}){
 if(!input?.service||typeof input.service.acceptIncomingQueueBatch!=='function'||
    typeof input.service.closeIncomingQueueBatch!=='function'||
    typeof input.service.createIncomingBatchPort!=='function'||
    !input.custody||typeof input.custody.read_sealed!=='function')
  throw new DomainError('INCOMING_SOURCE_NOT_CONFIGURED','Private source custody is required',503);
 if(input.source_capture&&typeof input.source_capture.ensure_sealed_source!=='function')
  throw new DomainError('INCOMING_SOURCE_NOT_CONFIGURED','Pilot source capture is invalid',503);
 const sealed_source_reader:IncomingSealedSourceReader={
  read_sealed:source=>input.custody.read_sealed(source)
 };
 const port=input.service.createIncomingBatchPort({trusted:input.trusted,
  processor:input.processor,sealed_source_reader});
 return {
  trusted_shop_id:input.trusted.shop_id,
  trusted_oa_id:input.trusted.oa_id,
  acceptIncomingQueueBatch:input.service.acceptIncomingQueueBatch.bind(input.service),
  closeIncomingQueueBatch:input.service.closeIncomingQueueBatch.bind(input.service),
  ...(input.source_capture?{source_capture:input.source_capture}:{}),
  /** No queue acknowledgement is performed here. The lease owner must only
   * complete after a successful Core result; failures remain leased/held. */
  apply_incoming_batch:(batch:ApplyIncomingBatchInput)=>port.apply_incoming_batch(batch)
 };
}
