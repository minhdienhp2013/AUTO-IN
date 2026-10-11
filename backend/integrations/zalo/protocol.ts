/**
 * CODE-102: provider-neutral ports. Wire v0.1 uses snake_case.
 * The example shape below is SYNTHETIC, NOT a claim about the real Zalo OA API.
 */
export type InboundKind = "text" | "file" | "image" | "unsupported";
export interface InboundEvent {
  event_id: string;
  oa_id: string;
  customer_id: string;
  conversation_id: string;
  occurred_at: string;
  kind: InboundKind;
  text?: string;
  file_ref?: string;
  mime_type?: string;
  filename?: string;
}
export interface WebhookVerifier {
  /** Must validate an official Zalo signature over exact raw bytes. */
  verify(raw: Uint8Array, headers: Readonly<Record<string, string>>): Promise<boolean>;
}
export interface EventNormalizer {
  /** Only accepts a previously verified payload. */
  normalize(raw: Uint8Array): InboundEvent;
}
export interface InboundEventRepository {
  /** Atomic, committed durable insert with UNIQUE(oa_id,event_id).
   * On failure THROW: never acknowledge a webhook as accepted.
   * Inserting also enqueues processing in the same DB transaction.
   */
  insert_once(event: InboundEvent): Promise<"inserted" | "duplicate">;
}
export interface WebhookReceipt {
  status: "accepted" | "duplicate";
  event_id: string;
}
function required(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("INVALID_WEBHOOK_FIELD");
  return value;
}
export class SyntheticFixtureNormalizer implements EventNormalizer {
  normalize(raw: Uint8Array): InboundEvent {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("INVALID_EVENT");
    const o = data as Record<string, unknown>;
    if (o.synthetic_fixture !== true) throw new Error("NOT_SYNTHETIC_FIXTURE");
    const kind = required(o.kind, 16);
    if (!["text", "file", "image", "unsupported"].includes(kind)) throw new Error("INVALID_KIND");
    const occurred_at = required(o.occurred_at, 40);
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(occurred_at) || !Number.isFinite(Date.parse(occurred_at))) throw new Error("INVALID_TIME");
    const evt: InboundEvent = {
      event_id: required(o.event_id, 128),
      oa_id: required(o.oa_id, 128),
      customer_id: required(o.customer_id, 128),
      conversation_id: required(o.conversation_id, 128),
      occurred_at,
      kind: kind as InboundKind,
    };
    // Never silently truncate source text (TN-018). Preserve the exact payload.
    if (typeof o.text === "string") evt.text = required(o.text, 800000);
    if (typeof o.file_ref === "string") evt.file_ref = required(o.file_ref, 2048);
    if (typeof o.mime_type === "string") evt.mime_type = required(o.mime_type, 128);
    if (typeof o.filename === "string") evt.filename = required(o.filename, 255);
    if (kind === "text" && !evt.text) throw new Error("MISSING_TEXT");
    if ((kind === "file" || kind === "image") && !evt.file_ref) throw new Error("MISSING_FILE_REF");
    return evt;
  }
}
export class RejectUnverifiedLiveZalo implements WebhookVerifier, EventNormalizer {
  async verify(): Promise<boolean> { return false; }
  normalize(): InboundEvent { throw new Error("ZALO_LIVE_MAPPING_NOT_VERIFIED"); }
}
export class ZaloIngress {
  private readonly verifier: WebhookVerifier;
  private readonly normalizer: EventNormalizer;
  private readonly events: InboundEventRepository;
  private readonly max_payload_bytes: number;
  constructor(verifier: WebhookVerifier,normalizer: EventNormalizer,
    events: InboundEventRepository,max_payload_bytes = 1024 * 1024) {
    this.verifier=verifier;this.normalizer=normalizer;this.events=events;
    this.max_payload_bytes=max_payload_bytes;
  }
  async receive(raw: Uint8Array, headers: Readonly<Record<string, string>>): Promise<WebhookReceipt> {
    if (raw.length === 0 || raw.length > this.max_payload_bytes) throw new Error("WEBHOOK_SIZE_REJECTED");
    if (!await this.verifier.verify(raw, headers)) throw new Error("WEBHOOK_SIGNATURE_REJECTED");
    const event = this.normalizer.normalize(raw);
    // insert_once must commit the event and its process marker BEFORE returning.
    const outcome = await this.events.insert_once(event);
    return { status: outcome === "inserted" ? "accepted" : "duplicate", event_id: event.event_id };
  }
}
/** Fixture only. Never wire this verifier into the production webhook. */
export class SyntheticTestVerifier implements WebhookVerifier {
  private readonly token:string;
  constructor(token:string) { this.token=token; }
  async verify(_raw: Uint8Array, headers: Readonly<Record<string, string>>): Promise<boolean> {
    return this.token.length > 0 && headers["x-test-fixture-key"] === this.token;
  }
}
