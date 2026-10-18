/**
 * AI0-owned migration runner can consume this ordered manifest.
 * There is deliberately no implicit migration during normal startup.
 * Schema changes must be reviewed and applied as a separate operator action.
 */
export const CORE_MIGRATIONS = [
  '001_core.sql',
  '002_send_mode.sql',
  '003_confirmed_queue.sql',
  '004_conversation_generation.sql',
  '005_ai_order_port.sql',
  '006_verified_confirmation.sql',
  '007_active_order_inbound.sql',
  '008_shop_schedule.sql',
  '009_tn005_suggested_outbox.sql',
  '010_customer_print_choice_evidence.sql',
  '011_print_evidence_binding.sql',
  '012_preview_review_receipts.sql',
  '013_inbound_review_items.sql'
] as const;
