// Keep only per-event denials. A receipt can cover a whole turn, but cannot
// stand in for a previously reclaimed event whose turn was missing or wrong.
export const DIALOGUE_DENIAL_SCHEMA = [
 `CREATE TABLE IF NOT EXISTS shared.memory_reclaimed_relay_events(
   installation_id UUID NOT NULL REFERENCES memory.memory_installations ON DELETE CASCADE,
   canonical_key TEXT NOT NULL, PRIMARY KEY(installation_id,canonical_key))`,
 `CREATE OR REPLACE FUNCTION shared.remember_reclaimed_relay_event() RETURNS TRIGGER
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   INSERT INTO shared.memory_reclaimed_relay_events VALUES(NEW.installation_id,NEW.canonical_key) ON CONFLICT DO NOTHING;
   RETURN NULL;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.remember_reclaimed_relay_event() FROM PUBLIC`,
 `DO $$ BEGIN
   IF to_regclass('memory.source_events') IS NULL OR EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid=to_regclass('memory.source_events') AND tgname='remember_reclaimed_relay_event') THEN RETURN; END IF;
   LOCK TABLE memory.source_events IN SHARE ROW EXCLUSIVE MODE;
   CREATE TRIGGER remember_reclaimed_relay_event AFTER INSERT OR UPDATE ON memory.source_events FOR EACH ROW
    WHEN (NEW.source_kind='relay_event' AND NEW.mapping_state='verified' AND NEW.body_reclaimed_at IS NOT NULL)
    EXECUTE FUNCTION shared.remember_reclaimed_relay_event();
   INSERT INTO shared.memory_reclaimed_relay_events
    SELECT installation_id,canonical_key FROM memory.source_events
    WHERE source_kind='relay_event' AND mapping_state='verified' AND body_reclaimed_at IS NOT NULL ON CONFLICT DO NOTHING;
 END $$`,
] as const

const sessionContext = `ctx=shared.memory_dialogue_context((p_scope->>'installationId')::uuid,substr(p_root,strpos(p_root,':')+1));
 IF ctx IS NULL OR ctx->'scope' IS DISTINCT FROM p_scope OR ctx->>'root' IS DISTINCT FROM p_root THEN
  RAISE EXCEPTION 'source_revoked'; END IF;`
const members = `shared.memory_dialogue_members((p_scope->>'installationId')::uuid,substr(p_root,strpos(p_root,':')+1),p_turn)`

export const DIALOGUE_SOURCE_READERS = [
 `CREATE OR REPLACE FUNCTION shared.read_memory_dialogue_sources(p_scope JSONB,p_root TEXT,p_turn TEXT,p_ids BIGINT[])
 RETURNS SETOF JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE ctx JSONB; BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 256 OR array_position(p_ids,NULL) IS NOT NULL THEN
   RAISE EXCEPTION 'source_page_limit'; END IF;
  ${sessionContext}
  RETURN QUERY WITH members AS MATERIALIZED(SELECT * FROM ${members}),
  page AS (SELECT e.*,sum(COALESCE(octet_length(e.payload::text),0)) OVER(ORDER BY e.id) AS page_bytes
    FROM members m JOIN public.events e ON e.id=m.id::bigint WHERE e.id=ANY(p_ids)
     AND m.kind IN('user_text','agent_text') AND NOT EXISTS(SELECT 1 FROM members WHERE kind='operation'))
  SELECT jsonb_build_object('id',e.id::text,'session_id',e.logical_source_session_id,'current_session_id',e.session_id,
   'event_type',e.event_type,'user_id',e.user_id::text,'occurred_at',e.created_at,
   'payload',CASE WHEN e.page_bytes<=33554432 THEN e.payload END,'body_limit',e.page_bytes>33554432,
   'body_session_id',e.body_session_id,'body_storage',e.body_storage,'manifest_id',e.body_manifest_id,'ordinal',e.body_chunk_ordinal,
   'activity_epoch',e.body_activity_epoch::text,'body_owner_user_id',e.body_owner_user_id::text,
   'canonical_hash',e.canonical_payload_hash,'source_header_version',e.source_header_version,
   'canonical_sequence',e.source_sequence::text,'ref_turn_id',p_turn,'classification',e.source_classification,
   'provenance',jsonb_build_object('memory',e.source_classification->'memory_source'),
   'journal_sequences',(SELECT jsonb_agg(j.source_seq::text) FROM public.extension_source_outbox j
     WHERE j.source_kind='canonical_event' AND j.source_id='event:'||e.id::text AND j.owner_user_id=e.user_id
      AND j.session_id=e.logical_source_session_id AND j.event_type=e.event_type))
   FROM page e ORDER BY e.id;
 END $$`,
 `CREATE OR REPLACE FUNCTION shared.read_memory_dialogue_archive(p_scope JSONB,p_root TEXT,p_turn TEXT,p_manifest UUID,p_ordinal INT)
 RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE ctx JSONB; result JSONB; BEGIN
  ${sessionContext}
  WITH members AS MATERIALIZED(SELECT * FROM ${members})
  SELECT jsonb_build_object('user_id',m.user_id,'session_id',m.session_id,'activity_epoch',m.activity_epoch::text,'manifest_id',m.manifest_id::text,
   'schema_version',m.schema_version,'codec',m.codec,'state',m.state,'storage_namespace',m.storage_namespace,
   'ordinal',c.ordinal,'object_key',c.object_key,'first_event_id',c.first_event_id::text,'last_event_id',c.last_event_id::text,'event_count',c.event_count,
   'raw_bytes',c.raw_bytes::text,'compressed_bytes',c.compressed_bytes::text,'raw_sha256',c.raw_sha256,'compressed_sha256',c.compressed_sha256)
   INTO result FROM public.session_archive_manifests m JOIN public.session_archive_chunks c USING(manifest_id)
   WHERE m.manifest_id=p_manifest AND c.ordinal=p_ordinal AND m.state='published' AND m.user_id=(p_scope->>'principalUserId')::int
    AND NOT EXISTS(SELECT 1 FROM members WHERE kind='operation')
    AND EXISTS(SELECT 1 FROM members k JOIN public.events e ON e.id=k.id::bigint
     WHERE k.kind IN('user_text','agent_text') AND e.body_storage='cold' AND e.body_manifest_id=m.manifest_id AND e.body_chunk_ordinal=c.ordinal
      AND e.body_owner_user_id=m.user_id AND e.body_session_id=m.session_id AND e.body_activity_epoch=m.activity_epoch);
  RETURN result;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.read_memory_dialogue_sources(JSONB,TEXT,TEXT,BIGINT[]),
  shared.read_memory_dialogue_archive(JSONB,TEXT,TEXT,UUID,INT) FROM PUBLIC`,
] as const
