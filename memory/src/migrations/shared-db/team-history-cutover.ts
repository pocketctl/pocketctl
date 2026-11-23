// Preserve the historical inputs to Team's relation and accounting audit at
// cutover. These private rows contain original links, proof and digests. New
// Team publications use native records and never populate this inventory.
export const TEAM_PROJECTION_HISTORY=[
 `CREATE TABLE IF NOT EXISTS shared.memory_team_history_inputs(
   installation_id UUID NOT NULL REFERENCES memory.memory_installations ON DELETE CASCADE,
   session_id TEXT,kind TEXT NOT NULL CHECK(kind IN('source','turn')),id TEXT NOT NULL,
   state TEXT,metadata JSONB NOT NULL,links TEXT[] NOT NULL,proof JSONB,native_ref JSONB,
   PRIMARY KEY(installation_id,kind,id))`,
 `CREATE INDEX IF NOT EXISTS memory_team_history_session ON shared.memory_team_history_inputs(installation_id,session_id)`,
 `CREATE TABLE IF NOT EXISTS shared.memory_team_history_bundle_links(
   installation_id UUID NOT NULL,bundle_id UUID NOT NULL,source_event_id UUID NOT NULL,
   source_digest BYTEA NOT NULL CHECK(octet_length(source_digest)=32),source_sequence BIGINT NOT NULL,
   PRIMARY KEY(installation_id,bundle_id,source_event_id),
   FOREIGN KEY(installation_id,bundle_id) REFERENCES memory.memory_task_bundles(installation_id,bundle_id) ON DELETE CASCADE)`,
 `DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='shared.memory_source_contract'::regclass AND attname='team_history_version' AND NOT attisdropped) THEN RETURN; END IF;
  LOCK TABLE memory.source_events,memory.source_turns,memory.memory_task_bundle_sources IN SHARE MODE;
  INSERT INTO shared.memory_team_history_inputs
   SELECT e.installation_id,e.session_id,'source',e.source_event_id::text,e.mapping_state,
    jsonb_build_object('source_event_id',e.source_event_id,'turn_id',e.turn_id,'session_id',e.session_id,
     'origin',e.origin,'adapter_version',e.adapter_version,'canonical_projected_at',e.canonical_projected_at,
     'payloadDigest',encode(e.payload_hash,'hex'),'contentDigest',encode(e.content_hash,'hex')),
    ARRAY[]::text[],CASE WHEN e.source_provenance->>'source_kind'='team_semantic' THEN e.source_provenance->'native'
     ELSE COALESCE(e.source_provenance->'team',e.source_provenance) END,
    CASE WHEN e.source_kind IN('team_collaboration','team_delivery') AND e.mapping_state='verified' THEN
     jsonb_build_object('kind',e.source_kind,'key',e.canonical_key,'session',e.canonical_session_key,
      'position',e.origin_position,'eventType',e.event_type,'occurredAt',e.occurred_at,'classification',e.classification,
      'provenance',e.source_provenance,'version',e.source_version,'reclaimedAt',e.body_reclaimed_at) END
   FROM memory.source_events e WHERE e.source_kind IS DISTINCT FROM 'team_semantic'
    AND (e.source_kind IN('team_collaboration','team_delivery') OR e.origin='team'
      OR e.source_provenance->>'source_kind'='team_session' OR e.source_provenance->'team'->>'source_kind'='team_session')
    AND NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones t WHERE (t.installation_id,t.session_id)=(e.installation_id,e.session_id));
  -- Only turns proved exclusively personal can be omitted from the audit.
  -- Keep every ambiguous turn, including an orphan with no original events.
  INSERT INTO shared.memory_team_history_inputs
   SELECT t.installation_id,t.session_id,'turn',t.turn_id,t.state,
    jsonb_build_object('turn_id',t.turn_id,'session_id',t.session_id,'first_source_event_id',t.first_source_event_id,
     'last_source_event_id',t.last_source_event_id,'event_count',t.event_count),
    ARRAY['source:'||t.first_source_event_id::text,'source:'||t.last_source_event_id::text],NULL,NULL
   FROM memory.source_turns t WHERE t.turn_id NOT LIKE 'team-semantic:%'
    AND NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones d WHERE (d.installation_id,d.session_id)=(t.installation_id,t.session_id))
    AND NOT EXISTS(SELECT 1 FROM memory.source_events e WHERE e.installation_id=t.installation_id AND e.turn_id=t.turn_id
     HAVING count(*)=t.event_count AND count(*)>0
       AND bool_or(e.source_event_id=t.first_source_event_id) AND bool_or(e.source_event_id=t.last_source_event_id)
       AND bool_and(COALESCE(e.session_id=t.session_id AND e.canonical_session_key=t.session_id
        AND e.mapping_state='verified' AND e.source_kind IN('relay_event','legacy_archive') AND e.origin<>'team'
        AND e.source_provenance->>'source_kind' IS DISTINCT FROM 'team_session' AND NOT(e.source_provenance ? 'team'),FALSE)));
  INSERT INTO shared.memory_team_history_bundle_links
   SELECT m.installation_id,m.bundle_id,m.source_event_id,m.source_digest,m.source_sequence FROM memory.memory_task_bundle_sources m
   JOIN memory.memory_task_bundles b USING(installation_id,bundle_id)
   WHERE NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones t WHERE (t.installation_id,t.session_id)=(b.installation_id,b.session_id));
  ALTER TABLE shared.memory_source_contract ADD COLUMN team_history_version INT NOT NULL DEFAULT 1 CHECK(team_history_version=1);
 END $$`,
 `CREATE OR REPLACE FUNCTION shared.purge_memory_team_history() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,shared AS $$ BEGIN
  IF TG_TABLE_NAME='memory_session_tombstones' THEN
   DELETE FROM shared.memory_team_history_inputs WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id;
   DELETE FROM shared.memory_team_history_bundle_links l USING memory.memory_task_bundles b
    WHERE (b.installation_id,b.bundle_id)=(l.installation_id,l.bundle_id) AND b.installation_id=NEW.installation_id AND b.session_id=NEW.session_id;
  ELSE
   DELETE FROM shared.memory_team_history_inputs WHERE installation_id=NEW.installation_id;
   DELETE FROM shared.memory_team_history_bundle_links WHERE installation_id=NEW.installation_id;
  END IF;RETURN NULL;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.purge_memory_team_history() FROM PUBLIC`,
 `DROP TRIGGER IF EXISTS purge_memory_team_history ON memory.memory_session_tombstones;
 CREATE TRIGGER purge_memory_team_history AFTER INSERT ON memory.memory_session_tombstones FOR EACH ROW EXECUTE FUNCTION shared.purge_memory_team_history();
 DROP TRIGGER IF EXISTS purge_installation_team_history ON memory.memory_installations;
 CREATE TRIGGER purge_installation_team_history AFTER UPDATE OF local_status ON memory.memory_installations FOR EACH ROW
 WHEN(NEW.local_status='purged') EXECUTE FUNCTION shared.purge_memory_team_history()`,
] as const
