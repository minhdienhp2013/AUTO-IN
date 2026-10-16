-- CODE501: shop-only print schedule configuration; no operational mode change.
-- Applied once by AI0 migration runner. Do not rewrite historical migrations.
ALTER TABLE core_shop_settings
  ADD COLUMN IF NOT EXISTS schedule_version bigint NOT NULL DEFAULT 1
    CHECK(schedule_version >= 1 AND schedule_version <= 9007199254740991),
  ADD COLUMN IF NOT EXISTS schedule_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS schedule_updated_by uuid REFERENCES core_users(id);

CREATE TABLE IF NOT EXISTS core_shop_schedule_audit (
  id uuid PRIMARY KEY,
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  actor_id uuid NOT NULL REFERENCES core_users(id),
  old_version bigint NOT NULL CHECK(old_version >= 1),
  new_version bigint NOT NULL CHECK(new_version > old_version),
  previous_schedule jsonb NOT NULL,
  next_schedule jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(new_version = old_version + 1)
);
CREATE INDEX IF NOT EXISTS core_shop_schedule_audit_shop_idx
  ON core_shop_schedule_audit(shop_id,created_at,id);
