-- AI0-owned, non-secret binding used to scope official OA receipts to one shop.
-- Presence authorizes the internal mapping only; it does NOT enable a webhook route.
CREATE TABLE IF NOT EXISTS core_shop_zalo_oa_registry (
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id) ON DELETE CASCADE,
  oa_id text NOT NULL CHECK(
    length(oa_id) BETWEEN 1 AND 128 AND oa_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  app_id text NOT NULL CHECK(
    length(app_id) BETWEEN 1 AND 128 AND app_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, oa_id),
  UNIQUE (oa_id)
);
COMMENT ON TABLE core_shop_zalo_oa_registry IS
  'Trusted non-secret OA/app to shop binding; no secret material and no live route activation.';
