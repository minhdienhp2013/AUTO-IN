-- AI0 PR150/section 6: V1 proof binding after Core 010.
-- NULL allowed solely for legacy history; never authorize V1 print from NULL.
ALTER TABLE core_confirmation_challenges ADD COLUMN IF NOT EXISTS evidence_sha256 char(64);
ALTER TABLE core_confirmations ADD COLUMN IF NOT EXISTS evidence_sha256 char(64);
ALTER TABLE core_approvals ADD COLUMN IF NOT EXISTS evidence_sha256 char(64);
ALTER TABLE core_print_jobs ADD COLUMN IF NOT EXISTS evidence_sha256 char(64);
DO $$
DECLARE rel text;
BEGIN
 FOR rel IN SELECT unnest(ARRAY['core_confirmation_challenges','core_confirmations','core_approvals','core_print_jobs'])
 LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=rel::regclass AND conname=rel||'_evidence_sha256_valid') THEN
   EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ %L)',
    rel,rel||'_evidence_sha256_valid','^[0-9a-f]{64}$');
  END IF;
 END LOOP;
END $$;
