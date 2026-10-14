-- CODE-006 AI0: one durable staff-initiated draft reservation per synthetic inbound event.
-- PENDING deliberately fails closed after an ambiguous crash: never create a second
-- draft merely because the HTTP response/DB update was lost.
CREATE TABLE IF NOT EXISTS ai0_inbound_artifact_drafts (
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  oa_id text NOT NULL,
  event_id text NOT NULL,
  actor_id text NOT NULL,
  settings_sha256 char(64) NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CREATED')),
  order_id uuid UNIQUE REFERENCES core_orders(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (shop_id,oa_id,event_id),
  FOREIGN KEY (shop_id,oa_id,event_id)
    REFERENCES ai0_inbound_document_artifacts(shop_id,oa_id,event_id),
  CHECK ((status='PENDING' AND order_id IS NULL AND completed_at IS NULL) OR
         (status='CREATED' AND order_id IS NOT NULL AND completed_at IS NOT NULL))
);
