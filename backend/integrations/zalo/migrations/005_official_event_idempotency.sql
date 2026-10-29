-- AI2 CODE-402: use Zalo's provider event_id for durable quarantine replay
-- idempotency. AI0 owns registering this migration before a route is enabled.
-- Do not backfill provider_claimed_event_id: legacy rows may contain the old
-- message.msg_id value, so treating that column as provider event identity
-- could merge unrelated events. Legacy exact-byte replay remains protected
-- by UNIQUE (oa_id,raw_sha256) from migration 004.
ALTER TABLE zalo_official_quarantine
  ADD COLUMN IF NOT EXISTS provider_event_id text NULL
  CHECK(provider_event_id IS NULL OR
    (length(provider_event_id) BETWEEN 1 AND 128 AND
     provider_event_id ~ '^[A-Za-z0-9._:-]+$'));

-- Multiple legacy NULL values are allowed. New receipts always require an
-- event_id in the adapter and store it here; the partial index serializes
-- same-event retries even when the JSON bytes/whitespace differ.
CREATE UNIQUE INDEX IF NOT EXISTS zalo_official_quarantine_event_id_unique
  ON zalo_official_quarantine(oa_id,provider_event_id)
  WHERE provider_event_id IS NOT NULL;
