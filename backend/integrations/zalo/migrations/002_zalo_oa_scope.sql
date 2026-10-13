-- CODE-302: isolated Zalo tenant scope, additive to 001_zalo_durable.sql.
-- Apply after 001 in a test database before allowing simulation workers.
-- Existing unscoped outbound is intentionally left NULL and MUST NOT be dispatched
-- by a scoped pipeline; no attempt is made to guess OA identity from message IDs.
ALTER TABLE zalo_batches ADD COLUMN IF NOT EXISTS oa_id text;
ALTER TABLE zalo_outbound ADD COLUMN IF NOT EXISTS oa_id text;
ALTER TABLE zalo_outbound ADD COLUMN IF NOT EXISTS shop_id text;
UPDATE zalo_batches SET oa_id=batch_key::jsonb->>0 WHERE oa_id IS NULL;
CREATE INDEX IF NOT EXISTS zalo_batches_oa_due_idx
  ON zalo_batches(oa_id,deadline_at,id) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS zalo_outbound_scoped_queued_idx
  ON zalo_outbound(shop_id,oa_id,created_at,outbound_id) WHERE status='QUEUED';
