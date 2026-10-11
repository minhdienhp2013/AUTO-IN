-- CODE-101. Apply with psql -v ON_ERROR_STOP=1 -1 -f backend/storage/migrations/001_core.sql
-- All data belongs to one shop; never delete financial records while closing print processing.
CREATE TABLE IF NOT EXISTS core_shop_settings (
 shop_id text PRIMARY KEY,
 mode text NOT NULL DEFAULT 'simulation' CHECK (mode IN ('simulation','controlled_test','production','safe')),
 printing_enabled boolean NOT NULL DEFAULT false,
 manual_lock boolean NOT NULL DEFAULT false,
 holiday_dates text[] NOT NULL DEFAULT '{}',
 open_at text NOT NULL DEFAULT '07:00', close_at text NOT NULL DEFAULT '21:30',
 timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh'
);
CREATE TABLE IF NOT EXISTS core_users (
 id uuid PRIMARY KEY, shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 username text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('staff','owner')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(shop_id,username)
);
CREATE TABLE IF NOT EXISTS core_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES core_users(id),
 token_hash char(64) NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core_orders (
 id uuid PRIMARY KEY, shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 customer_id text NOT NULL, conversation_id text,
 active_revision integer NOT NULL DEFAULT 1 CHECK(active_revision>=1),
 manual_lock boolean NOT NULL DEFAULT false, print_closed boolean NOT NULL DEFAULT false,
 closed_reason text, delivered_sheets bigint NOT NULL DEFAULT 0 CHECK(delivered_sheets>=0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_orders_shop_date_idx ON core_orders(shop_id,created_at DESC);
CREATE TABLE IF NOT EXISTS core_revisions (
 order_id uuid NOT NULL REFERENCES core_orders(id), revision integer NOT NULL CHECK(revision>=1),
 request_hash char(64) NOT NULL, request_data jsonb NOT NULL,
 plan jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(order_id,revision)
);
CREATE TABLE IF NOT EXISTS core_quotes (
 order_id uuid NOT NULL REFERENCES core_orders(id), quote_revision integer NOT NULL CHECK(quote_revision>=1),
 amount_vnd bigint NOT NULL CHECK(amount_vnd>=0),deposit_required_vnd bigint NOT NULL CHECK(deposit_required_vnd>=0),
 significant_cost boolean NOT NULL DEFAULT false, entered_by uuid NOT NULL REFERENCES core_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(order_id,quote_revision)
);
CREATE TABLE IF NOT EXISTS core_confirmations (
 id uuid PRIMARY KEY,order_id uuid NOT NULL,revision integer NOT NULL,request_hash char(64) NOT NULL,
 kind text NOT NULL CHECK(kind IN ('request','quote')),quote_revision integer,
 customer_id text NOT NULL,channel text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision),
 CHECK((kind='request' AND quote_revision IS NULL) OR (kind='quote' AND quote_revision IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS core_confirmations_lookup_idx ON core_confirmations(order_id,revision,kind,quote_revision);
CREATE TABLE IF NOT EXISTS core_approvals (
 id uuid PRIMARY KEY,order_id uuid NOT NULL,revision integer NOT NULL,request_hash char(64) NOT NULL,
 quote_revision integer,actor_id uuid NOT NULL REFERENCES core_users(id),
 deposit_short_vnd bigint NOT NULL DEFAULT 0 CHECK(deposit_short_vnd>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision)
);
CREATE TABLE IF NOT EXISTS core_print_jobs (
 id uuid PRIMARY KEY,order_id uuid NOT NULL,revision integer NOT NULL,request_hash char(64) NOT NULL,
 approval_id uuid NOT NULL REFERENCES core_approvals(id),printer_id text NOT NULL,
 state text NOT NULL DEFAULT 'NOT_SENT' CHECK(state IN ('NOT_SENT','SENDING','SENT_UNVERIFIED','UNKNOWN','VERIFIED_DONE','SIMULATED_DONE')),
 claimed_by text,lease_secret_hash char(64),lease_until timestamptz,
 sent_at timestamptz,reported_at timestamptz,evidence_kind text,
 verified_sheets bigint NOT NULL DEFAULT 0 CHECK(verified_sheets>=0),verified_by uuid REFERENCES core_users(id),
 cancelled_at timestamptz,
 original_job_id uuid REFERENCES core_print_jobs(id),authorized_reprint_by uuid REFERENCES core_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision),
 CHECK ((original_job_id IS NULL AND authorized_reprint_by IS NULL) OR (original_job_id IS NOT NULL AND authorized_reprint_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS core_jobs_first_approval_unique ON core_print_jobs(order_id,revision) WHERE original_job_id IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS core_jobs_claim_idx ON core_print_jobs(printer_id,state,created_at) WHERE cancelled_at IS NULL;
CREATE TABLE IF NOT EXISTS core_payments (
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES core_orders(id),
 direction text NOT NULL CHECK(direction IN('received','refund_approved','refunded')),
 method text NOT NULL CHECK(method IN ('cash','bank_transfer')),
 amount_vnd bigint NOT NULL CHECK(amount_vnd>0),reference text,
 verified_by uuid NOT NULL REFERENCES core_users(id),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core_deliveries (
 id uuid PRIMARY KEY,order_id uuid NOT NULL REFERENCES core_orders(id),
 physical_sheets bigint NOT NULL CHECK(physical_sheets>0),actor_id uuid NOT NULL REFERENCES core_users(id),
 note text,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS core_idempotency (
 shop_id text NOT NULL, actor_id text NOT NULL,action text NOT NULL,key text NOT NULL,
 payload_hash char(64) NOT NULL,response jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop_id,actor_id,action,key)
);
CREATE TABLE IF NOT EXISTS core_audit (
 id uuid PRIMARY KEY,shop_id text NOT NULL,actor_id text NOT NULL,action text NOT NULL,
 order_id uuid NOT NULL,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS core_audit_order_idx ON core_audit(order_id,created_at);
