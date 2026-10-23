-- AI1: an explicitly supervised real test is constrained to one shop/order/printer tuple.
-- Rows are absent by default; applications must never create or widen these grants implicitly.
CREATE TABLE IF NOT EXISTS core_print_controlled_test_scopes (
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 order_id uuid NOT NULL REFERENCES core_orders(id),
 printer_id text NOT NULL CHECK(length(printer_id) BETWEEN 1 AND 128),
 enabled boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,
 configured_by uuid NOT NULL REFERENCES core_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(shop_id,order_id,printer_id)
);

CREATE INDEX IF NOT EXISTS core_print_controlled_test_scopes_active_idx
 ON core_print_controlled_test_scopes(shop_id,order_id,printer_id,expires_at) WHERE enabled;
