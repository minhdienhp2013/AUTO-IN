-- Pilot custody is distinct from synthetic staff import artifacts.
CREATE TABLE IF NOT EXISTS ai0_pilot_private_sources (
 shop_id text NOT NULL REFERENCES core_shop_settings(shop_id),
 oa_id text NOT NULL,
 event_id text NOT NULL,
 customer_id text NOT NULL,
 conversation_id text NOT NULL,
 format text NOT NULL CHECK(format IN ('PDF','DOCX')),
 artifact_ref text NOT NULL UNIQUE,
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 26214400),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(oa_id,event_id),
 FOREIGN KEY(oa_id,event_id) REFERENCES zalo_inbound_events(oa_id,event_id),
 FOREIGN KEY(shop_id,oa_id) REFERENCES core_shop_zalo_oa_registry(shop_id,oa_id)
);
