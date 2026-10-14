-- CODE-301: internal AI2 suggestion and unclaimed HUMAN routing. Apply after 001-004.
-- Requires already-migrated AI2 zalo_inbound_events for verified source events.
CREATE TABLE IF NOT EXISTS core_ai_draft_proposals (
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL, conversation_id text NOT NULL, customer_id text NOT NULL,
 event_fingerprint char(64) NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 content_hash char(64) NOT NULL,
 order_id uuid NOT NULL REFERENCES core_orders(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop_id,oa_id,event_fingerprint), UNIQUE(shop_id,oa_id,idempotency_key), UNIQUE(order_id)
);
ALTER TABLE core_conversation_controls ADD COLUMN IF NOT EXISTS ai_route_fingerprint char(64);
ALTER TABLE core_conversation_controls ADD COLUMN IF NOT EXISTS ai_route_reason text;
-- Original unnamed 004 table-level CHECK demands a staff UUID for status HUMAN.
-- Routing by AI can only queue an UNCLAIMED HUMAN conversation; never fabricate staff IDs.
ALTER TABLE core_conversation_controls DROP CONSTRAINT IF EXISTS core_conversation_controls_check;
ALTER TABLE core_conversation_controls DROP CONSTRAINT IF EXISTS core_conversation_claim_check;
ALTER TABLE core_conversation_controls ADD CONSTRAINT core_conversation_claim_check
 CHECK ((status='AI' AND claimed_by IS NULL) OR status='HUMAN');
