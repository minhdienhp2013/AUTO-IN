-- AI1: isolated shop-code pilot provenance. No staff approval/confirmation rows.
CREATE TABLE IF NOT EXISTS core_pilot_shop_config (
 shop_id text PRIMARY KEY REFERENCES core_shop_settings(shop_id),
 printer_id text NOT NULL CHECK(length(printer_id) BETWEEN 1 AND 128),
 agent_id text NOT NULL CHECK(length(agent_id) BETWEEN 1 AND 128),
 enabled boolean NOT NULL DEFAULT false,
 allow_real_print boolean NOT NULL DEFAULT false,
 tested_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT enabled OR tested_at IS NOT NULL),
 CHECK(NOT allow_real_print OR (enabled AND tested_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS core_pilot_shop_code_windows (
 id uuid PRIMARY KEY,
 shop_id text NOT NULL REFERENCES core_pilot_shop_config(shop_id),
 code_hmac char(64) NOT NULL CHECK(code_hmac ~ '^[0-9a-f]{64}$'),
 issued_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '30 minutes')
);
CREATE INDEX IF NOT EXISTS core_pilot_code_windows_shop_idx
 ON core_pilot_shop_code_windows(shop_id,issued_at DESC);

CREATE TABLE IF NOT EXISTS core_pilot_candidates (
 id uuid PRIMARY KEY,
 shop_id text NOT NULL REFERENCES core_pilot_shop_config(shop_id),
 oa_id text NOT NULL CHECK(length(oa_id) BETWEEN 1 AND 256),
 customer_id text NOT NULL CHECK(length(customer_id) BETWEEN 1 AND 256),
 conversation_id text NOT NULL CHECK(length(conversation_id) BETWEEN 1 AND 256),
 order_id uuid NOT NULL REFERENCES core_orders(id),
 revision integer NOT NULL CHECK(revision>=1),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 source_format text NOT NULL CHECK(source_format IN ('DOCX','PDF')),
 source_artifact_ref text NOT NULL CHECK(length(source_artifact_ref) BETWEEN 1 AND 512),
 source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 source_size_bytes bigint NOT NULL CHECK(source_size_bytes BETWEEN 1 AND 26214400),
 source_event_id text NOT NULL CHECK(length(source_event_id) BETWEEN 1 AND 256),
 manifest_ref text NOT NULL CHECK(length(manifest_ref) BETWEEN 1 AND 512),
 manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
 settings_sha256 char(64) NOT NULL CHECK(settings_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 printer_id text NOT NULL CHECK(length(printer_id) BETWEEN 1 AND 128),
 candidate_sha256 char(64) NOT NULL CHECK(candidate_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,revision),
 UNIQUE(oa_id,source_event_id),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision)
);

CREATE TABLE IF NOT EXISTS core_pilot_code_attempts (
 shop_id text NOT NULL REFERENCES core_pilot_shop_config(shop_id),
 code_window_id uuid REFERENCES core_pilot_shop_code_windows(id),
 oa_id text NOT NULL CHECK(length(oa_id) BETWEEN 1 AND 256),
 customer_id text NOT NULL CHECK(length(customer_id) BETWEEN 1 AND 256),
 conversation_id text NOT NULL CHECK(length(conversation_id) BETWEEN 1 AND 256),
 order_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>=1),
 provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 256),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 payload_hmac char(64) NOT NULL CHECK(payload_hmac ~ '^[0-9a-f]{64}$'),
 accepted boolean NOT NULL,
 consumed_at timestamptz,
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(shop_id,oa_id,provider_event_id),
 UNIQUE(shop_id,idempotency_key),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision)
);
CREATE INDEX IF NOT EXISTS core_pilot_attempt_rate_idx
 ON core_pilot_code_attempts(shop_id,oa_id,customer_id,submitted_at) WHERE accepted=false;

CREATE TABLE IF NOT EXISTS core_pilot_print_authorizations (
 id uuid PRIMARY KEY,
 shop_id text NOT NULL REFERENCES core_pilot_shop_config(shop_id),
 oa_id text NOT NULL,
 customer_id text NOT NULL,
 conversation_id text NOT NULL,
 order_id uuid NOT NULL REFERENCES core_orders(id),
 revision integer NOT NULL CHECK(revision>=1),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 candidate_id uuid NOT NULL UNIQUE REFERENCES core_pilot_candidates(id),
 source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 settings_sha256 char(64) NOT NULL CHECK(settings_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 printer_id text NOT NULL,
 code_window_id uuid NOT NULL REFERENCES core_pilot_shop_code_windows(id),
 provider_event_id text NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 payload_hmac char(64) NOT NULL CHECK(payload_hmac ~ '^[0-9a-f]{64}$'),
 authorized_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(order_id,revision),
 UNIQUE(shop_id,oa_id,provider_event_id),
 UNIQUE(shop_id,idempotency_key),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision)
);

ALTER TABLE core_print_jobs ADD COLUMN IF NOT EXISTS pilot_authorization_id uuid;
ALTER TABLE core_print_jobs ALTER COLUMN approval_id DROP NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='core_print_jobs_pilot_authorization_fk') THEN
  ALTER TABLE core_print_jobs ADD CONSTRAINT core_print_jobs_pilot_authorization_fk
   FOREIGN KEY(pilot_authorization_id) REFERENCES core_pilot_print_authorizations(id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='core_print_jobs_provenance_check') THEN
  ALTER TABLE core_print_jobs ADD CONSTRAINT core_print_jobs_provenance_check CHECK(
   (approval_id IS NOT NULL AND pilot_authorization_id IS NULL) OR
   (approval_id IS NULL AND pilot_authorization_id IS NOT NULL));
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS core_jobs_pilot_authorization_unique
 ON core_print_jobs(pilot_authorization_id) WHERE pilot_authorization_id IS NOT NULL;
