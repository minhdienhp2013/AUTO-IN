-- CODE-101 hardening: snapshot the mode at the exact point of mark-sending.
-- Existing in-flight jobs remain NULL: fail closed and require staff reconciliation.
ALTER TABLE core_print_jobs ADD COLUMN IF NOT EXISTS mode_at_send text
 CHECK (mode_at_send IN ('simulation','controlled_test','production','safe'));
