-- AI2-only CODE-402: durable OA-level quarantine for signed UNSUPPORTED events.
-- NOT automatically installed into AI0 migration runner; AI0 must review/add.
-- Live OA ingress MUST stay disabled until AI0/AI1 authoritative approval gate
-- covers unresolved rows, including unmapped OA-level receipts, in the SAME
-- PostgreSQL transaction as Core approval (HTTP409 and zero print jobs).
CREATE TABLE IF NOT EXISTS zalo_official_quarantine (
  id uuid PRIMARY KEY,
  oa_id text NOT NULL CHECK(length(oa_id) BETWEEN 1 AND 128),
  raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}$'),
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
