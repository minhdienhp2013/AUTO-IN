-- AI0 CODE-008: isolated SIMULATION-only transactional approval admission gate.
-- Owner: backend/composition/**. Live provider acceptance is NOT implemented.
-- This migration is also a defense against direct Core service calls that
-- bypass Fastify; an HTTP-only precheck would be subject to TOCTOU races.
--
-- Explicitly DO NOT mark a new inbound message as processed because a batch
-- has status DONE/COMMITTED: those indicate transport, not inclusion in the
-- active print revision. Missing provenance => block printing.
CREATE OR REPLACE FUNCTION ai0_simulation_lock_inbound_against_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pending_order uuid;
BEGIN
  -- Only conversations bound to a synthetic AI2-created order are in scope.
  -- Same core_orders row lock serializes the inbound COMMIT with staff
  -- approval. Never trust payload_json to choose the shop or customer.
  SELECT o.id INTO pending_order
    FROM core_ai_draft_proposals p
    JOIN core_orders o ON o.id=p.order_id AND o.shop_id=p.shop_id
    JOIN core_shop_settings s ON s.shop_id=p.shop_id AND s.mode='simulation'
   WHERE p.oa_id=NEW.oa_id
     AND p.customer_id=NEW.customer_id
     AND p.conversation_id=NEW.conversation_id
     AND NOT EXISTS (SELECT 1 FROM core_approvals a WHERE a.order_id=o.id)
   ORDER BY o.created_at DESC,o.id DESC
   LIMIT 1 FOR UPDATE OF o;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai0_lock_inbound_before_approval ON zalo_inbound_events;
CREATE TRIGGER ai0_lock_inbound_before_approval
 AFTER INSERT ON zalo_inbound_events
 FOR EACH ROW EXECUTE FUNCTION ai0_simulation_lock_inbound_against_approval();

CREATE OR REPLACE FUNCTION ai0_simulation_reject_unreviewed_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  original_events jsonb;
  has_pending boolean;
BEGIN
  -- This extra row lock is intentionally redundant with the Core service's
  -- own approval lock, so direct SQL inserts are guarded too.
  PERFORM 1 FROM core_orders o
    JOIN core_shop_settings s ON s.shop_id=o.shop_id AND s.mode='simulation'
   WHERE o.id=NEW.order_id FOR UPDATE OF o;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Only AI2-created orders with trusted shop/OA linkage are guarded. Other
  -- Core orders remain protected by AI1, and cannot borrow this OA identity.
  SELECT r.request_data->'event_ids' INTO original_events
    FROM core_ai_draft_proposals p
    JOIN core_revisions r ON r.order_id=p.order_id AND r.revision=1
   WHERE p.order_id=NEW.order_id LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1
    FROM core_ai_draft_proposals p
    JOIN core_orders o ON o.id=p.order_id
    JOIN zalo_inbound_events e
      ON e.oa_id=p.oa_id
     AND e.customer_id=p.customer_id
     AND e.conversation_id=p.conversation_id
   WHERE p.order_id=NEW.order_id
     AND o.id=NEW.order_id
     AND o.shop_id=p.shop_id
     AND e.received_at <= clock_timestamp()
     AND e.payload_json->>'kind' IN ('text','image','file')
     AND NOT COALESCE(original_events ? e.event_id,false)
     AND NOT EXISTS (
        SELECT 1 FROM ai0_inbound_artifact_drafts d
        WHERE d.shop_id=p.shop_id AND d.oa_id=p.oa_id
          AND d.event_id=e.event_id AND d.order_id=NEW.order_id
          AND d.status='CREATED'
     )
     -- A verified AI1 supplement batch MUST be journalled AND present in
     -- the exact reviewed revision before it can unblock approval. AI2 batch
     -- DONE/ACK or event_ids from a webhook alone are never sufficient.
     AND NOT EXISTS (
        SELECT 1 FROM core_order_inbound_reviews j
        JOIN core_revisions jr
          ON jr.order_id=j.order_id AND jr.revision=j.revision
        WHERE j.shop_id=p.shop_id AND j.oa_id=e.oa_id
          AND j.event_id=e.event_id AND j.order_id=NEW.order_id
          AND j.revision<=NEW.revision
          AND COALESCE((jr.request_data->'event_ids') ? e.event_id,false)
     )
  ) INTO has_pending;
  IF has_pending THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='AI0_PENDING_INBOUND_REVIEW',
      DETAIL='Unreviewed Zalo messages/files block print approval';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai0_guard_staff_print_approval ON core_approvals;
CREATE TRIGGER ai0_guard_staff_print_approval
 BEFORE INSERT ON core_approvals
 FOR EACH ROW EXECUTE FUNCTION ai0_simulation_reject_unreviewed_approval();
