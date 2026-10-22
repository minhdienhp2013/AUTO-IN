-- AI1: bind each accepted Zalo queue event to one Core intake lifecycle.
-- Zalo queue/event rows remain AI2-owned; Core verifies their durable membership.
CREATE TABLE IF NOT EXISTS core_oa_intake_batches (
 id uuid PRIMARY KEY,
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL CHECK(length(oa_id) BETWEEN 1 AND 256),
 customer_id text NOT NULL CHECK(length(customer_id) BETWEEN 1 AND 256),
 conversation_id text NOT NULL CHECK(length(conversation_id) BETWEEN 1 AND 256),
 purpose text NOT NULL CHECK(purpose IN ('PILOT','ORDER')),
 status text NOT NULL CHECK(status IN ('OPEN','BOUND','CLOSED','EXPIRED','NEEDS_HUMAN')),
 opened_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 order_id uuid,
 revision integer,
 close_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 closed_at timestamptz,
 CHECK(expires_at>opened_at AND expires_at<=opened_at+interval '30 minutes'),
 CHECK((order_id IS NULL)=(revision IS NULL)),
 CHECK(revision IS NULL OR revision>=1),
 CHECK((status IN ('OPEN','BOUND'))=(closed_at IS NULL)),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS core_oa_intake_one_active_scope_idx
 ON core_oa_intake_batches(shop_id,oa_id,customer_id,conversation_id)
 WHERE status IN ('OPEN','BOUND');
CREATE UNIQUE INDEX IF NOT EXISTS core_oa_intake_one_order_revision_idx
 ON core_oa_intake_batches(shop_id,order_id,revision) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS core_oa_intake_expiry_idx
 ON core_oa_intake_batches(expires_at,id) WHERE status IN ('OPEN','BOUND');

CREATE TABLE IF NOT EXISTS core_oa_intake_event_bindings (
 oa_id text NOT NULL,
 event_id text NOT NULL CHECK(length(event_id) BETWEEN 1 AND 256),
 intake_batch_id uuid NOT NULL REFERENCES core_oa_intake_batches(id),
 queue_batch_id bigint NOT NULL CHECK(queue_batch_id>0),
 received_at timestamptz NOT NULL,
 event_kind text NOT NULL CHECK(event_kind IN ('text','image','file')),
 role text NOT NULL DEFAULT 'CONTEXT' CHECK(role IN ('CONTEXT','CODE','SOURCE','SETTINGS')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(oa_id,event_id)
);
CREATE INDEX IF NOT EXISTS core_oa_intake_event_batch_order_idx
 ON core_oa_intake_event_bindings(intake_batch_id,received_at,event_id);

-- Legacy rows remain NULL and are deliberately not eligible for new pilot authorization.
ALTER TABLE core_pilot_candidates ADD COLUMN IF NOT EXISTS intake_batch_id uuid;
ALTER TABLE core_pilot_code_attempts ADD COLUMN IF NOT EXISTS intake_batch_id uuid;
ALTER TABLE core_pilot_print_authorizations ADD COLUMN IF NOT EXISTS intake_batch_id uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='core_pilot_candidates_intake_batch_fk') THEN
  ALTER TABLE core_pilot_candidates ADD CONSTRAINT core_pilot_candidates_intake_batch_fk
   FOREIGN KEY(intake_batch_id) REFERENCES core_oa_intake_batches(id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='core_pilot_code_attempts_intake_batch_fk') THEN
  ALTER TABLE core_pilot_code_attempts ADD CONSTRAINT core_pilot_code_attempts_intake_batch_fk
   FOREIGN KEY(intake_batch_id) REFERENCES core_oa_intake_batches(id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='core_pilot_authorizations_intake_batch_fk') THEN
  ALTER TABLE core_pilot_print_authorizations ADD CONSTRAINT core_pilot_authorizations_intake_batch_fk
   FOREIGN KEY(intake_batch_id) REFERENCES core_oa_intake_batches(id);
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS core_pilot_candidates_intake_batch_idx
 ON core_pilot_candidates(intake_batch_id) WHERE intake_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS core_pilot_attempts_intake_batch_idx
 ON core_pilot_code_attempts(intake_batch_id) WHERE intake_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS core_pilot_authorizations_intake_batch_idx
 ON core_pilot_print_authorizations(intake_batch_id) WHERE intake_batch_id IS NOT NULL;
