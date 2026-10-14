-- AI2-owned CODE-402 official signed-but-unsupported event custody.
-- AI0 MUST register this migration and implement an atomic Core approval
-- gate using the SAME scoped row lock BEFORE enabling any official OA route.
CREATE TABLE IF NOT EXISTS zalo_official_quarantine (
  id uuid PRIMARY KEY,
  oa_id text NOT NULL CHECK(length(oa_id) BETWEEN 1 AND 128),
  raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}$'),
  provider_claimed_event_id text NULL
    CHECK(provider_claimed_event_id IS NULL OR
      (length(provider_claimed_event_id) BETWEEN 1 AND 128 AND
       provider_claimed_event_id ~ '^[A-Za-z0-9._:-]+$')),
  kind text NOT NULL CHECK(kind IN ('image','file','click','unknown')),
  customer_id text NULL,
  conversation_id text NULL,
  status text NOT NULL DEFAULT 'NEEDS_HUMAN'
    CHECK(status IN ('NEEDS_HUMAN','REVIEWED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  reviewed_by text NULL,
  CHECK ((customer_id IS NULL) = (conversation_id IS NULL)),
  CHECK (status <> 'REVIEWED' OR
    (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  UNIQUE (oa_id,raw_sha256)
);
CREATE INDEX IF NOT EXISTS zalo_official_quarantine_pending_idx
  ON zalo_official_quarantine(oa_id,received_at,id)
  WHERE status='NEEDS_HUMAN';

-- Additive upgrade for databases that previously applied the first AI2 v004.
-- Never replace/drop rows or widen validation to make test CI green.
ALTER TABLE zalo_official_quarantine
  ADD COLUMN IF NOT EXISTS provider_claimed_event_id text NULL
  CHECK(provider_claimed_event_id IS NULL OR
    (length(provider_claimed_event_id) BETWEEN 1 AND 128 AND
     provider_claimed_event_id ~ '^[A-Za-z0-9._:-]+$'));

-- AI2 ingress and AI0 future approval both SELECT this row FOR UPDATE.
-- A plain count outside Core's approval transaction is NOT sufficient.
CREATE TABLE IF NOT EXISTS zalo_official_quarantine_scopes (
  oa_id text PRIMARY KEY CHECK(length(oa_id) BETWEEN 1 AND 128)
);
