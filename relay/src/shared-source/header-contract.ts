/** Additive metadata only. No historical body scan/backfill and no source of
 * trust from raw payload: the authenticated Journal publisher stamps headers. */
export const RELAY_SOURCE_HEADER_SQL=[
 `ALTER TABLE shared.memory_source_contract ADD COLUMN IF NOT EXISTS header_version INT NOT NULL DEFAULT 0`,
 `ALTER TABLE public.events ADD COLUMN IF NOT EXISTS source_header_version SMALLINT,
   ADD COLUMN IF NOT EXISTS source_sequence BIGINT,
   ADD COLUMN IF NOT EXISTS canonical_payload_hash TEXT,
   ADD COLUMN IF NOT EXISTS source_classification JSONB`,
 `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.events'::regclass AND conname='events_memory_source_header_v1') THEN
   ALTER TABLE public.events ADD CONSTRAINT events_memory_source_header_v1 CHECK (
    (source_header_version IS NULL AND source_sequence IS NULL AND canonical_payload_hash IS NULL AND source_classification IS NULL)
    OR (source_header_version IS NOT NULL AND source_header_version=1 AND source_sequence IS NOT NULL AND source_sequence>0
      AND canonical_payload_hash IS NOT NULL AND canonical_payload_hash ~ '^[a-f0-9]{64}$'
      AND source_classification IS NOT NULL AND jsonb_typeof(source_classification)='object' AND octet_length(source_classification::text)<=65536));
  END IF;END $$`,
 `UPDATE shared.memory_source_contract SET header_version=1 WHERE version=1`,
] as const
