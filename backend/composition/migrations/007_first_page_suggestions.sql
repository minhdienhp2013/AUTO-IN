-- Advisory only: no FK or trigger from this table can alter print readiness.
CREATE TABLE IF NOT EXISTS ai0_first_page_suggestions (
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  order_id uuid NOT NULL,
  revision integer NOT NULL,
  request_hash char(64) NOT NULL,
  artifact_sha256 char(64) NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id,order_id,revision),
  FOREIGN KEY (order_id,revision) REFERENCES core_revisions(order_id,revision),
  CHECK (jsonb_typeof(metadata)='object')
);
