// Independent archives have no Relay event ID. Their original UUID, verified
// manifest and owner are the identity. Reclaimed bodies are never imported.
const columns = `source_event_id,installation_id,owner_user_id,session_id,turn_id,event_type,
 occurred_at,origin,origin_position,classification,source_provenance,source_sequence,
 manifest_hash,content_hash,payload_hash,source_version,body_reclaimed_at,payload`
const values = (r: string) => `${r}.source_event_id,${r}.installation_id,${r}.legacy_owner_user_id,
 ${r}.session_id,${r}.turn_id,${r}.event_type,${r}.occurred_at,${r}.origin,${r}.origin_position,
 ${r}.classification,${r}.source_provenance,${r}.source_sequence,${r}.legacy_manifest_hash,
 ${r}.content_hash,${r}.payload_hash,${r}.source_version,${r}.body_reclaimed_at,
 CASE WHEN ${r}.body_reclaimed_at IS NULL THEN ${r}.payload END`
const verified = (r: string) => `${r}.source_kind='legacy_archive' AND ${r}.mapping_state='verified'`

export const ARCHIVE_CUSTODY_SCHEMA = [
 `CREATE TABLE IF NOT EXISTS shared.memory_archive_records(
   source_event_id UUID PRIMARY KEY,
   installation_id UUID NOT NULL REFERENCES memory.memory_installations ON DELETE CASCADE,
   owner_user_id INTEGER NOT NULL CHECK(owner_user_id>0),
   session_id TEXT NOT NULL CHECK(left(session_id,5)<>'team_'), turn_id TEXT,
   event_type TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
   origin TEXT NOT NULL CHECK(origin IN('feed','snapshot')), origin_position TEXT NOT NULL,
   classification JSONB NOT NULL, source_provenance JSONB NOT NULL
     CHECK(NOT(source_provenance ?| ARRAY['team','accepted_delivery'])),
   source_sequence BIGINT, manifest_hash TEXT NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'),
   content_hash BYTEA NOT NULL CHECK(octet_length(content_hash)=32),
   payload_hash BYTEA NOT NULL CHECK(octet_length(payload_hash)=32),
   source_version JSONB NOT NULL, body_reclaimed_at TIMESTAMPTZ, payload JSONB,
   CHECK((body_reclaimed_at IS NULL)=(payload IS NOT NULL)))`,
 `CREATE INDEX IF NOT EXISTS memory_archive_owner_session ON shared.memory_archive_records(installation_id,owner_user_id,session_id,source_event_id)`,
 `CREATE OR REPLACE FUNCTION shared.guard_memory_archive_custody() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,shared AS $$ BEGIN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||NEW.installation_id,0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:session:'||NEW.installation_id||':'||NEW.session_id,0))
   THEN RAISE EXCEPTION 'source_privacy_fence_busy' USING ERRCODE='55P03';END IF;
  IF EXISTS(SELECT 1 FROM memory.memory_session_tombstones WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id)
   OR EXISTS(SELECT 1 FROM memory.memory_installations WHERE installation_id=NEW.installation_id AND local_status IN('purging','purged'))
   THEN RETURN NULL;END IF;
  IF TG_OP='UPDATE' AND OLD.body_reclaimed_at IS NOT NULL THEN NEW.body_reclaimed_at=OLD.body_reclaimed_at;NEW.payload=NULL;END IF;
  RETURN NEW;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.guard_memory_archive_custody() FROM PUBLIC`,
 `DROP TRIGGER IF EXISTS guard_memory_archive_custody ON shared.memory_archive_records;
 CREATE TRIGGER guard_memory_archive_custody BEFORE INSERT OR UPDATE ON shared.memory_archive_records FOR EACH ROW
 EXECUTE FUNCTION shared.guard_memory_archive_custody()`,
 // Source migration tools from earlier releases may still finalize or revoke
 // custody while the old schema exists. Observe those writes in the same tx.
 `CREATE OR REPLACE FUNCTION shared.sync_memory_archive_custody() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF TG_OP<>'INSERT' THEN
    IF TG_OP='DELETE' THEN DELETE FROM shared.memory_archive_records WHERE source_event_id=OLD.source_event_id; RETURN NULL; END IF;
    IF NOT COALESCE((${verified('NEW')}),FALSE) OR NEW.source_event_id<>OLD.source_event_id THEN
     DELETE FROM shared.memory_archive_records WHERE source_event_id=OLD.source_event_id;
    END IF;
   END IF;
   IF ${verified('NEW')} THEN
    IF NEW.canonical_key IS DISTINCT FROM NEW.source_event_id::text OR NEW.canonical_session_key IS DISTINCT FROM NEW.session_id
      OR NEW.adapter_version IS DISTINCT FROM 'legacy-archive-v1' THEN RAISE EXCEPTION 'invalid_archive_identity'; END IF;
    INSERT INTO shared.memory_archive_records(${columns}) VALUES (${values('NEW')})
    ON CONFLICT(source_event_id) DO UPDATE SET
     (installation_id,owner_user_id,session_id,turn_id,event_type,occurred_at,origin,origin_position,
      classification,source_provenance,source_sequence,manifest_hash,content_hash,payload_hash,source_version,body_reclaimed_at,payload)
     =(EXCLUDED.installation_id,EXCLUDED.owner_user_id,EXCLUDED.session_id,EXCLUDED.turn_id,EXCLUDED.event_type,
       EXCLUDED.occurred_at,EXCLUDED.origin,EXCLUDED.origin_position,EXCLUDED.classification,EXCLUDED.source_provenance,
       EXCLUDED.source_sequence,EXCLUDED.manifest_hash,EXCLUDED.content_hash,EXCLUDED.payload_hash,EXCLUDED.source_version,
       COALESCE(memory_archive_records.body_reclaimed_at,EXCLUDED.body_reclaimed_at),
       CASE WHEN memory_archive_records.body_reclaimed_at IS NULL THEN EXCLUDED.payload END);
   END IF; RETURN NULL;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.sync_memory_archive_custody() FROM PUBLIC`,
 `DO $$ BEGIN
   IF to_regclass('memory.source_events') IS NULL THEN RETURN; END IF;
   IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='shared.memory_source_contract'::regclass AND attname='archive_custody_version' AND NOT attisdropped) THEN
    LOCK TABLE memory.source_events IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS(SELECT 1 FROM memory.source_events s WHERE ${verified('s')} AND
     (s.canonical_key IS DISTINCT FROM s.source_event_id::text OR s.canonical_session_key IS DISTINCT FROM s.session_id
      OR s.adapter_version IS DISTINCT FROM 'legacy-archive-v1')) THEN RAISE EXCEPTION 'invalid_archive_identity'; END IF;
    INSERT INTO shared.memory_archive_records(${columns})
     SELECT ${values('s')} FROM memory.source_events s WHERE ${verified('s')};
    CREATE TRIGGER sync_archive_custody_insert AFTER INSERT ON memory.source_events FOR EACH ROW
     WHEN (NEW.source_kind='legacy_archive') EXECUTE FUNCTION shared.sync_memory_archive_custody();
    CREATE TRIGGER sync_archive_custody_update AFTER UPDATE ON memory.source_events FOR EACH ROW
     WHEN (OLD.source_kind='legacy_archive' OR NEW.source_kind='legacy_archive') EXECUTE FUNCTION shared.sync_memory_archive_custody();
    CREATE TRIGGER sync_archive_custody_delete AFTER DELETE ON memory.source_events FOR EACH ROW
     WHEN (OLD.source_kind='legacy_archive') EXECUTE FUNCTION shared.sync_memory_archive_custody();
    ALTER TABLE shared.memory_source_contract ADD COLUMN archive_custody_version INT NOT NULL DEFAULT 1 CHECK(archive_custody_version=1);
   END IF;
 END $$`,
 // Version even direct archive imports/changes. A reader finishes object
 // storage IO outside a transaction, then rechecks this root before commit.
 ...(['INSERT','UPDATE','DELETE'] as const).flatMap(op=>{
  const name='capture_native_archive_'+op.toLowerCase()
  const roots=(table:string)=>`SELECT owner_user_id::text||':'||session_id AS root FROM ${table}`
  const changed=op==='INSERT'?roots('new_rows'):op==='DELETE'?roots('old_rows'):roots('new_rows')+' UNION '+roots('old_rows')
  return [`CREATE OR REPLACE FUNCTION shared.${name}() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
   SET search_path=pg_catalog,shared AS $$ DECLARE key TEXT; BEGIN
    FOR key IN SELECT DISTINCT root COLLATE "C" FROM (${changed}) r ORDER BY 1 LOOP
     PERFORM shared.mark_memory_source_dirty('legacy_archive',key);
    END LOOP; RETURN NULL;
   END $$`,
   `REVOKE ALL ON FUNCTION shared.${name}() FROM PUBLIC`,
   `DROP TRIGGER IF EXISTS ${name} ON shared.memory_archive_records;
    CREATE TRIGGER ${name} AFTER ${op} ON shared.memory_archive_records
    REFERENCING ${op==='INSERT'?'': 'OLD TABLE AS old_rows'} ${op==='DELETE'?'':'NEW TABLE AS new_rows'}
    FOR EACH STATEMENT EXECUTE FUNCTION shared.${name}()`,
   `DO $$ BEGIN IF to_regclass('memory.source_events') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS legacy_archive_capture_${op.toLowerCase()} ON memory.source_events; END IF; END $$`]
 }),
 `CREATE OR REPLACE FUNCTION shared.purge_memory_archive_records() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,shared AS $$ BEGIN
  IF TG_TABLE_NAME='memory_session_tombstones' THEN
   DELETE FROM shared.memory_archive_records WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id;
  ELSE DELETE FROM shared.memory_archive_records WHERE installation_id=NEW.installation_id;
  END IF; RETURN NULL;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.purge_memory_archive_records() FROM PUBLIC`,
 `DROP TRIGGER IF EXISTS purge_memory_session_archives ON memory.memory_session_tombstones;
 CREATE TRIGGER purge_memory_session_archives AFTER INSERT OR UPDATE ON memory.memory_session_tombstones FOR EACH ROW
 EXECUTE FUNCTION shared.purge_memory_archive_records();
 DROP TRIGGER IF EXISTS purge_memory_installation_archives ON memory.memory_installations;
 CREATE TRIGGER purge_memory_installation_archives AFTER UPDATE OF local_status ON memory.memory_installations
 FOR EACH ROW WHEN (NEW.local_status='purged') EXECUTE FUNCTION shared.purge_memory_archive_records()`,
] as const
