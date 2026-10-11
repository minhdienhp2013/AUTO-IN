-- CODE-201: immutable queue timestamp sourced from effective customer confirmation.
-- Existing jobs backfilled from actual matching confirmation history; otherwise left NULL (not claimable).
ALTER TABLE core_print_jobs ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
WITH evidence AS (
 SELECT j.id,
  CASE WHEN COALESCE((r.plan->>'physical_sheets')::bigint,0)>150 OR COALESCE(q.significant_cost,false)
    THEN CASE WHEN req.confirmed_at IS NOT NULL AND price.confirmed_at IS NOT NULL
      THEN GREATEST(req.confirmed_at,price.confirmed_at) ELSE NULL END
    ELSE req.confirmed_at END AS effective_at
 FROM core_print_jobs j
 JOIN core_revisions r ON r.order_id=j.order_id AND r.revision=j.revision AND r.request_hash=j.request_hash
 JOIN core_approvals a ON a.id=j.approval_id AND a.order_id=j.order_id AND a.revision=j.revision AND a.request_hash=j.request_hash
 LEFT JOIN core_quotes q ON q.order_id=j.order_id AND q.quote_revision=a.quote_revision
 LEFT JOIN LATERAL (
    SELECT MIN(c.created_at) AS confirmed_at FROM core_confirmations c
    WHERE c.order_id=j.order_id AND c.revision=j.revision
      AND c.request_hash=j.request_hash AND c.kind='request'
 ) req ON true
 LEFT JOIN LATERAL (
    SELECT MIN(c.created_at) AS confirmed_at FROM core_confirmations c
    WHERE c.order_id=j.order_id AND c.revision=j.revision
      AND c.request_hash=j.request_hash AND c.kind='quote' AND c.quote_revision=a.quote_revision
 ) price ON true
)
UPDATE core_print_jobs j SET confirmed_at=e.effective_at
FROM evidence e WHERE j.id=e.id AND j.confirmed_at IS NULL AND e.effective_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS core_jobs_confirmed_queue_idx
 ON core_print_jobs(printer_id,confirmed_at,id)
 WHERE state='NOT_SENT' AND cancelled_at IS NULL AND confirmed_at IS NOT NULL;
