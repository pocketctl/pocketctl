import type pg from 'pg'
import {assertTargetMemoryWritersFenced} from '../shared-forward/source-maintenance-capabilities.js'
/** Explicit semantic metadata boundary. Native body and raw-reference readers
 * retain their existing kinds and independent authorization contracts. */
export const SHARED_TEAM_SEMANTIC_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_team_semantic_input_admission(p_installation uuid,p_group jsonb)
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE i record;b record;p record;BEGIN
  IF p_group IS NULL OR jsonb_typeof(p_group)<>'object' OR octet_length(p_group::text)>2097152 THEN RETURN 'unproven';END IF;
  SELECT * INTO i FROM public.extension_installations WHERE installation_id=p_installation AND provider_id='pocketctl-memory' AND status='active';
  IF NOT FOUND THEN RETURN 'denied';END IF;
  SELECT * INTO p FROM public.read_native_team_semantic_publication(p_group->>'kind',p_group->>'nativeKey');
  IF NOT FOUND OR p.publication_xid IS NULL OR p.publication_order IS NULL THEN RETURN 'unproven';END IF;
  IF p.retired IS DISTINCT FROM FALSE OR to_jsonb(p) IS DISTINCT FROM p_group->'publication' THEN RETURN 'denied';END IF;
  IF p.binding_id IS DISTINCT FROM p_group->>'bindingId' OR p.binding_revision IS DISTINCT FROM p_group->>'bindingRevision'
   OR p.target_installation_id IS DISTINCT FROM p_group->>'targetInstallationId' OR p.target_owner_scope_kind IS DISTINCT FROM p_group->>'targetOwnerScopeKind'
   OR p.target_owner_scope_id IS DISTINCT FROM p_group->>'targetOwnerScopeId' THEN RETURN 'denied';END IF;
  SELECT * INTO b FROM public.native_installation_starts WHERE installation_id=p_installation;
  IF NOT FOUND THEN RETURN 'unproven';END IF;
  IF b.retired IS DISTINCT FROM FALSE OR(b.provider_id,b.owner_user_id,b.owner_scope_kind,b.owner_scope_id,b.original_policy)
   IS DISTINCT FROM(i.provider_id,i.owner_user_id,i.owner_scope_kind,i.owner_scope_id,i.start_policy) THEN RETURN 'denied';END IF;
  IF b.original_policy='retained_history' THEN RETURN 'eligible';END IF;
  IF b.original_policy<>'from_now' OR b.start_xid IS NULL OR b.start_order IS NULL OR b.start_snapshot IS NULL THEN RETURN 'unproven';END IF;
  IF p.publication_xid::bigint=b.start_xid THEN RETURN CASE WHEN p.publication_order::bigint>b.start_order THEN 'eligible' ELSE 'before' END;END IF;
  RETURN CASE WHEN txid_visible_in_snapshot(p.publication_xid::bigint,b.start_snapshot) THEN 'before' ELSE 'eligible' END;
 END $$`,
 `CREATE OR REPLACE FUNCTION shared.read_memory_team_semantic_group(p_installation uuid,p_kind text,p_seed text)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE native_key text;call_key text;submission uuid;decision uuid;p record;root text;r record;a record;seal jsonb;scopes jsonb;roots jsonb:='[]';result jsonb;root_count int:=0;context_count int:=0;support_count int:=0;outside_partition boolean:=FALSE;withdrawn boolean:=FALSE;BEGIN
  IF p_installation IS NULL OR p_kind IS NULL OR p_kind NOT IN('team_collaboration','team_delivery') OR p_seed IS NULL OR length(p_seed) NOT BETWEEN 1 AND 1024 THEN RAISE EXCEPTION 'team_semantic_group_request_invalid';END IF;
  IF p_kind='team_collaboration' THEN native_key=p_seed;call_key=p_seed;
  ELSE
   SELECT receipt.submission_id,receipt.decision_id,s.source_call_id INTO submission,decision,call_key
    FROM public.team_delivery_memory_sources receipt JOIN public.team_task_submissions s USING(submission_id) WHERE receipt.source_session_id=p_seed;
   IF NOT FOUND THEN RAISE EXCEPTION 'team_semantic_group_unproven';END IF;
   native_key=decision::text;
  END IF;
  SELECT * INTO p FROM public.read_native_team_semantic_publication(p_kind,native_key);
  IF NOT FOUND OR p.retired IS DISTINCT FROM FALSE OR p.publication_xid IS NULL OR p.call_id IS DISTINCT FROM call_key
   OR(p_kind='team_delivery' AND(p.submission_id IS DISTINCT FROM submission::text OR p.decision_id IS DISTINCT FROM decision::text)) THEN RAISE EXCEPTION 'team_semantic_group_unproven';END IF;
  FOR root IN SELECT key FROM(SELECT call_key AS key WHERE p_kind='team_collaboration'
    UNION ALL SELECT receipt.source_session_id FROM public.team_delivery_memory_sources receipt WHERE p_kind='team_delivery' AND receipt.submission_id=submission AND receipt.decision_id=decision) all_roots ORDER BY key COLLATE "C" LOOP
   root_count=root_count+1;IF root_count>256 THEN RAISE EXCEPTION 'team_semantic_group_limit';END IF;
   seal=shared.current_memory_source_distribution(p_kind,root,p_installation);
   IF seal IS NULL THEN RAISE EXCEPTION 'team_semantic_group_not_ready';END IF;
   scopes='[]';
   FOR r IN WITH candidates AS(
    SELECT DISTINCT i.installation_id::text||':'||lpad(part.user_id::text,10,'0')||':'||b.binding_id AS cursor_key,
     m.mode,b.binding_id,jsonb_build_object('installationId',i.installation_id::text,'principalUserId',part.user_id::text,
      'ownerScopeKind',i.owner_scope_kind,'ownerScopeId',i.owner_scope_id::text,'authorizationRevision',i.authorization_epoch::text,
      'configVersion',i.config_version::text,'modeGeneration',m.generation::text,'bindingRevision',b.revision::text,'participantRevision',part.revision::text) AS scope
    FROM public.collaboration_calls c JOIN public.collaboration_sessions s USING(team_session_id)
     JOIN public.team_memory_bindings b ON b.team_id=s.team_id AND b.state='active'
     JOIN public.collaboration_session_participants part ON part.team_session_id=s.team_session_id
     JOIN public.extension_installations i ON(i.owner_scope_kind='personal' AND i.owner_user_id=part.user_id OR i.owner_scope_kind IN('team','organization') AND i.installation_id=b.installation_id)
     JOIN shared.memory_source_modes m ON m.installation_id=i.installation_id JOIN memory.memory_installations local ON local.installation_id=i.installation_id
    WHERE c.call_id=call_key AND i.installation_id=p_installation AND i.provider_id='pocketctl-memory' AND i.status='active'
     AND m.mode IN('shared-shadow','shared-active') AND local.relay_status='active' AND local.local_status NOT IN('purging','purged','integrity_error')
     AND(p_kind='team_collaboration' OR EXISTS(SELECT 1 FROM public.team_delivery_memory_sources receipt WHERE receipt.source_session_id=root AND receipt.reader_user_id=part.user_id))
   ) SELECT * FROM candidates ORDER BY cursor_key COLLATE "C" LIMIT 513 LOOP
    context_count=context_count+1;IF context_count>512 THEN RAISE EXCEPTION 'team_semantic_group_limit';END IF;
    SELECT * INTO a FROM shared.memory_team_source_authority(r.scope,p_kind,root);
    IF a.state='current' AND(a.context->>'bindingId',a.context->>'bindingRevision',a.context->>'targetInstallationId',a.context->>'targetOwnerScopeKind',a.context->>'targetOwnerScopeId')
     IS DISTINCT FROM(p.binding_id,p.binding_revision,p.target_installation_id,p.target_owner_scope_kind,p.target_owner_scope_id) THEN a.state='revoked';END IF;
    IF a.state='current' THEN support_count=support_count+1;END IF;
    scopes=scopes||jsonb_build_array(jsonb_build_object('cursorKey',r.cursor_key,'scope',r.scope,'mode',r.mode,'state',a.state,
     'version',jsonb_build_object('content',a.content_revision,'authorization',a.authorization_revision,'storage',a.storage_revision)));
   END LOOP;
   outside_partition=FALSE;
   IF jsonb_array_length(scopes)=0 THEN
    outside_partition=p_kind='team_delivery' AND EXISTS(SELECT 1 FROM public.extension_installations i JOIN public.team_delivery_memory_sources receipt ON receipt.source_session_id=root
     WHERE i.installation_id=p_installation AND i.provider_id='pocketctl-memory' AND i.status='active' AND i.owner_scope_kind='personal' AND i.owner_user_id<>receipt.reader_user_id
      AND receipt.submission_id=submission AND receipt.decision_id=decision);
    IF outside_partition IS DISTINCT FROM TRUE OR seal->>'targetCount' IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'team_semantic_group_not_ready';END IF;
   END IF;
   IF seal->>'targetCount' IS DISTINCT FROM jsonb_array_length(scopes)::text THEN RAISE EXCEPTION 'team_semantic_group_not_ready';END IF;
   -- Compare every sealed candidate, including negatives. The private seal is
   -- necessary but cannot substitute for fresh native roster discovery.
   FOR r IN SELECT value FROM jsonb_array_elements(scopes) LOOP
    IF NOT EXISTS(SELECT 1 FROM shared.memory_source_distribution_targets t WHERE t.scan_id=(seal->>'scanId')::uuid AND t.installation_id=p_installation
     AND t.cursor_key=r.value->>'cursorKey' AND t.source_scope=r.value->'scope' AND t.target_mode=r.value->>'mode' AND t.state=r.value->>'state'
     AND t.source_version=r.value->'version') THEN RAISE EXCEPTION 'team_semantic_group_not_ready';END IF;
   END LOOP;
   roots=roots||jsonb_build_array(jsonb_build_object('root',jsonb_build_object('kind',p_kind,'key',root),'seal',seal,'contexts',scopes,'outsidePartition',outside_partition));
  END LOOP;
  IF root_count=0 OR context_count=0 THEN RAISE EXCEPTION 'team_semantic_group_not_ready';END IF;
  IF p_kind='team_delivery' THEN
   withdrawn=EXISTS(SELECT 1 FROM public.team_delivery_memory_withdrawals w WHERE(w.team_id,w.team_session_id,w.submission_id,w.decision_id)=(p.team_id,p.team_session_id,submission,decision))
    OR EXISTS(SELECT 1 FROM memory.memory_team_delivery_withdrawals w WHERE(w.team_id,w.team_session_id,w.submission_id,w.decision_id)=(p.team_id,p.team_session_id,submission,decision))
    OR EXISTS(SELECT 1 FROM public.team_artifact_revocations revoked_artifact WHERE revoked_artifact.submission_id=submission);
  END IF;
  result=jsonb_build_object('version',1,'installationId',p_installation::text,'kind',p_kind,'seed',p_seed,'nativeKey',native_key,
   'teamId',p.team_id,'teamSessionId',p.team_session_id,'callId',p.call_id,'submissionId',p.submission_id,'decisionId',p.decision_id,
   'bindingId',p.binding_id,'bindingRevision',p.binding_revision,'targetInstallationId',p.target_installation_id,
   'targetOwnerScopeKind',p.target_owner_scope_kind,'targetOwnerScopeId',p.target_owner_scope_id,'publication',to_jsonb(p),'roots',roots,
   'controlRevision',shared.memory_source_control_snapshot()::text,'supportCount',support_count,'withdrawn',withdrawn);
  IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'team_semantic_group_limit';END IF;
  RETURN result||jsonb_build_object('admission',shared.memory_team_semantic_input_admission(p_installation,result));
 END $$`,
 `CREATE OR REPLACE FUNCTION shared.lock_memory_team_semantic_group(p_execution uuid,p_group jsonb,p_retained boolean)
 RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE installation uuid;r record;c record;fresh jsonb;positive_count int:=0;BEGIN
  IF current_setting('transaction_isolation')<>'read committed' OR p_group IS NULL OR jsonb_typeof(p_group)<>'object'
   OR octet_length(p_group::text)>2097152 OR p_retained IS NULL THEN RETURN FALSE;END IF;
  BEGIN
   installation=(p_group->>'installationId')::uuid;
   IF p_execution IS NOT NULL AND(NOT EXISTS(SELECT 1 FROM shared.memory_source_executions WHERE execution_id=p_execution AND installation_id=installation)
    OR shared.guard_memory_job_source_commit(p_execution) IS DISTINCT FROM TRUE) THEN RAISE lock_not_available;END IF;
   -- NULL is a current native metadata fence only. Original signed API grant,
   -- principal/session/expiry stay in the existing outer authorization port.
   IF shared.guard_memory_control_commit((p_group->>'controlRevision')::bigint) IS DISTINCT FROM TRUE THEN RAISE lock_not_available;END IF;
   IF p_group->>'kind'='team_delivery' AND NOT pg_try_advisory_xact_lock_shared(hashtextextended('memory:delivery-submission-privacy:v1:'||(p_group->>'submissionId'),0)) THEN RAISE lock_not_available;END IF;
   IF p_group->>'kind'='team_delivery' AND shared.lock_memory_delivery_commit(jsonb_build_array(jsonb_build_object('team_id',p_group->>'teamId','team_session_id',p_group->>'teamSessionId','submission_id',p_group->>'submissionId','decision_id',p_group->>'decisionId'))) IS DISTINCT FROM TRUE THEN RAISE lock_not_available;END IF;
   fresh=shared.read_memory_team_semantic_group(installation,p_group->>'kind',p_group->>'seed');
   IF fresh IS DISTINCT FROM p_group OR COALESCE((fresh->>'supportCount')::int,0)<1 OR(fresh->>'withdrawn')::boolean IS DISTINCT FROM FALSE THEN RAISE lock_not_available;END IF;
   FOR r IN SELECT value FROM jsonb_array_elements(fresh->'roots') ORDER BY value->'root'->>'key' COLLATE "C" LOOP
    -- Outside-I receipts remain a fenced metadata obligation even though
    -- they grant no principal or body authority to this installation.
    PERFORM root_key FROM shared.memory_source_work WHERE source_kind=fresh->>'kind' AND root_key=r.value->'root'->>'key' FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE lock_not_available;END IF;
    PERFORM scan_id FROM shared.memory_source_distributions WHERE source_kind=fresh->>'kind' AND root_key=r.value->'root'->>'key'
     AND scan_id=(r.value->'seal'->>'scanId')::uuid AND state='sealed' AND work_revision=(r.value->'seal'->>'workRevision')::bigint FOR SHARE NOWAIT;
    IF NOT FOUND THEN RAISE lock_not_available;END IF;
    FOR c IN SELECT value FROM jsonb_array_elements(r.value->'contexts') ORDER BY value->>'cursorKey' COLLATE "C" LOOP
     IF c.value->>'state' NOT IN('current','revoked','deleted') THEN RAISE lock_not_available;END IF;
     IF c.value->>'state'='current' THEN positive_count=positive_count+1;END IF;
     IF c.value->>'state'='current' AND shared.lock_memory_team_source_commit(c.value->'scope',fresh->>'kind',r.value->'root'->>'key',c.value->'version',p_retained) IS DISTINCT FROM TRUE THEN RAISE lock_not_available;END IF;
    END LOOP;
   END LOOP;
   IF shared.read_memory_team_semantic_group(installation,p_group->>'kind',p_group->>'seed') IS DISTINCT FROM fresh THEN RAISE lock_not_available;END IF;
   RETURN positive_count>0;
  EXCEPTION WHEN lock_not_available OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN FALSE;END;
 END $$`,
 `CREATE OR REPLACE FUNCTION shared.read_memory_team_legacy_audit(p_installation uuid,p_group jsonb)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,memory,shared AS $$
 DECLARE fresh jsonb;identity jsonb;expected_turn text;rec record;proof jsonb;access jsonb;proof_identity jsonb;known boolean;
  matching boolean;all_related boolean;all_other boolean;ids jsonb:='{}';others jsonb:='{}';relations jsonb:='[]';snapshot jsonb:='[]';reasons jsonb:='[]';
  relation_count int:=0;kind_count int:=0;last_kind text;metadata_bytes int:=0;business boolean:=FALSE;global_rows jsonb;accounting jsonb;global_count int;unbound int;global_related int;result jsonb;BEGIN
  IF p_installation IS NULL OR p_group IS NULL OR jsonb_typeof(p_group)<>'object' OR octet_length(p_group::text)>2097152
   OR p_group-ARRAY['version','installationId','kind','seed','nativeKey','teamId','teamSessionId','callId','submissionId','decisionId','bindingId','bindingRevision','targetInstallationId','targetOwnerScopeKind','targetOwnerScopeId','publication','roots','controlRevision','supportCount','withdrawn','admission']<>'{}'::jsonb
   OR p_group->>'installationId' IS DISTINCT FROM p_installation::text THEN RAISE EXCEPTION 'team_semantic_legacy_request_invalid';END IF;
  -- Independently controlled original native identity + complete current roots;
  -- the caller cannot supply its own owner, roster or global-accounting claim.
  fresh=shared.read_memory_team_semantic_group(p_installation,p_group->>'kind',p_group->>'seed');
  IF fresh IS DISTINCT FROM p_group THEN RAISE EXCEPTION 'team_semantic_group_changed';END IF;
  identity=CASE WHEN fresh->>'kind'='team_collaboration' THEN jsonb_build_array(fresh->>'kind','1',fresh->>'teamId',fresh->>'teamSessionId',fresh->>'callId')
   ELSE jsonb_build_array(fresh->>'kind','2',fresh->>'teamId',fresh->>'teamSessionId',fresh->>'submissionId',fresh->>'decisionId') END
    ||jsonb_build_array(fresh->>'bindingId',fresh->>'bindingRevision',fresh->>'targetInstallationId',fresh->>'targetOwnerScopeKind',fresh->>'targetOwnerScopeId');
  expected_turn=CASE WHEN fresh->>'kind'='team_collaboration' THEN 'team-call:'||(fresh->>'callId') ELSE 'team-delivery:'||(fresh->>'submissionId')||':'||(fresh->>'decisionId') END;
  FOR rec IN SELECT * FROM(
SELECT 1 AS rank,'source'::text AS kind,x.source_event_id::text AS id,x.mapping_state::text AS state,jsonb_build_object('source_event_id',x.source_event_id,'turn_id',x.turn_id,'session_id',x.session_id,'origin',x.origin,'adapter_version',x.adapter_version,'canonical_projected_at',x.canonical_projected_at,'payloadDigest',encode(x.payload_hash,'hex'),'contentDigest',encode(x.content_hash,'hex')) AS metadata,ARRAY[]::text[] AS links,CASE WHEN x.source_provenance->>'source_kind'='team_semantic' THEN x.source_provenance->'native' ELSE COALESCE(x.source_provenance->'team',x.source_provenance) END AS proof FROM(SELECT adapter_version,canonical_projected_at,content_hash,installation_id,mapping_state,origin,payload_hash,session_id,source_event_id,source_provenance,turn_id FROM memory.source_events WHERE installation_id=p_installation AND(source_kind IS DISTINCT FROM 'team_semantic' AND(source_kind IN('team_collaboration','team_delivery') OR origin='team' OR source_provenance->>'source_kind'='team_session' OR source_provenance->'team'->>'source_kind'='team_session')) ORDER BY source_event_id LIMIT 2049) x
 UNION ALL
 SELECT 2 AS rank,'turn'::text AS kind,x.turn_id::text AS id,x.state::text AS state,jsonb_build_object('turn_id',x.turn_id,'session_id',x.session_id,'first_source_event_id',x.first_source_event_id,'last_source_event_id',x.last_source_event_id,'event_count',x.event_count) AS metadata,ARRAY['source:'||x.first_source_event_id::text,'source:'||x.last_source_event_id::text] AS links,NULL::jsonb AS proof FROM(SELECT event_count,first_source_event_id,installation_id,last_source_event_id,session_id,state,turn_id FROM memory.source_turns WHERE installation_id=p_installation AND(turn_id NOT LIKE 'team-semantic:%') ORDER BY turn_id LIMIT 2049) x
 UNION ALL
 SELECT 3 AS rank,'episode'::text AS kind,x.episode_id::text AS id,x.state::text AS state,jsonb_build_object('turn_id',x.turn_id,'compiler_version',x.compiler_version,'sourceDigest',encode(x.source_digest,'hex')) AS metadata,ARRAY['turn:'||x.turn_id] AS links,NULL::jsonb AS proof FROM(SELECT compiler_version,episode_id,installation_id,source_digest,state,turn_id FROM memory.work_episodes WHERE installation_id=p_installation AND(turn_id NOT LIKE 'team-semantic:%') ORDER BY episode_id LIMIT 2049) x
 UNION ALL
 SELECT 4 AS rank,'task'::text AS kind,x.bundle_id::text AS id,x.state::text AS state,jsonb_build_object('revision',x.revision,'sourceDigest',encode(x.source_digest,'hex')) AS metadata,ARRAY(SELECT 'source:'||b.source_event_id::text FROM memory.memory_task_bundle_sources b WHERE b.installation_id=x.installation_id AND b.bundle_id=x.bundle_id ORDER BY b.source_event_id) AS links,NULL::jsonb AS proof FROM(SELECT bundle_id,installation_id,revision,source_digest,state FROM memory.memory_task_bundles WHERE installation_id=p_installation AND(TRUE) ORDER BY bundle_id LIMIT 2049) x
 UNION ALL
 SELECT 5 AS rank,'extraction'::text AS kind,x.run_id::text AS id,x.state::text AS state,jsonb_build_object('episode_id',x.episode_id,'generation_run_id',x.generation_run_id,'error_code',x.error_code,'input_tokens',x.input_tokens,'output_tokens',x.output_tokens,'cost_micros',x.cost_micros,'sourceDigest',encode(x.episode_source_digest,'hex'),'inputDigest',encode(x.input_digest,'hex')) AS metadata,ARRAY['episode:'||x.episode_id::text] AS links,NULL::jsonb AS proof FROM(SELECT cost_micros,episode_id,episode_source_digest,error_code,generation_run_id,input_digest,input_tokens,installation_id,output_tokens,run_id,state FROM memory.memory_extraction_runs WHERE installation_id=p_installation AND(TRUE) ORDER BY run_id LIMIT 2049) x
 UNION ALL
 SELECT 6 AS rank,'curation'::text AS kind,x.run_id::text AS id,x.state::text AS state,jsonb_build_object('bundle_id',x.bundle_id,'bundle_revision',x.bundle_revision,'mode',x.mode,'input_tokens',x.input_tokens,'output_tokens',x.output_tokens,'sourceDigest',encode(x.source_digest,'hex')) AS metadata,ARRAY['task:'||x.bundle_id::text] AS links,NULL::jsonb AS proof FROM(SELECT bundle_id,bundle_revision,input_tokens,installation_id,mode,output_tokens,run_id,source_digest,state FROM memory.memory_curation_runs WHERE installation_id=p_installation AND(TRUE) ORDER BY run_id LIMIT 2049) x
 UNION ALL
 SELECT 7 AS rank,'generation'::text AS kind,x.run_id::text AS id,x.state::text AS state,jsonb_build_object('operation',x.operation,'job_id',x.job_id,'output_id',x.output_id,'input_tokens',x.input_tokens,'output_tokens',x.output_tokens,'cost_micros',x.cost_micros,'inputDigest',encode(x.input_digest,'hex')) AS metadata,ARRAY(SELECT 'extraction:'||e.run_id::text FROM memory.memory_extraction_runs e WHERE e.installation_id=x.installation_id AND e.generation_run_id=x.run_id ORDER BY e.run_id) AS links,NULL::jsonb AS proof FROM(SELECT cost_micros,input_digest,input_tokens,installation_id,job_id,operation,output_id,output_tokens,run_id,state FROM memory.memory_generation_runs WHERE installation_id=p_installation AND(TRUE) ORDER BY run_id LIMIT 2049) x
 UNION ALL
 SELECT 8 AS rank,'candidate'::text AS kind,x.candidate_id::text AS id,x.status::text AS state,jsonb_build_object('source_kind',x.source_kind,'run_id',x.run_id,'curation_run_id',x.curation_run_id,'episode_id',x.episode_id,'bundle_id',x.bundle_id) AS metadata,CASE WHEN x.run_id IS NOT NULL THEN ARRAY['extraction:'||x.run_id::text] WHEN x.curation_run_id IS NOT NULL THEN ARRAY['curation:'||x.curation_run_id::text] ELSE ARRAY[]::text[] END AS links,NULL::jsonb AS proof FROM(SELECT bundle_id,candidate_id,curation_run_id,episode_id,installation_id,run_id,source_kind,status FROM memory.memory_candidates WHERE installation_id=p_installation AND(TRUE) ORDER BY candidate_id LIMIT 2049) x
 UNION ALL
 SELECT 9 AS rank,'evidence'::text AS kind,x.evidence_id::text AS id,x.evidence_kind::text AS state,jsonb_build_object('version_id',x.version_id,'capsule_id',x.capsule_id,'episode_id',x.episode_id,'source_event_id',x.source_event_id,'excerptDigest',encode(x.excerpt_hash,'hex')) AS metadata,array_remove(ARRAY['source:'||x.source_event_id::text,'episode:'||x.episode_id::text],NULL) AS links,CASE WHEN x.locator->'source_provenance'->>'source_kind'='team_semantic' THEN x.locator->'source_provenance'->'native' ELSE COALESCE(x.locator->'source_provenance'->'team',x.locator->'source_provenance') END AS proof FROM(SELECT capsule_id,episode_id,evidence_id,evidence_kind,excerpt_hash,installation_id,locator,source_event_id,version_id FROM memory.knowledge_evidence WHERE installation_id=p_installation AND(TRUE) ORDER BY evidence_id LIMIT 2049) x
 UNION ALL
 SELECT 10 AS rank,'version'::text AS kind,x.version_id::text AS id,x.authority::text AS state,jsonb_build_object('claim_id',x.claim_id,'source_candidate_id',x.source_candidate_id) AS metadata,ARRAY['candidate:'||x.source_candidate_id::text] AS links,NULL::jsonb AS proof FROM(SELECT authority,claim_id,installation_id,source_candidate_id,version_id FROM memory.knowledge_versions WHERE installation_id=p_installation AND(TRUE) ORDER BY version_id LIMIT 2049) x
 UNION ALL
 SELECT 11 AS rank,'capsule'::text AS kind,x.capsule_id::text AS id,x.retention_basis::text AS state,jsonb_build_object('version_id',x.version_id,'sourceDigest',encode(x.source_content_hash,'hex')) AS metadata,ARRAY['version:'||x.version_id::text] AS links,NULL::jsonb AS proof FROM(SELECT capsule_id,installation_id,retention_basis,source_content_hash,version_id FROM memory.knowledge_evidence_capsules WHERE installation_id=p_installation AND(TRUE) ORDER BY capsule_id LIMIT 2049) x
 UNION ALL
 SELECT 12 AS rank,'usage'::text AS kind,x.usage_id::text AS id,x.operation::text AS state,jsonb_build_object('input_tokens',x.input_tokens,'output_tokens',x.output_tokens,'embedding_tokens',x.embedding_tokens,'cached_tokens',x.cached_tokens,'cost_micros',x.cost_micros,'attempts',x.attempts) AS metadata,CASE WHEN x.usage_id ~ '^extraction:[a-f0-9-]{36}$' THEN ARRAY['extraction:'||substring(x.usage_id FROM 12)] ELSE ARRAY[]::text[] END AS links,NULL::jsonb AS proof FROM(SELECT attempts,cached_tokens,cost_micros,embedding_tokens,input_tokens,installation_id,operation,output_tokens,usage_id FROM memory.memory_usage_outbox WHERE installation_id=p_installation AND(TRUE) ORDER BY usage_id LIMIT 2049) x
  ) graph ORDER BY rank,id COLLATE "C" LOOP
   relation_count=relation_count+1;
   IF last_kind IS DISTINCT FROM rec.kind THEN last_kind=rec.kind;kind_count=0;END IF;
   kind_count=kind_count+1;
   IF kind_count>2048 AND NOT reasons ? 'relation_limit' THEN reasons=reasons||'"relation_limit"'::jsonb;END IF;
   metadata_bytes=metadata_bytes+octet_length(rec.metadata::text)+COALESCE(octet_length(rec.proof::text),0);
   IF metadata_bytes>2097152 THEN IF NOT reasons ? 'relation_limit' THEN reasons=reasons||'"relation_limit"'::jsonb;END IF;EXIT;END IF;
   IF relation_count>4096 THEN IF NOT reasons ? 'relation_limit' THEN reasons=reasons||'"relation_limit"'::jsonb;END IF;EXIT;END IF;
   snapshot=snapshot||jsonb_build_array(jsonb_build_array(rec.kind,rec.id,rec.state,rec.metadata,rec.links,rec.proof));
   proof=rec.proof;access=proof->'read_scope';proof_identity=NULL;known=FALSE;
   IF proof->>'source_kind'='team_session' AND proof->>'source_version' IN('1','2')
    AND jsonb_typeof(access)='object' AND access->>'kind'='team_session'
    AND access->>'team_id'=proof->>'team_id' AND access->>'team_session_id'=proof->>'team_session_id'
    AND proof ?& ARRAY['team_id','team_session_id','team_call_id','original_source_id']
    AND access ?& ARRAY['team_memory_binding_id','team_memory_binding_revision','target_installation_id','target_owner_scope_kind','target_owner_scope_id','participant_user_id','participant_revision']
    AND access->>'team_memory_binding_revision' ~ '^[1-9][0-9]{0,18}$' AND access->>'participant_user_id' ~ '^[1-9][0-9]{0,9}$'
    AND access->>'participant_revision' ~ '^[1-9][0-9]{0,18}$' THEN
    IF proof->>'source_version'='1' AND proof->>'original_source_id'='team:'||(proof->>'team_id')||':'||(proof->>'team_session_id')||':'||(proof->>'team_call_id')
     AND jsonb_typeof(proof->'team_event_ids')='array' AND jsonb_array_length(proof->'team_event_ids')>0
     AND jsonb_array_length(proof->'team_event_ids')=jsonb_array_length(proof->'team_event_seqs') THEN
     proof_identity=jsonb_build_array('team_collaboration','1',proof->>'team_id',proof->>'team_session_id',proof->>'team_call_id');
    ELSIF proof->>'source_version'='2' AND proof->>'original_source_id'='team-delivery:'||(proof->'accepted_delivery'->>'submission_id')||':'||(proof->'accepted_delivery'->>'decision_id') THEN
     proof_identity=jsonb_build_array('team_delivery','2',proof->>'team_id',proof->>'team_session_id',proof->'accepted_delivery'->>'submission_id',proof->'accepted_delivery'->>'decision_id');
    END IF;
    IF proof_identity IS NOT NULL THEN proof_identity=proof_identity||jsonb_build_array(access->>'team_memory_binding_id',access->>'team_memory_binding_revision',access->>'target_installation_id',access->>'target_owner_scope_kind',access->>'target_owner_scope_id');known=TRUE;END IF;
   END IF;
   all_related=cardinality(rec.links)>0 AND NOT EXISTS(SELECT 1 FROM unnest(rec.links) link WHERE link IS NULL OR NOT ids ? link);
   all_other=cardinality(rec.links)>0 AND NOT EXISTS(SELECT 1 FROM unnest(rec.links) link WHERE link IS NULL OR NOT others ? link);
   matching=known AND proof_identity=identity OR ids ? (rec.kind||':'||rec.id) OR all_related;
   IF matching THEN
    ids=ids||jsonb_build_object(rec.kind||':'||rec.id,TRUE);
    relations=relations||jsonb_build_array(jsonb_build_array(rec.kind,rec.id,encode(sha256(convert_to(rec.metadata::text,'UTF8')),'hex'),COALESCE(rec.state,'unknown')));
    IF rec.kind='evidence' THEN ids=ids||jsonb_build_object('version:'||(rec.metadata->>'version_id'),TRUE);END IF;
    IF rec.kind<>'source' OR rec.metadata->>'origin' IS DISTINCT FROM 'canonical' OR rec.metadata->'canonical_projected_at'<>'null'::jsonb OR rec.metadata->>'adapter_version' IS DISTINCT FROM 'canonical-ref-v1' THEN business=TRUE;END IF;
   ELSIF known OR all_other THEN
    others=others||jsonb_build_object(rec.kind||':'||rec.id,TRUE);
    IF rec.kind='evidence' THEN others=others||jsonb_build_object('version:'||(rec.metadata->>'version_id'),TRUE);END IF;
   ELSE IF NOT reasons ? 'relation_unknown' THEN reasons=reasons||'"relation_unknown"'::jsonb;END IF;END IF;
  END LOOP;
  -- The global IDs below remain inside this definer. Only an opaque digest and
  -- counts escape. No budget-key/text/timestamp ownership inference is used.
  SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.reservation_id),'[]') INTO global_rows FROM(
   SELECT r.reservation_id,r.state,r.provider_kind,r.reserved_input_tokens,r.reserved_output_tokens,r.actual_input_tokens,r.actual_output_tokens,
    a.execution_id,a.state AS attempt_state,e.installation_id,e.job_id,
    (SELECT jsonb_agg(DISTINCT owner_id ORDER BY owner_id) FROM(
     SELECT e.installation_id AS owner_id WHERE e.installation_id IS NOT NULL
     UNION SELECT w.installation_id FROM memory.memory_wiki_build_runs w WHERE w.budget_reservation_id=r.reservation_id
     UNION SELECT sk.installation_id FROM memory.memory_skill_task_runs sk WHERE sk.budget_reservation_id=r.reservation_id) owners) AS owners,
    -- Historical job payload is mutable. Only the private original execution
    -- installation can exclude a different owner; it cannot establish this
    -- group's old budget relation. New dispatch enrollment is a later contract.
    FALSE AS related
   FROM memory.memory_provider_budget_reservations r LEFT JOIN shared.memory_source_provider_attempts a USING(reservation_id)
    LEFT JOIN shared.memory_source_executions e USING(execution_id)
   ORDER BY r.reservation_id LIMIT 2049) b;
  global_count=jsonb_array_length(global_rows);
  SELECT count(*) FILTER(WHERE CASE WHEN jsonb_typeof(value->'owners')='array' THEN jsonb_array_length(value->'owners') ELSE 0 END<>1 OR(value->'owners' ? p_installation::text AND value->>'related' IS DISTINCT FROM 'true')),
   count(*) FILTER(WHERE value->'owners' ? p_installation::text AND value->>'related'='true') INTO unbound,global_related FROM jsonb_array_elements(global_rows);
  IF global_count>2048 THEN IF NOT reasons ? 'relation_limit' THEN reasons=reasons||'"relation_limit"'::jsonb;END IF;END IF;
  IF unbound>0 THEN reasons=reasons||'"global_accounting_unbound"'::jsonb;END IF;
  accounting=jsonb_build_object('version',1,'digest',encode(sha256(convert_to(global_rows::text,'UTF8')),'hex'),'count',global_count,'unprovenCount',unbound,'relatedCount',global_related);
  result=jsonb_build_object('version',1,'closure','snapshot_only','disposition',CASE WHEN jsonb_array_length(reasons)>0 THEN 'unproven' WHEN business OR global_related>0 THEN 'related' ELSE 'fresh_candidate' END,
   'identityDigest',encode(sha256(convert_to(identity::text,'UTF8')),'hex'),'closureDigest',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),'relations',relations,'accounting',accounting,'reasons',reasons);
  IF octet_length(result::text)>2097152 THEN RAISE EXCEPTION 'team_semantic_legacy_audit_limit';END IF;
  RETURN result;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.read_memory_team_legacy_audit(uuid,jsonb) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION memory.guard_team_semantic_publication() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,memory AS $$ BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'team_semantic_publication_immutable';END IF;
  RETURN NULL;
 END $$`,
 `CREATE OR REPLACE FUNCTION shared.check_memory_team_semantic_publication_commit() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE e record;fresh jsonb;BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'team_semantic_publication_commit_fence';END IF;
  SELECT * INTO e FROM shared.memory_source_executions WHERE execution_id=NEW.publication_execution_id;
  IF NOT FOUND OR e.branch<>'canonical-active' OR e.installation_id<>NEW.installation_id OR e.generation IS DISTINCT FROM NEW.publication_mode_generation
   OR e.control_revision IS DISTINCT FROM NEW.publication_control_revision OR shared.guard_memory_job_source_commit(e.execution_id) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'team_semantic_publication_commit_fence';END IF;
  -- Re-read before repeating any native footprint. A new root/principal or
  -- version cannot be acquired late while publication/derived locks are held.
  fresh=shared.read_memory_team_semantic_group(NEW.installation_id,NEW.source_kind,NEW.source_roster->>'seed');
  IF fresh IS DISTINCT FROM NEW.source_roster OR fresh->'publication' IS DISTINCT FROM NEW.native_publication_proof
   OR(NEW.disposition IN('published','legacy_related','legacy_unproven') AND fresh->>'admission' IS DISTINCT FROM 'eligible') OR(NEW.disposition='policy_excluded' AND fresh->>'admission'<>'before')
   OR shared.lock_memory_team_semantic_group(e.execution_id,NEW.source_roster,FALSE) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'team_semantic_publication_commit_fence';END IF;
  IF NEW.disposition<>'policy_excluded' AND shared.read_memory_team_legacy_audit(NEW.installation_id,NEW.source_roster) IS DISTINCT FROM NEW.legacy_relation_audit THEN RAISE EXCEPTION 'team_semantic_legacy_audit_changed';END IF;
  -- A bounded snapshot is not a global accounting writer fence. No fresh paid
  -- business can be minted until that independently reviewed capability exists.
  IF NEW.disposition='published' THEN RAISE EXCEPTION 'team_semantic_global_fence_required';END IF;
  IF NEW.disposition IN('published','legacy_related') AND EXISTS(SELECT 1 FROM(VALUES(NEW.goal_ref_id,'goal'),(NEW.reply_ref_id,'reply'),(NEW.outcome_ref_id,'outcome')) role(id,name)
   LEFT JOIN memory.source_events s ON s.source_event_id=role.id AND s.installation_id=NEW.installation_id
   LEFT JOIN memory.memory_team_semantic_groups g ON g.semantic_ref_id=role.id AND g.installation_id=NEW.installation_id
   WHERE s.source_kind IS DISTINCT FROM 'team_semantic' OR s.adapter_version IS DISTINCT FROM 'team-semantic-v1'
    OR s.payload IS NOT NULL OR s.content_hash IS DISTINCT FROM g.semantic_payload_hash OR s.payload_hash IS DISTINCT FROM g.semantic_payload_hash
    OR g.registration_state IS DISTINCT FROM 'published' OR g.structured_identity IS DISTINCT FROM NEW.structured_identity||jsonb_build_array(role.name)
    OR s.source_version IS DISTINCT FROM jsonb_build_object('normalization','team-semantic-v1','businessDigest',encode(g.business_digest,'hex'),'originalSupportDigest',encode(NEW.support_digest,'hex'))
    OR s.source_provenance->>'role' IS DISTINCT FROM role.name OR s.source_provenance->>'business_digest' IS DISTINCT FROM encode(g.business_digest,'hex')
    OR s.canonical_key IS DISTINCT FROM g.semantic_key OR s.session_id IS DISTINCT FROM NEW.semantic_session_id OR s.turn_id IS DISTINCT FROM NEW.semantic_turn_id)
   THEN RAISE EXCEPTION 'team_semantic_publication_commit_fence';END IF;
  RETURN NULL;
 END $$`,
 `REVOKE ALL ON FUNCTION memory.guard_team_semantic_publication(),shared.check_memory_team_semantic_publication_commit() FROM PUBLIC`,
 `DROP TRIGGER IF EXISTS memory_team_semantic_publication_immutable ON memory.memory_team_semantic_publications;
 CREATE TRIGGER memory_team_semantic_publication_immutable BEFORE UPDATE ON memory.memory_team_semantic_publications FOR EACH ROW EXECUTE FUNCTION memory.guard_team_semantic_publication()`,
 `DROP TRIGGER IF EXISTS memory_team_semantic_publication_commit ON memory.memory_team_semantic_publications;
 CREATE CONSTRAINT TRIGGER memory_team_semantic_publication_commit AFTER INSERT OR UPDATE ON memory.memory_team_semantic_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared.check_memory_team_semantic_publication_commit()`,
 `REVOKE ALL ON FUNCTION shared.read_memory_team_semantic_group(uuid,text,text),shared.lock_memory_team_semantic_group(uuid,jsonb,boolean),shared.memory_team_semantic_input_admission(uuid,jsonb) FROM PUBLIC`,
] as const

/** Existing controlled audit definition/owner/ACL cannot be silently replaced
 * by a later installer. Fresh installation has no such function yet. */
export async function assertTeamSemanticLegacyFunction(client:{query:(...args:any[])=>Promise<any>},fencedRuntimeRole?:string):Promise<void>{
 if(fencedRuntimeRole!==undefined){
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(fencedRuntimeRole))throw Error('fenced_maintenance_runtime_required')
  const r=(await client.query(`SELECT NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
   AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.oid<>c.relowner AND NOT pg_has_role(r.oid,c.relowner,'MEMBER')
   AND has_table_privilege(r.oid,'memory.source_events','SELECT') AND has_table_privilege(r.oid,'memory.source_events','INSERT')
   AND has_table_privilege(r.oid,'memory.source_events','UPDATE') AND has_table_privilege(r.oid,'memory.source_events','DELETE') AS ready
   FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=$1 AND c.oid='memory.memory_schema_migrations'::regclass`,[fencedRuntimeRole])).rows[0]
  if(r?.ready!==true)throw Error('fenced_maintenance_runtime_required')
  await assertTargetMemoryWritersFenced(client as pg.Client)
 }
 const ddl=SHARED_TEAM_SEMANTIC_FUNCTIONS.find(s=>s.startsWith('CREATE OR REPLACE FUNCTION shared.read_memory_team_legacy_audit('))!
 const expected=ddl.split('AS $$')[1].split('$$')[0]
 const result=await client.query(`SELECT p.prosrc=$1 AND p.prosecdef AND p.provolatile='s' AND p.prokind='f' AND p.prorettype='jsonb'::regtype
  AND p.proconfig=ARRAY['search_path=pg_catalog, memory, shared'] AND p.proargnames=ARRAY['p_installation','p_group']
  AND p.proowner=(SELECT relowner FROM pg_class WHERE oid=to_regclass('memory.memory_schema_migrations'))
  AND p.proowner=(SELECT nspowner FROM pg_namespace WHERE nspname='memory')
  AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
   WHERE acl.privilege_type<>'EXECUTE' OR acl.is_grantable OR NOT COALESCE(acl.grantee=p.proowner OR acl.grantee<>0 AND EXISTS(
    SELECT 1 FROM pg_proc base CROSS JOIN LATERAL aclexplode(COALESCE(base.proacl,acldefault('f',base.proowner))) delegated
     JOIN pg_roles runtime ON runtime.oid=delegated.grantee
    WHERE base.oid=to_regprocedure('shared.read_memory_team_semantic_group(uuid,text,text)') AND base.proowner=p.proowner
     AND delegated.grantee=acl.grantee AND delegated.privilege_type='EXECUTE' AND NOT delegated.is_grantable
     AND(runtime.rolcanlogin OR runtime.rolname=$2) AND NOT runtime.rolsuper AND NOT runtime.rolcreatedb AND NOT runtime.rolcreaterole
     AND NOT runtime.rolreplication AND NOT runtime.rolbypassrls AND NOT pg_has_role(runtime.oid,p.proowner,'MEMBER')),FALSE)) AS ready
  FROM pg_proc p WHERE p.oid=to_regprocedure('shared.read_memory_team_legacy_audit(uuid,jsonb)')`,[expected,fencedRuntimeRole??null])
 if(result.rows.length&&result.rows[0]?.ready!==true)throw Error('team_semantic_legacy_function_incompatible')
}
