/** Short nonblocking commit barriers. Initial/body preparation remains lock-free;
 * callers must use this at the final positive boundary, inside BEGIN. */
export const SHARED_SOURCE_COMMIT_FENCE_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.lock_memory_personal_source_commit(p_scope JSONB,p_kind TEXT,p_root TEXT,p_expected JSONB,p_retained BOOLEAN)
  RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE a RECORD;owner_id INT;installation UUID;session_key TEXT;native JSONB;fresh_native JSONB;session_ids TEXT[];sid TEXT;BEGIN
   IF p_scope IS NULL OR p_expected IS NULL OR p_retained IS NULL OR p_kind IS NULL OR p_kind NOT IN('relay_event','legacy_archive')
    OR jsonb_typeof(p_scope)<>'object' OR jsonb_typeof(p_expected)<>'object' OR octet_length(p_scope::text)>32768 OR octet_length(p_expected::text)>1024
    OR p_root IS NULL OR length(p_root) NOT BETWEEN 1 AND 1024 THEN RETURN FALSE;END IF;
   BEGIN
    owner_id=(p_scope->>'principalUserId')::int;installation=(p_scope->>'installationId')::uuid;
    session_key=substr(p_root,strpos(p_root,':')+1);
    IF owner_id IS NULL OR owner_id<=0 OR installation IS NULL OR p_scope->>'ownerScopeKind' IS DISTINCT FROM 'personal'
     OR split_part(p_root,':',1) IS DISTINCT FROM owner_id::text OR session_key='' THEN RAISE lock_not_available;END IF;
    -- The established Relay maintenance/owner fence precedes Session/root.
    IF NOT pg_try_advisory_xact_lock_shared(owner_id::bigint) THEN RAISE lock_not_available;END IF;
    IF NOT shared.lock_memory_grant_authority(ARRAY[installation],ARRAY[]::uuid[]) THEN RAISE lock_not_available;END IF;
    PERFORM installation_id FROM shared.memory_source_modes WHERE installation_id=installation
     AND generation::text=p_scope->>'modeGeneration' AND mode IN('shared-shadow','shared-active') FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE lock_not_available;END IF;
    session_ids=ARRAY[session_key];
    IF p_kind='relay_event' THEN
     native=public.native_session_authority(session_key,owner_id,NULL);
     IF native->>'state' IS DISTINCT FROM 'current' THEN RAISE lock_not_available;END IF;
     SELECT array_agg(value ORDER BY value COLLATE "C") INTO session_ids FROM jsonb_array_elements_text(native->'sessionIds');
    END IF;
    -- Complete alias component is private observed authority, fenced to COMMIT.
    PERFORM daemon_id FROM public.daemons WHERE daemon_id IN(SELECT s.daemon_id FROM public.sessions s WHERE s.session_id=ANY(session_ids))
     ORDER BY daemon_id FOR SHARE NOWAIT;
    FOREACH sid IN ARRAY session_ids LOOP
     IF NOT pg_try_advisory_xact_lock_shared(1885566061,hashtext(sid)) THEN RAISE lock_not_available;END IF;
    END LOOP;
    IF p_kind='relay_event' THEN
     fresh_native=public.native_session_authority(session_key,owner_id,NULL);
     IF fresh_native IS DISTINCT FROM native THEN RAISE lock_not_available;END IF;
     PERFORM old_session_id FROM public.session_aliases WHERE old_session_id=ANY(session_ids) ORDER BY old_session_id FOR SHARE NOWAIT;
    END IF;
    PERFORM session_id FROM public.sessions WHERE session_id=ANY(session_ids) ORDER BY session_id FOR SHARE NOWAIT;
    -- Existing Memory purge/retention writers use the exclusive counterpart.
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||installation::text,0)) THEN RAISE lock_not_available;END IF;
    PERFORM root_key FROM shared.memory_source_work WHERE source_kind=p_kind AND root_key IN(SELECT owner_id::text||':'||id FROM unnest(session_ids) id) ORDER BY root_key FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE lock_not_available;END IF;
    IF p_retained THEN SELECT * INTO a FROM shared.memory_retained_relay_authority(p_scope,p_kind,p_root);
    ELSE SELECT * INTO a FROM shared.memory_relay_source_authority(p_scope,p_kind,p_root);END IF;
    IF a.state IS DISTINCT FROM 'current' OR a.content_revision IS DISTINCT FROM p_expected->>'content'
     OR a.authorization_revision IS DISTINCT FROM p_expected->>'authorization'
     OR NOT p_retained AND a.storage_revision IS DISTINCT FROM p_expected->>'storage' THEN RAISE lock_not_available;END IF;
    RETURN TRUE;
   EXCEPTION WHEN lock_not_available OR invalid_text_representation OR numeric_value_out_of_range THEN
    -- Rolling back this subtransaction releases ALL partially acquired fences.
    RETURN FALSE;
   END;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.lock_memory_personal_source_commit(JSONB,TEXT,TEXT,JSONB,BOOLEAN) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.lock_memory_team_source_commit(p_scope JSONB,p_kind TEXT,p_root TEXT,p_expected JSONB,p_retained BOOLEAN)
  RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE a RECORD;fresh RECORD;installation UUID;target UUID;fenced_installation UUID;members UUID[];session_keys TEXT[];BEGIN
   IF p_scope IS NULL OR p_expected IS NULL OR p_retained IS NULL OR p_kind IS NULL OR p_kind NOT IN('team_collaboration','team_delivery')
    OR jsonb_typeof(p_scope)<>'object' OR jsonb_typeof(p_expected)<>'object' OR octet_length(p_scope::text)>32768 OR octet_length(p_expected::text)>1024
    OR p_root IS NULL OR length(p_root) NOT BETWEEN 1 AND 1024 THEN RETURN FALSE;END IF;
   BEGIN
    installation=(p_scope->>'installationId')::uuid;
    SELECT * INTO a FROM shared.memory_team_source_authority(p_scope,p_kind,p_root);
    IF a.state IS DISTINCT FROM 'current' THEN RAISE lock_not_available;END IF;
    target=(a.context->>'targetInstallationId')::uuid;
    SELECT COALESCE(array_agg(m.membership_id ORDER BY m.membership_id),ARRAY[]::uuid[]) INTO members
     FROM public.extension_scope_memberships m JOIN public.extension_installations i ON i.owner_scope_kind=m.scope_kind AND i.owner_scope_id=m.scope_id
     WHERE i.installation_id IN(installation,target) AND m.user_id=(p_scope->>'principalUserId')::int;
    IF NOT pg_try_advisory_xact_lock_shared((p_scope->>'principalUserId')::bigint)
     OR NOT shared.lock_memory_grant_authority(ARRAY(SELECT DISTINCT id FROM unnest(ARRAY[installation,target]) id ORDER BY id),members)
     THEN RAISE lock_not_available;END IF;
    PERFORM id FROM public.users WHERE id=(p_scope->>'principalUserId')::int FOR SHARE NOWAIT;
    PERFORM installation_id FROM shared.memory_source_modes WHERE installation_id=installation
     AND generation::text=p_scope->>'modeGeneration' AND mode IN('shared-shadow','shared-active') FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE lock_not_available;END IF;
    PERFORM team_id FROM public.collaboration_teams WHERE team_id=a.context->>'teamId' FOR SHARE NOWAIT;
    PERFORM team_id FROM public.collaboration_team_memberships WHERE team_id=a.context->>'teamId' AND user_id=(p_scope->>'principalUserId')::int FOR SHARE NOWAIT;
    PERFORM team_session_id FROM public.collaboration_sessions WHERE team_session_id=a.context->>'teamSessionId' FOR SHARE NOWAIT;
    PERFORM team_session_id FROM public.collaboration_session_participants WHERE team_session_id=a.context->>'teamSessionId' AND user_id=(p_scope->>'principalUserId')::int FOR SHARE NOWAIT;
    PERFORM binding_id FROM public.team_memory_bindings WHERE binding_id=a.context->>'bindingId' FOR SHARE NOWAIT;
    PERFORM call_id FROM public.collaboration_calls WHERE call_id=a.context->>'callId' FOR SHARE NOWAIT;
    PERFORM offer_id FROM public.team_agent_offers WHERE offer_id=a.context->>'offerId' FOR SHARE NOWAIT;
    IF p_kind='team_delivery' THEN
     PERFORM source_session_id FROM public.team_delivery_memory_sources WHERE source_session_id=p_root AND reader_user_id=(p_scope->>'principalUserId')::int FOR SHARE NOWAIT;
     PERFORM s.submission_id FROM public.team_task_submissions s JOIN public.team_delivery_memory_sources r USING(submission_id)
      WHERE r.source_session_id=p_root AND r.reader_user_id=(p_scope->>'principalUserId')::int FOR SHARE OF s NOWAIT;
     PERFORM d.decision_id FROM public.team_acceptance_decisions d JOIN public.team_delivery_memory_sources r USING(decision_id)
      WHERE r.source_session_id=p_root AND r.reader_user_id=(p_scope->>'principalUserId')::int FOR SHARE OF d NOWAIT;
     PERFORM spec.task_id FROM public.team_task_specs spec JOIN public.team_task_submissions s ON s.task_id=spec.task_id AND s.spec_revision=spec.revision
      JOIN public.team_delivery_memory_sources r USING(submission_id)
      WHERE r.source_session_id=p_root AND r.reader_user_id=(p_scope->>'principalUserId')::int FOR SHARE OF spec NOWAIT;
     IF NOT shared.lock_memory_delivery_commit((SELECT jsonb_agg(jsonb_build_object('team_id',r.team_id,'team_session_id',r.team_session_id,'submission_id',r.submission_id::text,'decision_id',r.decision_id::text)) FROM public.team_delivery_memory_sources r WHERE r.source_session_id=p_root AND r.reader_user_id=(p_scope->>'principalUserId')::int)) THEN RAISE lock_not_available;END IF;
     session_keys=ARRAY[p_root];
    ELSE
     session_keys=ARRAY[
      'team_'||substr(encode(sha256(convert_to('["team-source-binding-v1",'||to_json(a.context->>'teamSessionId')::text||','||to_json(a.context->>'bindingId')::text||','||(a.context->>'bindingRevision')||','||(a.context->>'participantRevision')||']','UTF8')),'hex'),1,32),
      'team_'||substr(encode(sha256(convert_to((a.context->>'teamSessionId')||':'||(a.context->>'bindingRevision')||':'||(a.context->>'participantRevision'),'UTF8')),'hex'),1,32)];
    END IF;
    FOR fenced_installation IN SELECT DISTINCT id FROM unnest(ARRAY[installation,target]) id ORDER BY id LOOP
     IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||fenced_installation::text,0)) THEN RAISE lock_not_available;END IF;
    END LOOP;
    PERFORM root_key FROM shared.memory_source_work WHERE source_kind=p_kind AND root_key=p_root FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE lock_not_available;END IF;
    SELECT * INTO fresh FROM shared.memory_team_source_authority(p_scope,p_kind,p_root);
    IF fresh.state IS DISTINCT FROM 'current' OR fresh.context IS DISTINCT FROM a.context
     OR fresh.content_revision IS DISTINCT FROM p_expected->>'content' OR fresh.authorization_revision IS DISTINCT FROM p_expected->>'authorization'
     OR NOT p_retained AND fresh.storage_revision IS DISTINCT FROM p_expected->>'storage'
     OR EXISTS(SELECT 1 FROM memory.memory_session_tombstones WHERE installation_id=installation AND session_id=ANY(session_keys))
     OR NOT p_retained AND EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts WHERE installation_id=installation AND session_id=ANY(session_keys) AND turn_id=a.context->>'turnId')
     THEN RAISE lock_not_available;END IF;
    RETURN TRUE;
   EXCEPTION WHEN lock_not_available OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN FALSE;END;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.lock_memory_team_source_commit(JSONB,TEXT,TEXT,JSONB,BOOLEAN) FROM PUBLIC`,
] as const
