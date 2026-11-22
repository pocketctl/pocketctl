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
   IF i.owner_scope_kind='personal' THEN
    scope=jsonb_build_object('installationId',p_installation::text,'principalUserId',i.owner_user_id::text,
     'ownerScopeKind','personal','ownerScopeId',i.owner_scope_id::text,'authorizationRevision',i.authorization_epoch::text,
     'configVersion',i.config_version::text,'modeGeneration',m.generation::text);
    RETURN QUERY SELECT a.source_event_id,jsonb_build_object('scope',scope,'root',jsonb_build_object('kind','legacy_archive','key',i.owner_user_id::text||':'||a.session_id))
     FROM shared.memory_archive_records a WHERE a.installation_id=p_installation AND a.owner_user_id=i.owner_user_id AND a.source_event_id=ANY(p_refs);
    SELECT array_agg(id) INTO p_refs FROM unnest(p_refs) id WHERE NOT EXISTS(SELECT 1 FROM shared.memory_archive_records a
      WHERE a.installation_id=p_installation AND a.owner_user_id=i.owner_user_id AND a.source_event_id=id);
    IF p_refs IS NULL THEN RETURN; END IF;
   END IF;
   FOR r IN SELECT h.id::uuid AS source_event_id,h.native_ref->>'kind' AS source_kind,
     h.native_ref->>'session' AS canonical_session_key,h.proof FROM shared.memory_team_history_inputs h
     WHERE h.installation_id=p_installation AND h.kind='source' AND h.state='verified' AND h.native_ref IS NOT NULL
      AND h.id=ANY(ARRAY(SELECT id::text FROM unnest(p_refs) id)) ORDER BY h.id LOOP
    p=r.proof;principal=p->'read_scope'->>'participant_user_id';
    IF principal IS NULL OR principal !~ '^[1-9][0-9]{0,9}$' THEN CONTINUE;END IF;
    root=CASE WHEN r.source_kind='team_collaboration' THEN p->>'team_call_id' ELSE r.canonical_session_key END;
    IF root IS NULL OR root='' THEN CONTINUE;END IF;
    scope=jsonb_build_object('installationId',p_installation::text,'principalUserId',principal,'ownerScopeKind',i.owner_scope_kind,
      'ownerScopeId',i.owner_scope_id::text,'authorizationRevision',i.authorization_epoch::text,'configVersion',i.config_version::text,'modeGeneration',m.generation::text);
    scope=scope||jsonb_build_object('bindingRevision',p->'read_scope'->>'team_memory_binding_revision','participantRevision',p->'read_scope'->>'participant_revision');
    RETURN QUERY SELECT r.source_event_id,jsonb_build_object('scope',scope,'root',jsonb_build_object('kind',r.source_kind,'key',root));
   END LOOP;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_ref_context(UUID,UUID[]) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.memory_team_reference_headers(p_install UUID,p_ids UUID[])
 RETURNS TABLE(source_event_id UUID,installation_id UUID,session_id TEXT,turn_id TEXT,origin TEXT,origin_position TEXT,
  event_type TEXT,occurred_at TIMESTAMPTZ,payload_hash BYTEA,classification JSONB,source_provenance JSONB,
  body_reclaimed_at TIMESTAMPTZ,row_version TEXT,source_version JSONB,source_kind TEXT,canonical_key TEXT,mapping_state TEXT,content_hash BYTEA)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'source_page_limit';END IF;
  RETURN QUERY SELECT h.id::uuid,h.installation_id,h.session_id,h.metadata->>'turn_id',h.metadata->>'origin',h.native_ref->>'position',
   h.native_ref->>'eventType',(h.native_ref->>'occurredAt')::timestamptz,decode(h.metadata->>'payloadDigest','hex'),
   h.native_ref->'classification',h.native_ref->'provenance',(h.native_ref->>'reclaimedAt')::timestamptz,h.xmin::text,
   h.native_ref->'version',h.native_ref->>'kind',h.native_ref->>'key',h.state,decode(h.metadata->>'contentDigest','hex')
  FROM shared.memory_source_ref_context(p_install,p_ids) b JOIN shared.memory_team_history_inputs h ON h.installation_id=p_install
   AND h.kind='source' AND h.id=b.source_event_id::text AND h.native_ref->>'kind'=b.context#>>'{root,kind}'
  WHERE EXISTS(SELECT 1 FROM shared.memory_team_source_authority(b.context->'scope',b.context#>>'{root,kind}',b.context#>>'{root,key}') v WHERE v.state='current')
   ORDER BY h.id;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_team_reference_headers(UUID,UUID[]) FROM PUBLIC`,
] as const
