-- Server-owned references to immutable inbound snapshots. Never populate from webhook fields.
CREATE TABLE IF NOT EXISTS ai0_inbound_document_artifacts (
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  oa_id text NOT NULL,
  event_id text NOT NULL,
  conversation_id text NOT NULL,
  customer_id text NOT NULL,
  artifact_ref text NOT NULL,
  sha256 char(64) NOT NULL,
  manifest_ref text NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, oa_id, event_id),
  FOREIGN KEY (oa_id, event_id) REFERENCES zalo_inbound_events(oa_id, event_id)
);
