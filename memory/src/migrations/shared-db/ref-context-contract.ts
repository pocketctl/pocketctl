/** Stable Memory UUID -> typed authoritative source. Principal identity is
 * derived from persisted verified binding/current installation, never a GUC. */
export const SHARED_SOURCE_REF_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_source_ref_context(p_installation UUID,p_refs UUID[])
  RETURNS TABLE(source_event_id UUID,context JSONB)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE i RECORD;m RECORD;r RECORD;p JSONB;principal TEXT;root TEXT;scope JSONB;BEGIN
   IF p_refs IS NULL OR cardinality(p_refs) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'source_page_limit';END IF;
   SELECT * INTO i FROM public.extension_installations WHERE installation_id=p_installation AND provider_id='pocketctl-memory' AND status='active';
   IF NOT FOUND THEN RETURN;END IF;
   SELECT mode,generation INTO m FROM shared.memory_source_modes WHERE installation_id=p_installation;
   IF NOT FOUND OR m.mode NOT IN('shared-shadow','shared-active') THEN RETURN;END IF;
   FOR r IN SELECT s.source_event_id,s.source_kind,s.canonical_key,s.canonical_session_key,s.source_provenance,s.legacy_owner_user_id,s.legacy_manifest_hash,s.adapter_version,s.origin
     FROM memory.source_events s WHERE s.installation_id=p_installation AND s.source_event_id=ANY(p_refs) AND s.mapping_state='verified'
     ORDER BY s.source_event_id LOOP
    p=CASE WHEN r.source_provenance->'team' IS NOT NULL THEN r.source_provenance->'team' ELSE r.source_provenance END;
    principal=i.owner_user_id::text;
    IF r.source_kind IN('relay_event','legacy_archive') THEN
     IF i.owner_scope_kind<>'personal' THEN CONTINUE;END IF;
     IF r.source_kind='legacy_archive' AND(r.legacy_owner_user_id IS DISTINCT FROM i.owner_user_id OR r.legacy_manifest_hash IS NULL OR r.adapter_version IS DISTINCT FROM 'legacy-archive-v1' OR left(r.canonical_session_key,5)='team_' OR r.origin NOT IN('feed','snapshot') OR r.source_provenance ? 'team' OR r.source_provenance ? 'accepted_delivery') THEN CONTINUE;END IF;
     root=principal||':'||r.canonical_session_key;
    ELSIF r.source_kind IN('team_collaboration','team_delivery') THEN
     principal=p->'read_scope'->>'participant_user_id';
     IF principal IS NULL OR principal !~ '^[1-9][0-9]{0,9}$' THEN CONTINUE;END IF;
     root=CASE WHEN r.source_kind='team_collaboration' THEN p->>'team_call_id' ELSE r.canonical_session_key END;
    ELSE CONTINUE;END IF;
    IF root IS NULL OR root='' THEN CONTINUE;END IF;
    scope=jsonb_build_object('installationId',p_installation::text,'principalUserId',principal,'ownerScopeKind',i.owner_scope_kind,
      'ownerScopeId',i.owner_scope_id::text,'authorizationRevision',i.authorization_epoch::text,'configVersion',i.config_version::text,'modeGeneration',m.generation::text);
    IF r.source_kind IN('team_collaboration','team_delivery') THEN scope=scope||jsonb_build_object('bindingRevision',p->'read_scope'->>'team_memory_binding_revision','participantRevision',p->'read_scope'->>'participant_revision');END IF;
    RETURN QUERY SELECT r.source_event_id,jsonb_build_object('scope',scope,'root',jsonb_build_object('kind',r.source_kind,'key',root));
   END LOOP;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_ref_context(UUID,UUID[]) FROM PUBLIC`,
] as const
