-- AI0: hash anchor for staff-scoped raster previews produced by AI3's verified bridge.
-- A preview is NOT an approval or proof of printed sheets.
CREATE TABLE IF NOT EXISTS ai0_verified_plan_manifests (
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  order_id uuid NOT NULL,
  revision integer NOT NULL,
  request_hash char(64) NOT NULL,
  artifact_ref text NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id,order_id,revision),
  FOREIGN KEY (order_id,revision) REFERENCES core_revisions(order_id,revision)
);
