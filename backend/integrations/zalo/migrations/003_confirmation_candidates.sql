-- CODE-402: ONLY a server-reviewed candidate, NEVER a core customer confirmation.
-- AI0 must apply AFTER AI1 001-005 and AI2 001-002 to an isolated test DB.
-- No triggers or foreign keys to core_confirmations / print approval.
CREATE TABLE IF NOT EXISTS zalo_confirmation_candidates (
  candidate_id uuid PRIMARY KEY,
  shop_id text NOT NULL,
  oa_id text NOT NULL,
  event_id text NOT NULL,
  conversation_id text NOT NULL,
  customer_id text NOT NULL,
  challenge_id text NOT NULL CHECK(length(challenge_id) BETWEEN 1 AND 128),
  order_id uuid NOT NULL,
  active_revision integer NOT NULL CHECK(active_revision>=1),
  request_hash char(64) NOT NULL,
  kind text NOT NULL CHECK(kind IN ('request','quote')),
  quote_revision integer,
  expected_generation bigint NOT NULL CHECK(expected_generation>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PENDING_AI1_REVIEW'
    CHECK(status IN ('PENDING_AI1_REVIEW','NEEDS_HUMAN')),
  UNIQUE(shop_id,oa_id,event_id),
  UNIQUE(shop_id,oa_id,challenge_id),
  FOREIGN KEY(oa_id,event_id) REFERENCES zalo_inbound_events(oa_id,event_id),
  CHECK ((kind='request' AND quote_revision IS NULL) OR
         (kind='quote' AND quote_revision IS NOT NULL AND quote_revision>=1))
);
CREATE INDEX IF NOT EXISTS zalo_confirmation_candidates_pending_idx
  ON zalo_confirmation_candidates(shop_id,oa_id,created_at,candidate_id)
  WHERE status='PENDING_AI1_REVIEW';
-- Deliberately no INSERT/UPDATE of core_confirmations.
