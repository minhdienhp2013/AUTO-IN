-- AI2-only CODE-402: durable OA-level quarantine for signed UNSUPPORTED events.
-- NOT automatically installed into AI0 migration runner; AI0 must review/add.
-- Live OA ingress MUST stay disabled until AI0/AI1 authoritative approval gate
-- covers unresolved rows, including unmapped OA-level receipts, in the SAME
-- PostgreSQL transaction as Core approval (HTTP409 and zero print jobs).
CREATE TABLE IF NOT EXISTS zalo_official_quarantine (
  id uuid PRIMARY KEY,
  oa_id text NOT NULL CHECK(length(oa_id) BETWEEN 1 AND 128),
  raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}
  kind text NOT NULL CHECK(kind IN ('image','file','click','unknown')),
  customer_id text NULL,
  conversation_id text NULL,
  status text NOT NULL DEFAULT 'NEEDS_HUMAN'
    CHECK(status IN ('NEEDS_HUMAN','REVIEWED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  reviewed_by text NULL,
  CHECK ((customer_id IS NULL) = (conversation_id IS NULL)),
  CHECK (status <> 'REVIEWED' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  UNIQUE (oa_id,raw_sha256)
);
CREATE INDEX IF NOT EXISTS zalo_official_quarantine_pending_idx
 ON zalo_official_quarantine(oa_id,received_at,id) WHERE status='NEEDS_HUMAN';
),
  -- Signed provider-CLAIMED message ID, for human investigation only.
  -- Unknown official event schemas prevent treating this as validated ID.
  provider_claimed_event_id text NULL CHECK(provider_claimed_event_id IS NULL OR
    (length(provider_claimed_event_id) BETWEEN 1 AND 128 AND provider_claimed_event_id ~ '^[A-Za-z0-9._:-]+
  kind text NOT NULL CHECK(kind IN ('image','file','click','unknown')),
  customer_id text NULL,
  conversation_id text NULL,
  status text NOT NULL DEFAULT 'NEEDS_HUMAN'
    CHECK(status IN ('NEEDS_HUMAN','REVIEWED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  reviewed_by text NULL,
  CHECK ((customer_id IS NULL) = (conversation_id IS NULL)),
  CHECK (status <> 'REVIEWED' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  UNIQUE (oa_id,raw_sha256)
);
CREATE INDEX IF NOT EXISTS zalo_official_quarantine_pending_idx
 ON zalo_official_quarantine(oa_id,received_at,id) WHERE status='NEEDS_HUMAN';
)),
  kind text NOT NULL CHECK(kind IN ('image','file','click','unknown')),
  customer_id text NULL,
  conversation_id text NULL,
  status text NOT NULL DEFAULT 'NEEDS_HUMAN'
    CHECK(status IN ('NEEDS_HUMAN','REVIEWED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz NULL,
  reviewed_by text NULL,
  CHECK ((customer_id IS NULL) = (conversation_id IS NULL)),
  CHECK (status <> 'REVIEWED' OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  UNIQUE (oa_id,raw_sha256)
);
CREATE INDEX IF NOT EXISTS zalo_official_quarantine_pending_idx
 ON zalo_official_quarantine(oa_id,received_at,id) WHERE status='NEEDS_HUMAN';

-- Preserve existing AI2 test/quarantine rows from the early CODE-402 version.
-- Re-applying v004 on an isolated DB must NOT silently omit this new column.
ALTER TABLE zalo_official_quarantine
  ADD COLUMN IF NOT EXISTS provider_claimed_event_id text NULL
  CHECK(provider_claimed_event_id IS NULL OR
    (length(provider_claimed_event_id) BETWEEN 1 AND 128 AND
     provider_claimed_event_id ~ '^[A-Za-z0-9._:-]+$'));

-- Stable serialization row shared with the eventual AI0 approval transaction.
-- Both the AI2 incoming quarantine tx and AI0 pending-approval Core tx MUST
-- SELECT this row FOR UPDATE before insert/check; a plain SELECT count is
-- insufficient for concurrent inbound/approve races.
CREATE TABLE IF NOT EXISTS zalo_official_quarantine_scopes(
  oa_id text PRIMARY KEY CHECK(length(oa_id) BETWEEN 1 AND 128)
);
