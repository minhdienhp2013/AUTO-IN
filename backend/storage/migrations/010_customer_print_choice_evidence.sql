-- AI1: customer-originated print choices are revision-bound evidence, never staff defaults.
-- Apply only after Core 001/007 and the existing AI0/AI2 source tables.
CREATE UNIQUE INDEX IF NOT EXISTS core_orders_scope_identity_uq
 ON core_orders(id,shop_id,customer_id,conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS core_revisions_scope_hash_uq
 ON core_revisions(order_id,revision,request_hash);
CREATE UNIQUE INDEX IF NOT EXISTS core_order_inbound_reviews_evidence_uq
 ON core_order_inbound_reviews(oa_id,event_id,order_id,revision);

CREATE TABLE IF NOT EXISTS core_order_customer_print_choice_batches (
 order_id uuid NOT NULL,
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL,
 customer_id text NOT NULL,
 conversation_id text NOT NULL,
 event_fingerprint char(64) NOT NULL CHECK(event_fingerprint ~ '^[a-f0-9]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 expected_revision integer NOT NULL CHECK(expected_revision>=2),
 expected_request_hash char(64) NOT NULL CHECK(expected_request_hash ~ '^[a-f0-9]{64}$'),
 expected_source_sha256 char(64) NOT NULL CHECK(expected_source_sha256 ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL CHECK(revision>expected_revision),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 source_event_id text NOT NULL,
 fields text[] NOT NULL CHECK(cardinality(fields) BETWEEN 1 AND 3 AND
   fields <@ ARRAY['copies','paper_size','duplex']::text[]),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(order_id,event_fingerprint),
 UNIQUE(order_id,idempotency_key),
 UNIQUE(order_id,revision),
 FOREIGN KEY(order_id,shop_id,customer_id,conversation_id)
   REFERENCES core_orders(id,shop_id,customer_id,conversation_id),
 FOREIGN KEY(order_id,expected_revision) REFERENCES core_revisions(order_id,revision),
 FOREIGN KEY(order_id,expected_revision,expected_request_hash)
   REFERENCES core_revisions(order_id,revision,request_hash),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision),
 FOREIGN KEY(order_id,revision,request_hash) REFERENCES core_revisions(order_id,revision,request_hash)
);

CREATE TABLE IF NOT EXISTS core_order_customer_print_choice_evidence (
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL,
 customer_id text NOT NULL,
 conversation_id text NOT NULL,
 order_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>=2),
 source_event_id text NOT NULL,
 source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 field text NOT NULL CHECK(field IN ('copies','paper_size','duplex')),
 value jsonb NOT NULL CHECK(CASE
   WHEN field='copies' AND jsonb_typeof(value)='number' THEN
     CASE WHEN value::text ~ '^[0-9]+$' THEN (value::text)::integer BETWEEN 1 AND 500 ELSE false END
   WHEN field='paper_size' THEN jsonb_typeof(value)='string' AND value #>> '{}' IN ('A3','A4','A5')
   WHEN field='duplex' THEN jsonb_typeof(value)='boolean'
   ELSE false END),
 origin text NOT NULL DEFAULT 'customer' CHECK(origin='customer'),
 event_id text NOT NULL,
 event_revision integer NOT NULL CHECK(event_revision>=1),
 parser_version text NOT NULL CHECK(parser_version='vn-print-setting.literal.v1'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(order_id,revision,field),
 FOREIGN KEY(order_id,shop_id,customer_id,conversation_id)
   REFERENCES core_orders(id,shop_id,customer_id,conversation_id),
 FOREIGN KEY(order_id,revision) REFERENCES core_revisions(order_id,revision),
 FOREIGN KEY(order_id,revision,request_hash) REFERENCES core_revisions(order_id,revision,request_hash),
 FOREIGN KEY(oa_id,event_id,order_id,event_revision)
   REFERENCES core_order_inbound_reviews(oa_id,event_id,order_id,revision)
);
CREATE INDEX IF NOT EXISTS core_customer_print_choice_scope_idx
 ON core_order_customer_print_choice_evidence(shop_id,oa_id,order_id,revision,source_sha256);
