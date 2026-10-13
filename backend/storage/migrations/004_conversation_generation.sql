-- CODE-201 TN-027: generation bound to a shop and a verified, locally linked conversation.
-- AI2 owns inbound events; it must not update this control table directly.
CREATE TABLE IF NOT EXISTS core_conversation_controls (
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 conversation_id text NOT NULL CHECK(length(conversation_id)>0 AND length(conversation_id)<=256),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 status text NOT NULL DEFAULT 'AI' CHECK(status IN ('AI','HUMAN')),
 claimed_by uuid REFERENCES core_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(shop_id,conversation_id),
 CHECK ((status='AI' AND claimed_by IS NULL) OR (status='HUMAN' AND claimed_by IS NOT NULL))
);
-- Backfill already linked orders; no automatic AI return or generation reset.
INSERT INTO core_conversation_controls(shop_id,conversation_id)
SELECT DISTINCT shop_id,conversation_id FROM core_orders
WHERE conversation_id IS NOT NULL AND length(conversation_id)>0 AND length(conversation_id)<=256
ON CONFLICT DO NOTHING;
