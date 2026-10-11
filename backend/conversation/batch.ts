import type { InboundEvent } from "../integrations/zalo/protocol.ts";
/** Clock is injected; no process-global timers, works after worker restart via persisted batches. */
export interface Clock { now(): number }
export interface Batch {
  key: string;
  first_at: number;
  deadline_at: number;
  events: InboundEvent[];
}
export interface BatchStore {
  get(key: string): Promise<Batch | undefined>;
  put(batch: Batch): Promise<void>;
  take_due(now: number): Promise<Batch[]>;
  take_one(key: string): Promise<Batch | undefined>;
}
export function batchKey(event: InboundEvent): string {
  return JSON.stringify([event.oa_id, event.customer_id, event.conversation_id]);
}
export class MessageBatcher {
  private readonly store:BatchStore;
  private readonly clock:Clock;
  constructor(store:BatchStore,clock:Clock) { this.store=store;this.clock=clock; }
  async add(event: InboundEvent): Promise<Batch> {
    const key = batchKey(event);
    const now = this.clock.now();
    const current = await this.store.get(key);
    const first_at = current?.first_at ?? now;
    const events = [...(current?.events ?? [])];
    if (current && events.some(e => e.event_id === event.event_id)) return current;
    events.push(event);
    // First message: max 60s; later messages: wait up to 10s, never beyond first+60s.
    const deadline_at = current
      ? Math.min(first_at + 60000, now + 10000)
      : first_at + 60000;
    const batch = { key, first_at, deadline_at, events: events.sort((a,b) =>
      Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
      a.event_id.localeCompare(b.event_id)) };
    await this.store.put(batch);
    return batch;
  }
  async flushDue(consume: (batch: Batch) => Promise<void>): Promise<number> {
    const due = await this.store.take_due(this.clock.now());
    for (let i=0; i<due.length; i++) {
      try { await consume(due[i]); } catch (error) {
        for (const pending of due.slice(i)) await this.store.put(pending);
        throw error;
      }
    }
    return due.length;
  }
  /** Called only after trusted deterministic rules establish sufficient information. */
  async flushComplete(key: string, consume: (batch: Batch) => Promise<void>): Promise<boolean> {
    const batch = await this.store.take_one(key);
    if (!batch) return false;
    try { await consume(batch); } catch (error) {
      await this.store.put(batch);
      throw error;
    }
    return true;
  }
}
/** TEST FIXTURE ONLY, not a durable implementation for live mode. */
export class FixtureBatchStore implements BatchStore {
  private map = new Map<string, Batch>();
  async get(key: string) { return this.map.get(key); }
  async put(batch: Batch) { this.map.set(batch.key, batch); }
  async take_due(now: number) {
    const due = [...this.map.values()].filter(b => b.deadline_at <= now);
    due.forEach(b => this.map.delete(b.key));
    return due;
  }
  async take_one(key: string) {
    const batch = this.map.get(key);
    this.map.delete(key);
    return batch;
  }
}
