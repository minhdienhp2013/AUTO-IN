import { createOfficialZaloWebhookAdapter, type OfficialZaloWebhookConfig } from '../integrations/zalo/official-webhook.js';
import type { WebhookVerifier } from '../integrations/zalo/protocol.js';
import type { ZaloWebhookReceiver } from '../composition/zalo-http.js';

export interface StagingZaloScope extends OfficialZaloWebhookConfig {
  readonly test_user_ids: ReadonlySet<string>;
  readonly discover_test_user_once?: boolean;
  readonly discovery_challenge?: string | null;
  readonly on_discovered_test_user?: (userIdByApp: string) => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Test-only fence before AI2's durable ingress. It first verifies the request,
 * then refuses signed events outside the configured test OA/user allow-list
 * without writing them. AI2's port still performs its own verification and
 * normalizes/quarantines only after this staging fence passes.
 */
export function createStagingZaloReceiver(
  config: StagingZaloScope,
  receiver: ZaloWebhookReceiver,
  verifierOverride?: WebhookVerifier
): ZaloWebhookReceiver {
  if (!config || !receiver || typeof receiver.receive_webhook !== 'function' ||
      !(config.test_user_ids instanceof Set) ||
      (config.test_user_ids.size < 1 && config.discover_test_user_once !== true) ||
      (config.discover_test_user_once === true &&
        (config.test_user_ids.size !== 0 || typeof config.discovery_challenge !== 'string' ||
          !/^AUTO-IN-TEST-USER-[a-f0-9]{32}$/.test(config.discovery_challenge))))
    throw new Error('STAGING_ZALO_SCOPE_REQUIRED');
  const verifier = verifierOverride ?? createOfficialZaloWebhookAdapter(config).verifier;
  let discoveredTestUser = false;
  return {
    async receive_webhook(raw, headers) {
      if (!(raw instanceof Uint8Array) || raw.byteLength < 1 || raw.byteLength > 1024 * 1024)
        return { status_code: 422, body: { error: { code: 'INVALID_OFFICIAL_EVENT' } } };
      if (!await verifier.verify(raw, headers))
        return { status_code: 403, body: { error: { code: 'WEBHOOK_SIGNATURE_REJECTED' } } };

      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
      catch { return { status_code: 422, body: { error: { code: 'INVALID_OFFICIAL_EVENT' } } }; }
      const recipient = record(payload) && record(payload.recipient) ? payload.recipient : null;
      if (!record(payload) ||
          (payload.oa_id !== undefined && payload.oa_id !== config.oa_id) ||
          !recipient || recipient.id !== config.oa_id)
        return { status_code: 422, body: { error: { code: 'INVALID_OFFICIAL_EVENT' } } };
      if (typeof payload.user_id_by_app !== 'string' ||
          !/^\d{6,32}$/.test(payload.user_id_by_app))
        return { status_code: 422, body: { error: { code: 'INVALID_OFFICIAL_EVENT' } } };
      if (!config.test_user_ids.has(payload.user_id_by_app)) {
        if (config.discover_test_user_once === true && !discoveredTestUser) {
          const message = record(payload.message) ? payload.message : null;
          if (payload.event_name !== 'user_send_text' ||
              message?.text !== config.discovery_challenge)
            return { status_code: 403, body: { error: { code: 'TEST_DISCOVERY_CHALLENGE_REQUIRED' } } };
          discoveredTestUser = true;
          config.on_discovered_test_user?.(payload.user_id_by_app);
          return { status_code: 200, body: {
            status: 'TEST_USER_ID_CAPTURED_EVENT_DISCARDED'
          } };
        }
        return { status_code: 403, body: { error: { code: 'TEST_USER_NOT_CONFIGURED' } } };
      }

      return receiver.receive_webhook(raw, headers);
    }
  };
}
