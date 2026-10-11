-- CODE-202 (AI2): independent Zalo persistence, no AI1/core table edits.
-- Apply with: psql -v ON_ERROR_STOP=1 -1 -f backend/integrations/zalo/migrations/001_zalo_durable.sql
-- Provider payload is normalized and verified BEFORE insert; don't store raw unverified webhooks.
CREATE TABLE IF NOT EXISTS zalo_inbound_events (
  oa_id text NOT NULL, event_id text NOT NULL,
  conversation_id text NOT NULL, customer_id text NOT NULL,
  occurred_at timestamptz NOT NULL, payload_json jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (oa_id,event_id)
);
CREATE TABLE IF NOT EXISTS zalo_process_queue (
  oa_id text NOT NULL, event_id text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','COMMITTED')),
  created_at timestamptz NOT NULL DEFAULT now(), committed_at timestamptz,
  PRIMARY KEY (oa_id,event_id),
  FOREIGN KEY(oa_id,event_id) REFERENCES zalo_inbound_events(oa_id,event_id)
);
CREATE INDEX IF NOT EXISTS zalo_queue_pending_idx ON zalo_process_queue(created_at,oa_id,event_id)
  WHERE status='QUEUED';
CREATE TABLE IF NOT EXISTS zalo_batches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_key text NOT NULL,
  first_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT (now()+interval '60 seconds'),
  event_count integer NOT NULL DEFAULT 0 CHECK(event_count>=0),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK(status IN ('OPEN','LEASED','DONE','NEEDS_HUMAN')),
  lease_token uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  CHECK ((status='LEASED') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS zalo_one_open_batch_idx ON zalo_batches(batch_key) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS zalo_due_batch_idx ON zalo_batches(deadline_at,id) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS zalo_expired_lease_idx ON zalo_batches(lease_until,id) WHERE status='LEASED';
CREATE TABLE IF NOT EXISTS zalo_batch_items (
  batch_id bigint NOT NULL REFERENCES zalo_batches(id),
  oa_id text NOT NULL, event_id text NOT NULL,
  PRIMARY KEY(oa_id,event_id),
  FOREIGN KEY(oa_id,event_id) REFERENCES zalo_inbound_events(oa_id,event_id)
);
CREATE INDEX IF NOT EXISTS zalo_batch_items_order_idx ON zalo_batch_items(batch_id,oa_id,event_id);
CREATE TABLE IF NOT EXISTS zalo_outbound (
  outbound_id text PRIMARY KEY,
  conversation_id text NOT NULL,
  generation integer NOT NULL CHECK(generation>=0),
  body_text text NOT NULL CHECK(length(body_text)>0 AND length(body_text)<=4000),
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK(status IN ('QUEUED','RESERVED','SENT','UNKNOWN','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(), reserved_at timestamptz,
  finished_at timestamptz,
  CHECK(status <> 'RESERVED' OR reserved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS zalo_outbound_queued_idx ON zalo_outbound(created_at,outbound_id)
  WHERE status='QUEUED';
-- An old RESERVED operation is UNKNOWN, never QUEUED, even after process restart.
