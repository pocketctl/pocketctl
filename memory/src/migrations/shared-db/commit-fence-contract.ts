import {metadataInputFingerprint,metadataRowLocator,metadataUsageDenied,metadataInputAdmission} from './personal-metadata-sql.js'
/** Short nonblocking commit barriers. Initial/body preparation remains lock-free;
 * callers must use this at the final positive boundary, inside BEGIN. */
export const SHARED_SOURCE_COMMIT_FENCE_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.lock_memory_personal_source_commit(p_scope JSONB,p_kind TEXT,p_root TEXT,p_expected JSONB,p_retained BOOLEAN)
  RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE a RECORD;owner_id INT;installation UUID;session_key TEXT;native JSONB;fresh_native JSONB;session_ids TEXT[];sid TEXT;selected_mode BOOLEAN;ordinary_projection BOOLEAN;expected JSONB;execution RECORD;distribution RECORD;item RECORD;fresh_row JSONB;input_fingerprint TEXT;selected_ids BIGINT[];projection_keys TEXT[];turn_key TEXT;input_admission TEXT;lock_phase BOOLEAN:=FALSE;stale_scan BOOLEAN:=FALSE;BEGIN
   selected_mode=COALESCE(p_expected->>'contract'='personal-metadata-selection-v1',FALSE);
   ordinary_projection=COALESCE(p_expected->>'contract'='personal-reference-projection-v1',FALSE);
   expected=CASE WHEN selected_mode OR ordinary_projection THEN p_expected->'observedVersion' ELSE p_expected END;
   IF p_scope IS NULL OR p_expected IS NULL OR p_retained IS NULL OR p_kind IS NULL OR p_kind NOT IN('relay_event','legacy_archive')
    OR jsonb_typeof(p_scope)<>'object' OR jsonb_typeof(p_expected)<>'object' OR octet_length(p_scope::text)>32768 OR octet_length(p_expected::text)>(CASE WHEN selected_mode THEN 131072 WHEN ordinary_projection THEN 8192 ELSE 1024 END)
    OR p_root IS NULL OR length(p_root) NOT BETWEEN 1 AND 1024 THEN RETURN FALSE;END IF;
   IF selected_mode THEN
    IF octet_length(p_expected::text)+octet_length(p_scope::text)+octet_length(p_root)>131072 OR p_retained OR p_kind<>'relay_event' OR p_scope->>'ownerScopeKind'<>'personal'
     OR p_expected-ARRAY['contract','purpose','executionId','scanId','targetCursor','observedVersion','inputFingerprint','nativeSessionFingerprint','rows','cold']<>'{}'::jsonb
     OR NOT(p_expected?&ARRAY['contract','purpose','executionId','scanId','targetCursor','observedVersion','inputFingerprint','nativeSessionFingerprint','rows','cold'])
     OR p_expected->>'purpose' NOT IN('reference','episode') OR jsonb_typeof(p_expected->'rows')<>'array'
     OR jsonb_array_length(p_expected->'rows') NOT BETWEEN 1 AND 256 OR jsonb_typeof(p_expected->'cold')<>'array' OR jsonb_array_length(p_expected->'cold')>32
     OR COALESCE(p_expected->>'inputFingerprint','')!~'^[a-f0-9]{64}$' OR COALESCE(p_expected->>'nativeSessionFingerprint','')!~'^[a-f0-9]{64}$'
     OR COALESCE(p_expected->>'targetCursor','')='' OR length(p_expected->>'targetCursor')>2048 THEN RETURN FALSE;END IF;
   ELSIF ordinary_projection THEN
    IF p_retained OR p_kind<>'relay_event' OR p_scope->>'ownerScopeKind' IS DISTINCT FROM 'personal'
     OR p_expected-ARRAY['contract','observedVersion','canonicalIds']<>'{}'::jsonb
     OR NOT(p_expected?&ARRAY['contract','observedVersion','canonicalIds'])
     OR jsonb_typeof(p_expected->'canonicalIds') IS DISTINCT FROM 'array' THEN RETURN FALSE;END IF;
    IF jsonb_array_length(p_expected->'canonicalIds') NOT BETWEEN 1 AND 256 OR EXISTS(
     SELECT 1 FROM jsonb_array_elements(p_expected->'canonicalIds') k(value)
     WHERE jsonb_typeof(k.value)<>'string' OR k.value#>>'{}' !~ '^[1-9][0-9]{0,18}$') THEN RETURN FALSE;END IF;
    projection_keys=ARRAY(SELECT DISTINCT k.value FROM jsonb_array_elements_text(p_expected->'canonicalIds') k(value));
    IF cardinality(projection_keys)<>jsonb_array_length(p_expected->'canonicalIds') THEN RETURN FALSE;END IF;
   ELSIF p_expected-ARRAY['content','authorization','storage']<>'{}'::jsonb THEN RETURN FALSE;
   END IF;
   IF jsonb_typeof(expected)<>'object' OR expected-ARRAY['content','authorization','storage']<>'{}'::jsonb
    OR NOT(expected?&ARRAY['content','authorization','storage']) OR EXISTS(SELECT 1 FROM jsonb_each(expected) x WHERE jsonb_typeof(x.value)<>'string'
     OR x.value#>>'{}' !~ '^(0|[1-9][0-9]{0,18})$') THEN RETURN FALSE;END IF;
   BEGIN
    IF selected_mode THEN
     lock_phase=TRUE;
     SELECT e.*,j.job_type,j.payload,j.idempotency_key INTO execution FROM shared.memory_source_executions e JOIN memory.memory_jobs j ON j.job_id=e.job_id
      WHERE e.execution_id=(p_expected->>'executionId')::uuid AND e.branch='canonical-active' AND e.installation_id=(p_scope->>'installationId')::uuid
       AND e.generation::text=p_scope->>'modeGeneration' AND e.control_revision::text=shared.memory_source_control_snapshot()
       AND j.installation_id=e.installation_id AND j.claim_epoch=e.claim_epoch AND j.claimed_by=e.worker AND j.state='running' AND j.claim_expires_at>clock_timestamp()
       AND((p_expected->>'purpose'='reference' AND j.job_type='project_shared_source') OR(p_expected->>'purpose'='episode' AND j.job_type='compile_episode'))
      FOR SHARE OF e,j NOWAIT;lock_phase=FALSE;
     IF NOT FOUND THEN RAISE lock_not_available;END IF;
     IF p_expected->>'purpose'='reference' AND(execution.payload->'scope' IS DISTINCT FROM p_scope
      OR execution.payload->'root' IS DISTINCT FROM jsonb_build_object('kind',p_kind,'key',p_root)
      OR execution.payload->>'distribution_scan' IS DISTINCT FROM p_expected->>'scanId'
      OR execution.payload->>'target_cursor' IS DISTINCT FROM p_expected->>'targetCursor') THEN RAISE lock_not_available;END IF;
     IF p_expected->>'purpose'='episode' THEN
      IF left(execution.idempotency_key,16)<>'compile_episode:' THEN RAISE lock_not_available;END IF;
      turn_key=substr(execution.idempotency_key,17);
      IF turn_key IS NULL OR length(turn_key) NOT BETWEEN 1 AND 1024 THEN RAISE lock_not_available;END IF;
     END IF;
    END IF;
    owner_id=(p_scope->>'principalUserId')::int;installation=(p_scope->>'installationId')::uuid;
    session_key=substr(p_root,strpos(p_root,':')+1);
    IF owner_id IS NULL OR owner_id<=0 OR installation IS NULL OR p_scope->>'ownerScopeKind' IS DISTINCT FROM 'personal'
     OR split_part(p_root,':',1) IS DISTINCT FROM owner_id::text OR session_key='' THEN RAISE lock_not_available;END IF;
    -- The established Relay maintenance/owner fence precedes Session/root.
    IF NOT pg_try_advisory_xact_lock_shared(owner_id::bigint) THEN IF selected_mode THEN RAISE EXCEPTION 'source_metadata_lock_busy' USING ERRCODE='55P03';ELSE RAISE lock_not_available;END IF;END IF;
    IF selected_mode THEN
     -- Preserve real NOWAIT contention before the ordinary boolean helper
     -- can swallow it. Personal scope has no team/member grant rows.
     lock_phase=TRUE;
     PERFORM i.installation_id FROM public.extension_installations i WHERE i.installation_id=installation AND i.provider_id='pocketctl-memory' FOR SHARE OF i NOWAIT;
     PERFORM u.id FROM public.users u WHERE u.id IN(SELECT i.owner_user_id FROM public.extension_installations i WHERE i.installation_id=installation AND i.owner_scope_kind='personal') FOR SHARE OF u NOWAIT;
     PERFORM p.provider_id FROM public.extension_providers p WHERE p.provider_id='pocketctl-memory' FOR SHARE OF p NOWAIT;
     lock_phase=FALSE;
    END IF;
    IF NOT shared.lock_memory_grant_authority(ARRAY[installation],ARRAY[]::uuid[]) THEN RAISE lock_not_available;END IF;
    lock_phase=TRUE;
    PERFORM installation_id FROM shared.memory_source_modes WHERE installation_id=installation
     AND generation::text=p_scope->>'modeGeneration' AND mode IN('shared-shadow','shared-active') FOR SHARE NOWAIT;lock_phase=FALSE;
    IF NOT FOUND THEN RAISE lock_not_available;END IF;
    session_ids=ARRAY[session_key];
    IF p_kind='relay_event' THEN
     native=public.native_session_authority(session_key,owner_id,NULL);
     IF native->>'state' IS DISTINCT FROM 'current' THEN RAISE lock_not_available;END IF;
     SELECT array_agg(value ORDER BY value COLLATE "C") INTO session_ids FROM jsonb_array_elements_text(native->'sessionIds');
    END IF;
    -- Complete alias component is private observed authority, fenced to COMMIT.
    lock_phase=TRUE;
    PERFORM daemon_id FROM public.daemons WHERE daemon_id IN(SELECT s.daemon_id FROM public.sessions s WHERE s.session_id=ANY(session_ids))
     ORDER BY daemon_id FOR SHARE NOWAIT;lock_phase=FALSE;
    FOREACH sid IN ARRAY session_ids LOOP
     IF NOT pg_try_advisory_xact_lock_shared(1885566061,hashtext(sid)) THEN IF selected_mode THEN RAISE EXCEPTION 'source_metadata_lock_busy' USING ERRCODE='55P03';ELSE RAISE lock_not_available;END IF;END IF;
    END LOOP;
    IF p_kind='relay_event' THEN
     fresh_native=public.native_session_authority(session_key,owner_id,NULL);
     IF fresh_native IS DISTINCT FROM native THEN RAISE lock_not_available;END IF;
     lock_phase=TRUE;
     PERFORM old_session_id FROM public.session_aliases WHERE old_session_id=ANY(session_ids) ORDER BY old_session_id FOR SHARE NOWAIT;lock_phase=FALSE;
    END IF;
    lock_phase=TRUE;
    PERFORM session_id FROM public.sessions WHERE session_id=ANY(session_ids) ORDER BY session_id FOR SHARE NOWAIT;lock_phase=FALSE;
    -- Existing Memory purge/retention writers use the exclusive counterpart.
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||installation::text,0)) THEN IF selected_mode THEN RAISE EXCEPTION 'source_metadata_lock_busy' USING ERRCODE='55P03';ELSE RAISE lock_not_available;END IF;END IF;
    lock_phase=TRUE;
    PERFORM root_key FROM shared.memory_source_work WHERE source_kind=p_kind AND root_key IN(SELECT owner_id::text||':'||id FROM unnest(session_ids) id) ORDER BY root_key FOR SHARE NOWAIT;lock_phase=FALSE;
    IF NOT FOUND THEN RAISE lock_not_available;END IF;
    IF p_retained THEN SELECT * INTO a FROM shared.memory_retained_relay_authority(p_scope,p_kind,p_root);
    ELSE SELECT * INTO a FROM shared.memory_relay_source_authority(p_scope,p_kind,p_root);END IF;
    IF a.state IS DISTINCT FROM 'current' OR NOT selected_mode AND a.content_revision IS DISTINCT FROM expected->>'content'
     OR a.authorization_revision IS DISTINCT FROM expected->>'authorization'
     OR NOT p_retained AND a.storage_revision IS DISTINCT FROM expected->>'storage' THEN RAISE lock_not_available;END IF;
    IF selected_mode THEN
     lock_phase=TRUE;
     SELECT d.* INTO distribution FROM shared.memory_source_distributions d WHERE d.source_kind=p_kind AND d.root_key=p_root FOR SHARE NOWAIT;lock_phase=FALSE;
     IF NOT FOUND OR distribution.control_revision<>execution.control_revision
      OR NOT shared.guard_memory_control_commit(execution.control_revision) THEN RAISE lock_not_available;END IF;
     IF distribution.scan_id IS DISTINCT FROM (p_expected->>'scanId')::uuid THEN
      -- A real completed original projection binds this historical target to
      -- the same root. This only identifies a possible version-replacement
      -- denial; every remaining original selected fact must still validate.
      IF p_expected->>'purpose'<>'episode' OR distribution.state NOT IN('scanning','sealed') THEN RAISE lock_not_available;END IF;
      lock_phase=TRUE;
      PERFORM 1 FROM shared.memory_source_distribution_targets t JOIN memory.memory_jobs j
       ON j.installation_id=t.installation_id AND j.job_type='project_shared_source'
        AND j.idempotency_key='shared-source:'||t.scan_id::text||':'||encode(sha256(convert_to(t.cursor_key,'UTF8')),'hex')
       WHERE t.scan_id=(p_expected->>'scanId')::uuid AND t.cursor_key=p_expected->>'targetCursor'
        AND t.installation_id=installation AND t.source_scope=p_scope AND t.state='current' AND t.target_mode='shared-active'
        AND t.source_version->>'authorization'=expected->>'authorization'
        AND j.state='completed' AND j.completed_at IS NOT NULL AND j.payload->'scope'=p_scope
        AND j.payload->'root'=jsonb_build_object('kind',p_kind,'key',p_root)
        AND j.payload->>'distribution_scan'=t.scan_id::text AND j.payload->>'target_cursor'=t.cursor_key
       FOR SHARE OF t,j NOWAIT;lock_phase=FALSE;
      IF NOT FOUND THEN RAISE lock_not_available;END IF;
      stale_scan=TRUE;
     ELSIF distribution.state<>'sealed' OR NOT EXISTS(SELECT 1 FROM shared.memory_source_distribution_targets t WHERE t.scan_id=distribution.scan_id
      AND t.cursor_key=p_expected->>'targetCursor' AND t.installation_id=installation AND t.source_scope=p_scope AND t.state='current' AND t.target_mode='shared-active') THEN RAISE lock_not_available;END IF;
     IF encode(sha256(convert_to(native::text,'UTF8')),'hex') IS DISTINCT FROM p_expected->>'nativeSessionFingerprint' THEN RAISE lock_not_available;END IF;
     selected_ids=ARRAY[]::bigint[];
     FOR item IN SELECT value FROM jsonb_array_elements(p_expected->'rows') LOOP
      IF jsonb_typeof(item.value)<>'object' OR item.value-ARRAY['id','rowVersion','bodyChangeRevision','contentHash','nativeFingerprint','ref']<>'{}'::jsonb
       OR NOT(item.value?&ARRAY['id','rowVersion','bodyChangeRevision','contentHash','nativeFingerprint','ref'])
       OR EXISTS(SELECT 1 FROM jsonb_each(item.value) f WHERE f.key<>'ref' AND jsonb_typeof(f.value)<>'string')
       OR COALESCE(item.value->>'id','')!~'^[1-9][0-9]{0,18}$' OR COALESCE(item.value->>'rowVersion','')!~'^[0-9]{1,10}$'
       OR COALESCE(item.value->>'bodyChangeRevision','')!~'^(0|[1-9][0-9]{0,18})$'
       OR COALESCE(item.value->>'contentHash','')!~'^[a-f0-9]{64}$' OR COALESCE(item.value->>'nativeFingerprint','')!~'^[a-f0-9]{64}$'
       OR cardinality(selected_ids)>0 AND(item.value->>'id')::bigint<=selected_ids[cardinality(selected_ids)] THEN RAISE lock_not_available;END IF;
      IF item.value->'ref'<>'null'::jsonb AND(jsonb_typeof(item.value->'ref')<>'object'
       OR (item.value->'ref')-ARRAY['id','rowVersion','fingerprint']<>'{}'::jsonb
       OR NOT((item.value->'ref')?&ARRAY['id','rowVersion','fingerprint'])
       OR EXISTS(SELECT 1 FROM jsonb_each(item.value->'ref') f WHERE jsonb_typeof(f.value)<>'string')) THEN RAISE lock_not_available;END IF;
      selected_ids=array_append(selected_ids,(item.value->>'id')::bigint);
     END LOOP;
     lock_phase=TRUE;
     PERFORM e.id FROM public.events e WHERE e.id=ANY(selected_ids) ORDER BY e.id FOR SHARE NOWAIT;lock_phase=FALSE;
     IF (SELECT count(*) FROM public.events WHERE id=ANY(selected_ids))<>cardinality(selected_ids) THEN RAISE lock_not_available;END IF;
     lock_phase=TRUE;
     PERFORM b.installation_id FROM public.native_installation_starts b WHERE b.installation_id=installation FOR SHARE NOWAIT;lock_phase=FALSE;
     lock_phase=TRUE;
     PERFORM p.source_key FROM public.native_source_publications p WHERE p.source_kind='relay_event' AND p.source_key=ANY(SELECT id::text FROM unnest(selected_ids) id) ORDER BY p.source_key FOR SHARE NOWAIT;lock_phase=FALSE;
     lock_phase=TRUE;
     PERFORM j.source_seq FROM public.extension_source_outbox j WHERE j.source_kind='canonical_event' AND j.source_id=ANY(SELECT 'event:'||id::text FROM unnest(selected_ids) id) ORDER BY j.source_seq FOR SHARE NOWAIT;lock_phase=FALSE;
     IF p_expected->>'purpose'='reference' AND NOT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||installation::text,0)) THEN IF selected_mode THEN RAISE EXCEPTION 'source_metadata_lock_busy' USING ERRCODE='55P03';ELSE RAISE lock_not_available;END IF;END IF;
     lock_phase=TRUE;
     PERFORM r.source_event_id FROM memory.source_events r WHERE r.installation_id=installation AND r.source_kind='relay_event' AND r.canonical_key=ANY(SELECT id::text FROM unnest(selected_ids) id) ORDER BY r.source_event_id FOR SHARE NOWAIT;lock_phase=FALSE;
     input_fingerprint=${metadataInputFingerprint()};
     IF input_fingerprint IS DISTINCT FROM p_expected->>'inputFingerprint' THEN RAISE lock_not_available;END IF;
     FOR item IN SELECT value FROM jsonb_array_elements(p_expected->'rows') LOOP
      -- Reuse the native authority for the row fingerprint and the current-state check.
      SELECT ${metadataRowLocator('e','r','e.xmin::text','native','input_fingerprint','event_authority.value')},${metadataInputAdmission()}
       INTO fresh_row,input_admission FROM public.events e LEFT JOIN memory.source_events r
       ON r.installation_id=installation AND r.source_kind='relay_event' AND r.canonical_key=e.id::text AND r.mapping_state='verified'
       CROSS JOIN LATERAL(SELECT public.native_event_authority(e.id,owner_id) AS value OFFSET 0) event_authority
       WHERE e.id=(item.value->>'id')::bigint AND e.user_id=owner_id AND NOT e.owner_retired AND e.session_id=native->>'sessionId'
        AND e.effect_status IN('none','completed') AND event_authority.value->>'state'='current'
        AND NOT(${metadataUsageDenied()});
      IF input_admission='unsupported' THEN RAISE EXCEPTION 'source_metadata_proof_unavailable';END IF;
      IF input_admission='unproven' THEN RAISE EXCEPTION 'source_input_start_unproven';END IF;
      IF NOT FOUND OR input_admission IS DISTINCT FROM 'eligible' OR fresh_row IS DISTINCT FROM item.value THEN RAISE lock_not_available;END IF;
      IF p_expected->>'purpose'='episode' AND NOT EXISTS(SELECT 1 FROM memory.source_events r JOIN memory.source_turns t
       ON t.installation_id=r.installation_id AND t.turn_id=turn_key WHERE r.installation_id=installation AND r.source_kind='relay_event'
       AND r.canonical_key=item.value->>'id' AND r.mapping_state='verified' AND(r.turn_id=turn_key OR(r.turn_id IS NULL
        AND r.session_id=t.session_id AND r.event_type IN('session_created','session_discovered') AND r.occurred_at<=t.terminal_at))) THEN RAISE lock_not_available;END IF;
     END LOOP;
     FOR item IN SELECT value FROM jsonb_array_elements(p_expected->'cold') ORDER BY value->>'manifestId',(value->>'ordinal')::integer LOOP
      IF jsonb_typeof(item.value)<>'object' OR item.value-ARRAY['manifestId','ordinal','fingerprint']<>'{}'::jsonb
       OR NOT(item.value?&ARRAY['manifestId','ordinal','fingerprint']) OR jsonb_typeof(item.value->'manifestId')<>'string'
       OR jsonb_typeof(item.value->'ordinal')<>'number' OR COALESCE(item.value->>'ordinal','')!~'^[0-9]{1,10}$'
       OR COALESCE(item.value->>'fingerprint','')!~'^[a-f0-9]{64}$' THEN RAISE lock_not_available;END IF;
      IF NOT EXISTS(SELECT 1 FROM public.events e WHERE e.id=ANY(selected_ids) AND e.body_storage='cold' AND e.body_manifest_id=(item.value->>'manifestId')::uuid AND e.body_chunk_ordinal=(item.value->>'ordinal')::int) THEN RAISE lock_not_available;END IF;
      lock_phase=TRUE;
      PERFORM m.manifest_id FROM public.session_archive_manifests m WHERE m.manifest_id=(item.value->>'manifestId')::uuid FOR SHARE NOWAIT;lock_phase=FALSE;
      lock_phase=TRUE;
      PERFORM c.manifest_id FROM public.session_archive_chunks c WHERE c.manifest_id=(item.value->>'manifestId')::uuid AND c.ordinal=(item.value->>'ordinal')::int FOR SHARE NOWAIT;lock_phase=FALSE;
      IF encode(sha256(convert_to(shared.read_memory_relay_archive(p_scope,p_root,(item.value->>'manifestId')::uuid,(item.value->>'ordinal')::int)::text,'UTF8')),'hex') IS DISTINCT FROM item.value->>'fingerprint' THEN RAISE lock_not_available;END IF;
     END LOOP;
     IF EXISTS(SELECT 1 FROM public.events e WHERE e.id=ANY(selected_ids) AND e.body_storage='cold' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_expected->'cold') c WHERE c->>'manifestId'=e.body_manifest_id::text AND(c->>'ordinal')::int=e.body_chunk_ordinal)) THEN RAISE lock_not_available;END IF;
    END IF;
    -- Never admit an old selected proof after rollover, even when all its
    -- native/ref facts remain exact. Fresh job preparation must run all later
    -- positive turn/FK/commit guards again; this transaction is rolled back.
    IF stale_scan THEN RAISE EXCEPTION 'source_metadata_scan_changed' USING ERRCODE='P0001';END IF;
    IF selected_mode AND p_expected->>'purpose'='reference' THEN
     projection_keys=ARRAY(SELECT id::text FROM unnest(selected_ids) id);
    END IF;
    IF cardinality(projection_keys)>0 THEN
     IF ordinary_projection AND NOT pg_try_advisory_xact_lock(hashtextextended('canonical-projection:'||installation::text,0)) THEN RAISE lock_not_available;END IF;
     -- The native Session and its entire alias component are already locked.
     -- An unresolved original permits reuse only, even on a different alias page.
     IF EXISTS(SELECT 1 FROM memory.source_events WHERE installation_id=installation AND session_id=ANY(session_ids) AND mapping_state IN('unproven','conflict'))
      OR EXISTS(SELECT 1 FROM memory.source_events WHERE installation_id=installation AND canonical_session_key=ANY(session_ids) AND mapping_state IN('unproven','conflict')) THEN
      IF ordinary_projection THEN
       PERFORM s.source_event_id FROM memory.source_events s
        WHERE s.installation_id=installation AND s.source_kind='relay_event' AND s.canonical_key=ANY(projection_keys)
        ORDER BY s.source_event_id FOR SHARE NOWAIT;
      END IF;
      IF EXISTS(SELECT 1 FROM unnest(projection_keys) k(value) WHERE NOT EXISTS(
        SELECT 1 FROM memory.source_events s WHERE s.installation_id=installation AND s.source_kind='relay_event' AND s.canonical_key=k.value
         AND s.session_id=s.canonical_session_key AND s.session_id=ANY(session_ids) AND s.mapping_state='verified' AND s.body_reclaimed_at IS NULL
         AND s.origin IN('feed','snapshot') AND s.adapter_version='original-ref-v1')) THEN
       RAISE EXCEPTION 'canonical_reference_mapping_required' USING ERRCODE='P0001';
      END IF;
     END IF;
    END IF;
    RETURN TRUE;
   EXCEPTION WHEN lock_not_available THEN
    -- Only real lock acquisition contention is retryable. Predicate denials
    -- deliberately retain their prior FALSE result, including selected calls.
    IF selected_mode AND(lock_phase OR SQLERRM='source_metadata_lock_busy') THEN
     RAISE EXCEPTION 'source_metadata_lock_busy' USING ERRCODE='55P03';
    END IF;
    RETURN FALSE;
   WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN FALSE;
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
