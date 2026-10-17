-- V1 staff review receipt for the exact current, server-verified preview tuple.
-- Historical confirmations/approvals are deliberately not backfilled.
CREATE TABLE IF NOT EXISTS core_preview_review_receipts (
 id uuid PRIMARY KEY,
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 order_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>=1),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 reviewer_id uuid NOT NULL REFERENCES core_users(id),
 decision text NOT NULL DEFAULT 'checked' CHECK(decision='checked'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision),
 UNIQUE(shop_id,reviewer_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS core_preview_review_receipts_current_idx
 ON core_preview_review_receipts(shop_id,order_id,revision,request_hash,evidence_sha256,reviewed_at DESC);
