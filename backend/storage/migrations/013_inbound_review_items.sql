-- AI1 Core: durable staff-review queue pointers for signed official image/file
-- events. The quarantine row remains the custody record. This table stores no
-- media bytes and intentionally has no order_id: attachment/linking is separate.
CREATE TABLE IF NOT EXISTS core_inbound_review_items (
  id uuid PRIMARY KEY,
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  oa_id text NOT NULL,
  quarantine_id uuid NOT NULL,
  raw_event_sha256 char(64) NOT NULL
    CHECK(raw_event_sha256 ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK(kind IN ('image','file')),
  customer_id text NULL,
  conversation_id text NULL,
  status text NOT NULL DEFAULT 'NEEDS_HUMAN' CHECK(status='NEEDS_HUMAN'),
  media_state text NOT NULL DEFAULT 'AWAITING_MEDIA' CHECK(media_state='AWAITING_MEDIA'),
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shop_id,oa_id,quarantine_id),
  CHECK ((customer_id IS NULL) = (conversation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS core_inbound_review_items_staff_queue_idx
  ON core_inbound_review_items(shop_id,received_at,id)
  WHERE status='NEEDS_HUMAN';

-- core_audit requires an order_id, but these intake records are deliberately
-- unlinked. Keep their immutable intake audit on the source item instead of
-- inventing an order identifier.
CREATE TABLE IF NOT EXISTS core_inbound_review_audit_events (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES core_inbound_review_items(id),
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  actor_id text NOT NULL,
  action text NOT NULL CHECK(action='inbound.file_held_for_staff'),
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_inbound_review_audit_item_idx
  ON core_inbound_review_audit_events(item_id,created_at);
