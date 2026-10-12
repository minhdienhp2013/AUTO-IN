-- CODE-401: challenge-bound, verified OA customer confirmation, without pretending to be a customer.
-- AI0 must verify provider signature and explicit postback type before writing normalized inbound events.
CREATE TABLE IF NOT EXISTS core_confirmation_challenges (
 id uuid PRIMARY KEY,
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL,
 order_id uuid NOT NULL REFERENCES core_orders(id),
 revision integer NOT NULL CHECK(revision>=1),
 request_hash char(64) NOT NULL,
 customer_id text NOT NULL,
 conversation_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('request','quote')),
 quote_revision integer,
 generation bigint NOT NULL CHECK(generation>=0),
 secret_hash char(64) NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_event_id text,
 confirmation_id uuid UNIQUE REFERENCES core_confirmations(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((kind='request' AND quote_revision IS NULL) OR (kind='quote' AND quote_revision>=1)),
 CHECK ((consumed_event_id IS NULL AND confirmation_id IS NULL) OR
        (consumed_event_id IS NOT NULL AND confirmation_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS core_confirmation_challenges_scope_idx
 ON core_confirmation_challenges(shop_id,oa_id,order_id,revision,kind);
CREATE TABLE IF NOT EXISTS core_verified_confirmation_events (
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL,
 event_id text NOT NULL,
 challenge_id uuid NOT NULL UNIQUE REFERENCES core_confirmation_challenges(id),
 confirmation_id uuid NOT NULL UNIQUE REFERENCES core_confirmations(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop_id,oa_id,event_id)
);
