export interface LocalStagingSchemaSnapshot {
  readonly inbound_events: boolean;
  readonly process_queue: boolean;
  readonly quarantine: boolean;
  readonly quarantine_scopes: boolean;
  readonly provider_event_id_column: boolean;
  readonly provider_event_index_definition: string | null;
}

const REQUIRED_PROVIDER_EVENT_INDEX =
  'create unique index zalo_official_quarantine_event_id_unique on zalo_official_quarantine using btree (oa_id, provider_event_id) where (provider_event_id is not null)';

function normalizedIndexDefinition(indexDefinition: string): string {
  return indexDefinition.toLowerCase()
    .replaceAll('"', '')
    .replace(/\bpublic\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fail closed unless the quarantine retry-deduplication migration is present. */
export function assertLocalStagingSchema(snapshot: LocalStagingSchemaSnapshot): void {
  if (!snapshot.inbound_events || !snapshot.process_queue || !snapshot.quarantine ||
      !snapshot.quarantine_scopes || !snapshot.provider_event_id_column ||
      !snapshot.provider_event_index_definition ||
      normalizedIndexDefinition(snapshot.provider_event_index_definition) !== REQUIRED_PROVIDER_EVENT_INDEX)
    throw new Error('STAGING_DATABASE_MIGRATIONS_REQUIRED');
}
