/**
 * AI1 owns authenticated handover/return operations and the persistent generation.
 * AI2 only reads the authoritative gate and attempts an atomic outbound reservation.
 */
export interface GateSnapshot {
  conversation_id: string;
  generation: number;
  mode: "AI" | "HUMAN" | "PAUSED";
}
export interface GatePort {
  read(conversation_id: string): Promise<GateSnapshot>;
  /** Optional trusted bootstrap for the very first verified inbound batch.
   * Never assume generation zero from an unverified webhook.
   */
  read_verified_batch?(batch: import("./batch.ts").Batch): Promise<GateSnapshot>;
}
export interface OutboundPort {
  /** Must atomically claim a QUEUED outbound and compare current gate AI+generation.
   * Unique outbound_id: claimed/unknown/sent must never be auto-retried.
   */
  reserve_if_current(outbound_id: string, conversation_id: string, generation: number): Promise<boolean>;
  mark(outbound_id: string, status: "SENT" | "UNKNOWN" | "CANCELLED"): Promise<void>;
}
export interface ZaloSender {
  /** Real OA integration disabled until provider contract, scope and limits verified. */
  send_text(conversation_id: string, text: string): Promise<void>;
}
export class DisabledLiveSender implements ZaloSender {
  async send_text(): Promise<void> { throw new Error("ZALO_OA_LIVE_DISABLED"); }
}
export interface ReplySchedule { allowed(now: Date): boolean }
export class OutboundDispatcher {
  private readonly gate:GatePort;
  private readonly outbox:OutboundPort;
  private readonly sender:ZaloSender;
  private readonly clock:{ now(): Date };
  private readonly schedule:ReplySchedule;
  constructor(gate:GatePort,outbox:OutboundPort,sender:ZaloSender,
    clock:{now():Date},schedule:ReplySchedule) {
    this.gate=gate;this.outbox=outbox;this.sender=sender;
    this.clock=clock;this.schedule=schedule;
  }
  async deliver(input: {
    outbound_id: string; conversation_id: string;
    generation: number; text: string;
  }): Promise<"sent" | "blocked" | "unknown"> {
    if (!this.schedule.allowed(this.clock.now())) {
      // Drop ordinary reply, not merely postpone it until the next morning.
      await this.outbox.mark(input.outbound_id,"CANCELLED");
      return "blocked";
    }
    // Must be backed by ONE transaction that checks generation + claims outbound.
    const claimed = await this.outbox.reserve_if_current(
      input.outbound_id,input.conversation_id,input.generation);
    if (!claimed) return "blocked";
    // A second read just before provider I/O catches takeover after model generation.
    const current = await this.gate.read(input.conversation_id);
    if (current.mode !== "AI" || current.generation !== input.generation ||
        !this.schedule.allowed(this.clock.now())) {
      await this.outbox.mark(input.outbound_id,"CANCELLED");
      return "blocked";
    }
    // If the provider call MAY have reached OA, failure is UNKNOWN; never blind retry.
    try {
      await this.sender.send_text(input.conversation_id,input.text);
      await this.outbox.mark(input.outbound_id,"SENT");
      return "sent";
    } catch {
      await this.outbox.mark(input.outbound_id,"UNKNOWN");
      return "unknown";
    }
  }
}
