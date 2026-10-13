import type { FastifyPluginAsync } from 'fastify';

/** Narrow adapter for AI2's verified ingress. JSON is parsed as bytes so the
 * signature verifier receives the exact body Zalo (or a signed fixture) sent.
 */
export interface ZaloWebhookReceiver {
  receive_webhook(raw: Uint8Array, headers: Readonly<Record<string, string>>): Promise<{
    status_code: number;
    body: unknown;
  }>;
}

export function createZaloRawWebhook(receiver: ZaloWebhookReceiver): FastifyPluginAsync {
  return async app => {
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    app.post('/webhooks/zalo', async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: {
          code: 'RAW_WEBHOOK_BODY_REQUIRED', message: 'Webhook JSON body required', retryable: false
        } });
      }
      const headers = Object.fromEntries(Object.entries(request.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const result = await receiver.receive_webhook(request.body, headers);
      return reply.code(result.status_code).send(result.body);
    });
  };
}
