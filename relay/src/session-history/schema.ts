import type pg from 'pg'

/** Prepare references and query projections without permitting removal of hot
 * payloads yet. The NOT NULL retirement belongs to the reviewed publish gate. */
export async function initSessionHistoryBodySchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`
    ALTER TABLE events ADD COLUMN IF NOT EXISTS body_storage TEXT NOT NULL DEFAULT 'hot';
    ALTER TABLE events ADD COLUMN IF NOT EXISTS body_header JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS body_manifest_id UUID;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS body_chunk_ordinal INT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS body_owner_user_id INT;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS body_activity_epoch BIGINT;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='events'::regclass AND conname='events_body_location') THEN
        ALTER TABLE events ADD CONSTRAINT events_body_location CHECK (
          (body_storage='hot' AND payload IS NOT NULL AND body_manifest_id IS NULL AND body_chunk_ordinal IS NULL
            AND body_owner_user_id IS NULL AND body_activity_epoch IS NULL)
          OR (body_storage='cold' AND payload IS NULL AND body_manifest_id IS NOT NULL AND body_chunk_ordinal IS NOT NULL AND body_chunk_ordinal>=0
            AND body_owner_user_id IS NOT NULL AND body_activity_epoch IS NOT NULL AND body_activity_epoch>=0));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='events'::regclass AND conname='events_body_manifest_binding') THEN
        ALTER TABLE events ADD CONSTRAINT events_body_manifest_binding
          FOREIGN KEY(body_manifest_id,body_owner_user_id,session_id,body_activity_epoch)
          REFERENCES session_archive_manifests(manifest_id,user_id,session_id,activity_epoch);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='events'::regclass AND conname='events_body_chunk_binding') THEN
        ALTER TABLE events ADD CONSTRAINT events_body_chunk_binding
          FOREIGN KEY(body_manifest_id,body_chunk_ordinal) REFERENCES session_archive_chunks(manifest_id,ordinal);
      END IF;
    END $$;

    CREATE OR REPLACE FUNCTION session_event_body_header(input JSONB) RETURNS JSONB
      LANGUAGE SQL IMMUTABLE STRICT AS $$
      SELECT COALESCE((SELECT jsonb_object_agg(key,value) FROM jsonb_each(CASE WHEN jsonb_typeof(input)='object' THEN input ELSE '{}'::jsonb END)
        WHERE key=ANY(ARRAY['agent','agent_id','event_id','message_id','part_id','revision','streaming','model','effort','turn_id'])
          AND jsonb_typeof(value) IN ('string','number','boolean') AND pg_column_size(value)<=1024),'{}'::jsonb)
        || CASE WHEN input ? 'usage' THEN jsonb_build_object('usage',COALESCE((SELECT jsonb_object_agg(key,value)
          FROM jsonb_each(CASE WHEN jsonb_typeof(input->'usage')='object' THEN input->'usage' ELSE '{}'::jsonb END)
          WHERE key=ANY(ARRAY['input_tokens','output_tokens','cache_read_tokens','cache_create_tokens','reasoning_tokens','total_tokens'])
            AND jsonb_typeof(value) IN ('number','string') AND length(value::text)<=24
            AND (value#>>'{}') ~ '^[0-9]+$'),'{}'::jsonb)) ELSE '{}'::jsonb END;
    $$;
    CREATE OR REPLACE FUNCTION maintain_session_event_body_header() RETURNS TRIGGER
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.body_storage='cold' AND (TG_OP='INSERT' OR OLD.body_storage='hot') THEN
          IF NOT EXISTS(SELECT 1 FROM session_archive_manifests m JOIN session_archive_chunks c USING(manifest_id)
            WHERE m.manifest_id=NEW.body_manifest_id AND m.state='published' AND c.ordinal=NEW.body_chunk_ordinal)
            THEN RAISE EXCEPTION 'cold event manifest is not published'; END IF;
          IF EXISTS(SELECT 1 FROM session_archive_object_deletions q JOIN session_archive_chunks c ON c.object_key=q.object_key
            JOIN session_archive_manifests m USING(manifest_id) WHERE c.manifest_id=NEW.body_manifest_id AND c.ordinal=NEW.body_chunk_ordinal
              AND q.storage_namespace=m.storage_namespace) THEN RAISE EXCEPTION 'cold object is being collected'; END IF;
        END IF;
        IF NEW.body_storage='hot' THEN NEW.body_header=session_event_body_header(NEW.payload);
        ELSIF TG_OP='UPDATE' AND OLD.body_storage='hot' THEN NEW.body_header=session_event_body_header(OLD.payload);
        END IF;
        RETURN NEW;
      END $$;
    DROP TRIGGER IF EXISTS events_body_header ON events;
    CREATE TRIGGER events_body_header BEFORE INSERT OR UPDATE OF payload,body_storage ON events
      FOR EACH ROW EXECUTE FUNCTION maintain_session_event_body_header();
    CREATE INDEX IF NOT EXISTS idx_events_body_agent_id_desc ON events(session_id,((COALESCE(payload,body_header)->>'agent_id')),id DESC)
      WHERE COALESCE(payload,body_header)?'agent_id';
  `)
}
