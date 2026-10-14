-- AI0 CODE-402: trusted OA scope registry, auditable owner review, and manual-order approval gate.
-- The official runtime route is disabled by default. This migration does not store OA secrets.
-- AI2 ingress and this gate serialize on zalo_official_quarantine_scopes(oa_id).
CREATE TABLE IF NOT EXISTS ai0_official_zalo_oa_registry (
  oa_id text PRIMARY KEY CHECK(length(oa_id) BETWEEN 1 AND 128),
  app_id text NOT NULL CHECK(length(app_id) BETWEEN 1 AND 128),
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (oa_id,shop_id)
);
CREATE INDEX IF NOT EXISTS ai0_official_zalo_oa_shop_idx
  ON ai0_official_zalo_oa_registry(shop_id,oa_id);

-- Populated only after an operator has verified the OA user/customer/chat binding.
-- The provider user ID is not accepted from a browser or webhook as a trusted mapping.
CREATE TABLE IF NOT EXISTS ai0_official_zalo_identity_map (
  oa_id text NOT NULL,
  shop_id text NOT NULL,
  provider_user_id text NOT NULL CHECK(length(provider_user_id) BETWEEN 1 AND 128),
  customer_id text NOT NULL CHECK(length(customer_id) BETWEEN 1 AND 128),
  conversation_id text NOT NULL CHECK(length(conversation_id) BETWEEN 1 AND 256),
  verified_by uuid NOT NULL REFERENCES core_users(id),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (oa_id,provider_user_id),
  FOREIGN KEY (oa_id,shop_id) REFERENCES ai0_official_zalo_oa_registry(oa_id,shop_id)
);
CREATE INDEX IF NOT EXISTS ai0_official_zalo_identity_lookup_idx
  ON ai0_official_zalo_identity_map(oa_id,provider_user_id)
  WHERE active=true;

-- The only disposition that clears the approval gate is an explicit owner decision
-- that this receipt requires no order change. "Needs follow-up" remains pending.
-- No customer text, raw bytes, file URL, click payload, or OA secret is stored here.
CREATE TABLE IF NOT EXISTS ai0_official_quarantine_reviews (
  id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES zalo_official_quarantine(id),
  oa_id text NOT NULL,
  shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
  actor_id uuid NOT NULL REFERENCES core_users(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  disposition text NOT NULL CHECK(disposition IN ('NO_ORDER_CHANGE','NEEDS_FOLLOW_UP')),
  note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 500),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(shop_id,actor_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS ai0_official_quarantine_reviews_receipt_idx
  ON ai0_official_quarantine_reviews(receipt_id,created_at);

-- AI1's CODE-008 approval transaction locks and checks the proposal-bound OA scope.
-- For manual orders without a trusted proposal OA, check every server-registered OA
-- for the shop. Both paths use Core order -> sorted OA scope(s) -> quarantine state,
-- matching AI2 ingress. The default runtime remains OFF and live OA is not enabled.
CREATE OR REPLACE FUNCTION ai0_reject_manual_approval_with_official_quarantine()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_shop text;
  proposal_count integer;
  scope_ids text[];
  scope_id text;
BEGIN
  SELECT o.shop_id INTO target_shop
    FROM core_orders o
    JOIN core_shop_settings s ON s.shop_id=o.shop_id AND s.mode='simulation'
   WHERE o.id=NEW.order_id
   FOR UPDATE OF o;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT count(*) INTO proposal_count
    FROM core_ai_draft_proposals p
   WHERE p.order_id=NEW.order_id AND p.shop_id=target_shop;
  -- AI1's proposal-linked Core approval path locks and checks its single trusted
  -- OA scope before inserting the approval. The manual-order branch below is AI0's.
  IF proposal_count>0 THEN RETURN NEW; END IF;

  SELECT array_agg(r.oa_id ORDER BY r.oa_id) INTO scope_ids
    FROM ai0_official_zalo_oa_registry r
   WHERE r.shop_id=target_shop;
  FOREACH scope_id IN ARRAY COALESCE(scope_ids,ARRAY[]::text[]) LOOP
    INSERT INTO zalo_official_quarantine_scopes(oa_id)
      VALUES(scope_id) ON CONFLICT (oa_id) DO NOTHING;
    PERFORM 1 FROM zalo_official_quarantine_scopes
      WHERE oa_id=scope_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE='P0001',
        MESSAGE='AI0_PENDING_INBOUND_REVIEW',
        DETAIL='Official OA quarantine scope is unavailable';
    END IF;
    IF EXISTS (
      SELECT 1 FROM zalo_official_quarantine q
       WHERE q.oa_id=scope_id AND q.status='NEEDS_HUMAN'
    ) THEN
      RAISE EXCEPTION USING ERRCODE='P0001',
        MESSAGE='AI0_PENDING_INBOUND_REVIEW',
        DETAIL='Signed OA event still needs human review';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai0_guard_manual_official_quarantine ON core_approvals;
CREATE TRIGGER ai0_guard_manual_official_quarantine
 BEFORE INSERT ON core_approvals
 FOR EACH ROW EXECUTE FUNCTION ai0_reject_manual_approval_with_official_quarantine();
