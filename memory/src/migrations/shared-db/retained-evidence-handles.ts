// Historical artifacts carry an identity used to reclassify a verified native
// body. Store that identity only for sources whose custody survives cutover.
export const NATIVE_EVIDENCE_HANDLES=[
 `CREATE TABLE IF NOT EXISTS shared.memory_retained_artifact_refs(
   installation_id UUID NOT NULL REFERENCES memory.memory_installations ON DELETE CASCADE,
   artifact_id UUID NOT NULL,source_event_id UUID NOT NULL,session_id TEXT NOT NULL,turn_id TEXT,
   artifact_type TEXT NOT NULL,identity_key TEXT NOT NULL,path TEXT,status TEXT,occurred_at TIMESTAMPTZ NOT NULL,
   body_reclaimed_at TIMESTAMPTZ,PRIMARY KEY(installation_id,artifact_id))`,
 `CREATE INDEX IF NOT EXISTS memory_retained_artifact_session ON shared.memory_retained_artifact_refs(installation_id,session_id)`,
 `DO $$ BEGIN
   IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='shared.memory_source_contract'::regclass AND attname='artifact_custody_version' AND NOT attisdropped) THEN RETURN;END IF;
   LOCK TABLE memory.source_artifacts IN SHARE MODE;
   INSERT INTO shared.memory_retained_artifact_refs
    SELECT a.installation_id,a.artifact_id,a.source_event_id,a.session_id,a.turn_id,a.artifact_type,a.identity_key,a.path,a.status,a.occurred_at,a.body_reclaimed_at
    FROM memory.source_artifacts a WHERE NOT EXISTS(SELECT 1 FROM memory.memory_session_tombstones t
     WHERE (t.installation_id,t.session_id)=(a.installation_id,a.session_id))
    AND (EXISTS(SELECT 1 FROM shared.memory_archive_records r WHERE (r.installation_id,r.source_event_id)=(a.installation_id,a.source_event_id))
     OR EXISTS(SELECT 1 FROM shared.memory_team_history_inputs h WHERE h.installation_id=a.installation_id AND h.id=a.source_event_id::text AND h.kind='source' AND h.native_ref IS NOT NULL)
     OR EXISTS(SELECT 1 FROM memory.memory_team_semantic_groups g WHERE g.installation_id=a.installation_id AND g.semantic_ref_id=a.source_event_id AND g.registration_state='published'));
   ALTER TABLE shared.memory_source_contract ADD COLUMN artifact_custody_version INT NOT NULL DEFAULT 1 CHECK(artifact_custody_version=1);
 END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_native_evidence_handle(i UUID,event_id UUID,artifact UUID)
 RETURNS TABLE(source_event_id UUID,artifact_id UUID,session_id TEXT,turn_id TEXT,origin TEXT,source_kind TEXT,
  body_reclaimed_at TIMESTAMPTZ,retention_denied BOOLEAN,artifact_type TEXT,identity_key TEXT,path TEXT,status TEXT,occurred_at TIMESTAMPTZ,payload_hash BYTEA,source_provenance JSONB)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,memory,shared AS $$
 DECLARE a shared.memory_retained_artifact_refs;key UUID;BEGIN
  IF artifact IS NOT NULL THEN
   SELECT * INTO a FROM shared.memory_retained_artifact_refs r WHERE r.installation_id=i AND r.artifact_id=artifact;
   IF NOT FOUND THEN RETURN;END IF;
  END IF;
  key=COALESCE(a.source_event_id,event_id);IF key IS NULL THEN RETURN;END IF;
  RETURN QUERY WITH heads AS (
   SELECT r.session_id,r.turn_id,r.origin,r.source_kind,r.body_reclaimed_at,r.occurred_at,r.payload_hash,r.source_provenance FROM shared.memory_archive_reference_headers(i,ARRAY[key]) r
   UNION ALL SELECT h.session_id,h.turn_id,h.origin,h.source_kind,h.body_reclaimed_at,h.occurred_at,h.payload_hash,h.source_provenance FROM shared.memory_team_reference_headers(i,ARRAY[key]) h
   UNION ALL SELECT g.semantic_session_id,g.semantic_turn_id,'canonical','team_semantic',NULL::timestamptz,g.occurred_at,
    g.semantic_payload_hash,g.semantic_provenance FROM memory.memory_team_semantic_groups g
    JOIN memory.memory_team_semantic_publications p USING(installation_id,semantic_turn_id)
    WHERE g.installation_id=i AND g.semantic_ref_id=key AND g.semantic_ref_id IN(p.goal_ref_id,p.reply_ref_id,p.outcome_ref_id)
     AND g.registration_state='published' AND p.disposition IN('published','legacy_related')
     AND memory.memory_session_available(i,g.semantic_session_id,FALSE))
  SELECT key,a.artifact_id,COALESCE(a.session_id,h.session_id),COALESCE(a.turn_id,h.turn_id),h.origin,h.source_kind,
   COALESCE(a.body_reclaimed_at,h.body_reclaimed_at),EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts t WHERE t.installation_id=i
    AND ((t.session_id=h.session_id AND(h.turn_id IS NULL OR t.turn_id=h.turn_id)) OR (t.session_id=a.session_id AND(a.turn_id IS NULL OR t.turn_id=a.turn_id)))),
   a.artifact_type,a.identity_key,a.path,a.status,COALESCE(a.occurred_at,h.occurred_at),h.payload_hash,h.source_provenance FROM heads h;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_native_evidence_handle(UUID,UUID,UUID) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.memory_retained_bundle_member(i UUID,b UUID,e UUID)
 RETURNS TABLE(session_id TEXT,payload_hash BYTEA) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  SELECT h.session_id,h.payload_hash FROM shared.memory_team_history_bundle_links m
   CROSS JOIN LATERAL shared.memory_native_evidence_handle(m.installation_id,m.source_event_id,NULL) h
   WHERE m.installation_id=i AND m.bundle_id=b AND m.source_event_id=e AND m.source_digest=h.payload_hash
    AND h.body_reclaimed_at IS NULL AND NOT h.retention_denied
 $$`,
 `REVOKE ALL ON FUNCTION shared.memory_retained_bundle_member(UUID,UUID,UUID) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.memory_personal_delivery_source(i UUID,submission TEXT,decision TEXT)
 RETURNS TABLE(source_provenance JSONB) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared,memory AS $$
  WITH identity AS (SELECT jsonb_build_object('source_kind','team_session','source_version',2,'accepted_delivery',
   jsonb_build_object('submission_id',submission,'decision_id',decision)) AS value),
  owned AS (SELECT 1 FROM public.extension_installations p JOIN memory.memory_owner_scopes s USING(installation_id)
   WHERE p.installation_id=i AND p.status='active' AND p.provider_id='pocketctl-memory'
    AND p.owner_scope_kind='personal' AND s.owner_scope_kind='personal' AND s.state='active')
  SELECT proof FROM (
   SELECT g.semantic_provenance->'team' AS proof FROM memory.memory_team_semantic_groups g
   JOIN memory.memory_team_semantic_publications p USING(installation_id,semantic_turn_id)
   WHERE g.installation_id=i AND g.source_kind='team_delivery' AND g.registration_state='published'
    AND p.disposition IN('published','legacy_related')
   UNION ALL SELECT h.proof FROM shared.memory_team_history_inputs h WHERE h.installation_id=i AND h.kind='source'
  ) records,identity WHERE EXISTS(SELECT 1 FROM owned) AND proof @> identity.value LIMIT 1
 $$`,
 `REVOKE ALL ON FUNCTION shared.memory_personal_delivery_source(UUID,TEXT,TEXT) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.memory_session_reference_ids(i UUID,s TEXT)
 RETURNS TABLE(source_event_id UUID) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared,memory AS $$
  SELECT id FROM (
   SELECT a.source_event_id AS id,a.occurred_at FROM shared.memory_archive_records a WHERE a.installation_id=i AND a.session_id=s
   UNION ALL SELECT g.semantic_ref_id,g.occurred_at FROM memory.memory_team_semantic_groups g
    WHERE g.installation_id=i AND g.semantic_session_id=s AND g.registration_state='published'
   UNION ALL SELECT h.id::uuid,(h.native_ref->>'occurredAt')::timestamptz FROM shared.memory_team_history_inputs h
    WHERE h.installation_id=i AND h.session_id=s AND h.kind='source' AND h.native_ref IS NOT NULL
  ) refs WHERE memory.memory_session_available(i,s,FALSE) ORDER BY occurred_at DESC,id DESC LIMIT 4097
 $$`,
 `REVOKE ALL ON FUNCTION shared.memory_session_reference_ids(UUID,TEXT) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.purge_memory_retained_artifact_refs() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,shared AS $$ BEGIN
  IF TG_TABLE_NAME='memory_session_tombstones' THEN DELETE FROM shared.memory_retained_artifact_refs WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id;
  ELSE DELETE FROM shared.memory_retained_artifact_refs WHERE installation_id=NEW.installation_id;END IF;
  RETURN NULL;
 END $$`,
 `DROP TRIGGER IF EXISTS purge_memory_retained_artifact_refs ON memory.memory_session_tombstones;
 CREATE TRIGGER purge_memory_retained_artifact_refs AFTER INSERT ON memory.memory_session_tombstones FOR EACH ROW EXECUTE FUNCTION shared.purge_memory_retained_artifact_refs();
 DROP TRIGGER IF EXISTS purge_installation_retained_artifact_refs ON memory.memory_installations;
 CREATE TRIGGER purge_installation_retained_artifact_refs AFTER UPDATE OF local_status ON memory.memory_installations FOR EACH ROW
 WHEN(NEW.local_status='purged') EXECUTE FUNCTION shared.purge_memory_retained_artifact_refs();
 REVOKE ALL ON FUNCTION shared.purge_memory_retained_artifact_refs() FROM PUBLIC`,
] as const
