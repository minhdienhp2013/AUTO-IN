export type SyntheticZaloFileAttachment = Readonly<{
  attachment_type: string;
  size: string | number;
  name: string;
  checksum: string;
  type: string;
  url: string;
}>;

/**
 * An isolated, unverified DTO for reviewing documented Zalo file-event fields.
 * It grants no ingress, custody, order-association, or media-fetch authority.
 */
export type SyntheticZaloFileEvent = Readonly<{
  source: 'SYNTHETIC_UNVERIFIED';
  hold_state: 'HELD_FOR_REVIEW';
  review_state: 'AWAITING_REVIEW';
  media_state: 'AWAITING_MEDIA';
  app_id: string;
  sender_id: string;
  recipient_id: string;
  provider_message_id_hint: string;
  timestamp: string | number;
  attachments: readonly SyntheticZaloFileAttachment[];
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function timestamp(value: unknown): string | number {
  if (typeof value === 'string') return nonEmptyString(value, 'timestamp');
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new TypeError('timestamp must be a non-empty string or non-negative safe integer');
}

function size(value: unknown): string | number {
  if (typeof value === 'string') return nonEmptyString(value, 'attachment payload size');
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw new TypeError('attachment payload size must be a non-empty string or non-negative safe integer');
}

/** Parse only synthetic/untrusted webhook-shaped data; every result remains held. */
export function parseSyntheticZaloFileEvent(input: unknown): SyntheticZaloFileEvent {
  const event = record(input, 'event');
  const sender = record(event.sender, 'sender');
  const recipient = record(event.recipient, 'recipient');
  const message = record(event.message, 'message');
  if (!Array.isArray(message.attachments) || message.attachments.length === 0)
    throw new TypeError('message.attachments must be a non-empty array');

  const attachments = message.attachments.map((entry, index) => {
    const attachment = record(entry, `message.attachments[${index}]`);
    const payload = record(attachment.payload, `message.attachments[${index}].payload`);
    return Object.freeze({
      attachment_type: nonEmptyString(attachment.type, `message.attachments[${index}].type`),
      size: size(payload.size),
      name: nonEmptyString(payload.name, `message.attachments[${index}].payload.name`),
      checksum: nonEmptyString(payload.checksum, `message.attachments[${index}].payload.checksum`),
      type: nonEmptyString(payload.type, `message.attachments[${index}].payload.type`),
      // Keep provider URLs opaque. This parser never resolves or dereferences them.
      url: nonEmptyString(payload.url, `message.attachments[${index}].payload.url`)
    });
  });

  return Object.freeze({
    source: 'SYNTHETIC_UNVERIFIED',
    hold_state: 'HELD_FOR_REVIEW',
    review_state: 'AWAITING_REVIEW',
    media_state: 'AWAITING_MEDIA',
    app_id: nonEmptyString(event.app_id, 'app_id'),
    sender_id: nonEmptyString(sender.id, 'sender.id'),
    recipient_id: nonEmptyString(recipient.id, 'recipient.id'),
    provider_message_id_hint: nonEmptyString(message.msg_id, 'message.msg_id'),
    timestamp: timestamp(event.timestamp),
    attachments: Object.freeze(attachments)
  });
}
