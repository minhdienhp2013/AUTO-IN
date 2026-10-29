import Fastify, { type FastifyInstance } from 'fastify';
import { createZaloRawWebhook, type ZaloWebhookReceiver } from '../composition/zalo-http.js';
import { STAGING_RESPONSE_BUDGET_MS, withinStagingResponseBudget } from './response-budget.js';

/** Local-only staging surface: health + signed inbound Zalo webhook. */
export function buildLocalStagingApp(
  receiver: ZaloWebhookReceiver,
  responseBudgetMs = STAGING_RESPONSE_BUDGET_MS
): FastifyInstance {
  if (!receiver || typeof receiver.receive_webhook !== 'function')
    throw new Error('STAGING_ZALO_RECEIVER_REQUIRED');
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error &&
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode : 500;
    return reply.code(status).send({ error: {
      code: status === 413 ? 'WEBHOOK_TOO_LARGE' : 'STAGING_REQUEST_FAILED',
      retryable: status >= 500
    } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({
    error: { code: 'NOT_FOUND', retryable: false }
  }));
  app.get('/health', async () => ({
    status: 'ok', mode: 'staging_local',
    inbound_webhook_enabled: true,
    staff_api_enabled: false,
    outbound_enabled: false,
    printing_enabled: false
  }));
  app.register(createZaloRawWebhook({
    async receive_webhook(raw, headers) {
      const result = await withinStagingResponseBudget(
        receiver.receive_webhook(raw, headers), responseBudgetMs
      );
      if (result.kind === 'deadline')
        return { status_code: 503, body: {
          error: { code: 'STAGING_RESPONSE_DEADLINE', retryable: true }
        } };
      return result.value;
    }
  }));
  return app;
}
