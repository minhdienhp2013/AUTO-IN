-- CODE TN005: a specialist outbox; never automatically wired to live Zalo.
-- AI0 must install AI2 durable+OA schema, Core and TN005 advisory source first.
CREATE TABLE IF NOT EXISTS core_tn005_suggested_outbox (
 outbound_id uuid PRIMARY KEY,
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL,
 order_id uuid NOT NULL REFERENCES core_orders(id),
 revision integer NOT NULL CHECK(revision >= 1),
 generation bigint NOT NULL CHECK(generation >= 0),
 request_hash char(64) NOT NULL,
 source_sha256 char(64) NOT NULL,
 event_id text NOT NULL,
 conversation_id text NOT NULL,
 customer_id text NOT NULL,
 body_text text NOT NULL CHECK(length(body_text)>0 AND length(body_text)<=4000),
 idempotency_key text NOT NULL CHECK(length(idempotency_key)>0 AND length(idempotency_key)<=128),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RESERVED','SENDING','SENT','UNKNOWN','CANCELLED')),
 token_sha256 char(64),reserved_at timestamptz,finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (order_id,revision) REFERENCES core_revisions(order_id,revision),
 UNIQUE(shop_id,order_id,revision),
 UNIQUE(shop_id,oa_id,idempotency_key),
 CHECK ((status='RESERVED' AND token_sha256 IS NOT NULL AND reserved_at IS NOT NULL)
     OR (status<>'RESERVED' AND token_sha256 IS NULL))
);
CREATE INDEX IF NOT EXISTS core_tn005_outbox_queue_idx
 ON core_tn005_suggested_outbox(shop_id,oa_id,created_at,outbound_id)
 WHERE status='QUEUED';
