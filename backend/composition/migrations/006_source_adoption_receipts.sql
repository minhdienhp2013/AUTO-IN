-- AI0 simulation-only HTTP receipt. PENDING is deliberately durable across
-- ambiguous crashes; only a successfully stored response can be replayed.
CREATE TABLE IF NOT EXISTS ai0_source_adoption_receipts (
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  oa_id text NOT NULL,
  event_id text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (shop_id,actor_id,idempotency_key),
  UNIQUE (shop_id,oa_id,event_id),
  FOREIGN KEY (shop_id,oa_id,event_id)
    REFERENCES ai0_inbound_document_artifacts(shop_id,oa_id,event_id),
  CHECK ((response IS NULL AND completed_at IS NULL) OR
         (response IS NOT NULL AND completed_at IS NOT NULL))
);
