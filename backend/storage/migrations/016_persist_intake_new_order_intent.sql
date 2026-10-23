-- AI1: persist the customer's NEW-order boundary on the intake it opens.
-- The marker is written only at intake creation and remains attached when later
-- queue leases add file/settings events to that same intake.
ALTER TABLE core_oa_intake_batches
 ADD COLUMN IF NOT EXISTS new_order_requested boolean NOT NULL DEFAULT false;
