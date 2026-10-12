-- CODE-008 AI1: durable association of verified Zalo inbound events to one active order revision.
-- No implicit customer confirmation, file processing, price, approval, job, or provider calls.
CREATE TABLE IF NOT EXISTS core_order_supplement_batches (
 order_id uuid NOT NULL REFERENCES core_orders(id),
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL,
 event_fingerprint char(64) NOT NULL,
 idempotency_key text NOT NULL,
 revision integer NOT NULL CHECK(revision>=2),
 request_hash char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(order_id,event_fingerprint),
 UNIQUE(order_id,idempotency_key),
 UNIQUE(order_id,revision)
);
CREATE TABLE IF NOT EXISTS core_order_inbound_reviews (
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL,
 event_id text NOT NULL,
 order_id uuid NOT NULL REFERENCES core_orders(id),
 revision integer NOT NULL,
 reviewed_by text NOT NULL,
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(oa_id,event_id),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision)
);
CREATE INDEX IF NOT EXISTS core_order_inbound_by_order
 ON core_order_inbound_reviews(order_id,revision);
