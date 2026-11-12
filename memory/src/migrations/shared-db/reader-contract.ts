import {metadataInputFingerprint,metadataRowLocator,metadataUsageDenied,metadataInputAdmission} from './personal-metadata-sql.js'
// Scope usage is separate from canonical custody. Enumerating eligible input
// must skip expired use before LIMIT; explicit keys remain denied references.
const sourceTurn=(e:string,r:string)=>`COALESCE(${r}.turn_id,${e}.payload->>'turn_id',${e}.payload->>'source_turn_id',CASE WHEN to_jsonb(${e})->>'source_header_version'='1' THEN to_jsonb(${e})->'source_classification'->'memory_source'->>'turn_id' END)`
const usageDenied=(e:string,r:string)=>`${r}.body_reclaimed_at IS NOT NULL OR EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts receipt WHERE receipt.installation_id=(p_scope->>'installationId')::uuid AND receipt.session_id=COALESCE(to_jsonb(${e})->>'logical_source_session_id',${e}.session_id) AND(receipt.turn_id=${sourceTurn(e,r)} OR ${sourceTurn(e,r)} IS NULL))`
// Headerless hot history can need the ordinary version-locked reader.
// Detect that case only during body-capable enumeration. The keyed metadata
// observation and the final selected fence never access historical payload.
const legacySelectionFallback=(e:string,r:string)=>`CASE WHEN ${e}.source_header_version IS NULL AND ${e}.body_storage='hot' AND ${e}.payload IS NOT NULL THEN
 CASE WHEN (${e}.canonical_payload_hash IS NULL AND ${r}.content_hash IS NULL) OR ${metadataUsageDenied(e,r)} THEN NOT(${usageDenied(e,r)}) ELSE FALSE END
 ELSE FALSE END`
const personalAuthority=(retained:boolean)=>`CREATE OR REPLACE FUNCTION shared.${retained?'memory_retained_relay_authority':'memory_relay_source_authority'}(p_scope JSONB,p_kind TEXT,p_root TEXT)
  RETURNS TABLE(state TEXT,content_revision TEXT,authorization_revision TEXT,storage_revision TEXT)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE i RECORD;s RECORD;w RECORD;m RECORD;owner_id INT;session_key TEXT;session_found BOOLEAN;native JSONB;session_ids TEXT[];BEGIN
   IF (p_kind IS NULL OR p_kind NOT IN('relay_event','legacy_archive')) OR p_scope->>'ownerScopeKind' IS DISTINCT FROM 'personal' THEN RETURN QUERY SELECT 'revoked','0','0','0';RETURN;END IF;
   owner_id=(p_scope->>'principalUserId')::int;session_key=substr(p_root,strpos(p_root,':')+1);
   IF split_part(p_root,':',1) IS DISTINCT FROM owner_id::text OR session_key='' THEN RETURN QUERY SELECT 'revoked','0','0','0';RETURN;END IF;
   IF NOT EXISTS(SELECT 1 FROM public.extension_providers WHERE provider_id='pocketctl-memory' AND status='enabled') THEN RETURN QUERY SELECT 'revoked','0','0','0';RETURN;END IF;
   IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=owner_id) THEN RETURN QUERY SELECT 'revoked','0','0','0';RETURN;END IF;
   SELECT * INTO i FROM public.extension_installations WHERE installation_id=(p_scope->>'installationId')::uuid
    AND provider_id='pocketctl-memory' AND owner_user_id=owner_id AND owner_scope_kind='personal' AND owner_scope_id=(p_scope->>'ownerScopeId')::uuid
    AND status='active' AND authorization_epoch::text=p_scope->>'authorizationRevision' AND config_version::text=p_scope->>'configVersion'
    ${retained?'':"AND granted_scopes @> ARRAY['session:events:read']::text[] AND enabled_services @> ARRAY['memory.manage']::text[]"};
   IF NOT FOUND THEN RETURN QUERY SELECT 'revoked','0','0','0';RETURN;END IF;
   SELECT mode,generation INTO m FROM shared.memory_source_modes WHERE installation_id=i.installation_id;
   IF NOT FOUND OR m.mode NOT IN('shared-shadow','shared-active') OR m.generation::text IS DISTINCT FROM p_scope->>'modeGeneration'
    THEN RETURN QUERY SELECT 'changed','0',i.authorization_epoch::text,'0';RETURN;END IF;
   session_ids=ARRAY[session_key];
   IF p_kind='relay_event' THEN
    native=public.native_session_authority(session_key,owner_id,NULL);
    IF native->>'state' IS DISTINCT FROM 'current' THEN RETURN QUERY SELECT CASE WHEN native->>'state'='deleted' THEN 'deleted' ELSE 'revoked' END,'0',i.authorization_epoch::text,'0';RETURN;END IF;
    session_key=native->>'sessionId';SELECT array_agg(value) INTO session_ids FROM jsonb_array_elements_text(native->'sessionIds');
   END IF;
   IF EXISTS(SELECT 1 FROM shared.memory_source_session_barriers WHERE owner_user_id=owner_id AND session_id=ANY(session_ids)
      -- The original barrier still denies all legacy archives. Native v3
      -- canonical enumeration separately proves every non-retired event.
      AND NOT(reason='owner_changed' AND p_kind='relay_event' AND native->>'contractVersion'='3') AND
      (reason<>'renamed' OR p_kind<>'relay_event' OR NOT EXISTS(SELECT 1 FROM public.session_aliases proof WHERE proof.old_session_id=memory_source_session_barriers.session_id
        AND proof.next_session_id=memory_source_session_barriers.canonical_session_id AND proof.owner_user_id=owner_id AND NOT proof.blocked))) THEN RETURN QUERY SELECT 'deleted','0',i.authorization_epoch::text,'0';RETURN;END IF;
   IF EXISTS(SELECT 1 FROM public.deleted_sessions WHERE session_id=ANY(session_ids)) THEN RETURN QUERY SELECT 'deleted','0',i.authorization_epoch::text,'0';RETURN;END IF;
   IF EXISTS(SELECT 1 FROM memory.memory_session_tombstones WHERE installation_id=i.installation_id AND session_id=ANY(session_ids)) THEN RETURN QUERY SELECT 'deleted','0',i.authorization_epoch::text,'0';RETURN;END IF;
   IF EXISTS(SELECT 1 FROM memory.memory_installations WHERE installation_id=i.installation_id AND local_status IN ('purging','purged','integrity_error')) THEN RETURN QUERY SELECT 'revoked','0',i.authorization_epoch::text,'0';RETURN;END IF;
   IF p_kind='legacy_archive' AND NOT EXISTS(SELECT 1 FROM memory.source_events archive WHERE archive.installation_id=i.installation_id
     AND archive.source_kind='legacy_archive' AND archive.mapping_state='verified' AND archive.legacy_owner_user_id=owner_id
     AND archive.canonical_session_key=session_key AND archive.canonical_key=archive.source_event_id::text
     AND archive.legacy_manifest_hash IS NOT NULL AND archive.adapter_version='legacy-archive-v1'
     AND left(archive.session_id,5)<>'team_' AND archive.origin IN('feed','snapshot') AND NOT(archive.source_provenance ? 'team') AND NOT(archive.source_provenance ? 'accepted_delivery'))
    THEN RETURN QUERY SELECT 'revoked','0',i.authorization_epoch::text,'0';RETURN;END IF;
   SELECT session.user_id,session.content_state,session.source,session.daemon_id,session.agent_type,daemon.user_id AS daemon_owner INTO s FROM public.sessions session
    LEFT JOIN public.daemons daemon ON daemon.daemon_id=session.daemon_id WHERE session.session_id=session_key;
   session_found=FOUND;
   IF (NOT session_found AND p_kind='relay_event') OR(session_found AND(s.user_id IS DISTINCT FROM owner_id OR s.daemon_owner IS DISTINCT FROM owner_id OR s.source='app_review_demo')) OR session_key LIKE 'app-review-demo-%'
    THEN RETURN QUERY SELECT 'revoked','0',i.authorization_epoch::text,'0';RETURN;END IF;
   ${retained?'':`
   IF i.event_filter IS NULL OR jsonb_typeof(i.event_filter) IS DISTINCT FROM 'object'
    OR i.event_filter - 'daemon_ids' - 'agent_types' <> '{}'::jsonb
    OR (i.event_filter ? 'daemon_ids' AND jsonb_typeof(i.event_filter->'daemon_ids') IS DISTINCT FROM 'array')
    OR (i.event_filter ? 'agent_types' AND jsonb_typeof(i.event_filter->'agent_types') IS DISTINCT FROM 'array')
    THEN RETURN QUERY SELECT 'revoked','0',i.authorization_epoch::text,'0';RETURN;END IF;
   IF NOT session_found AND(COALESCE(i.event_filter->'daemon_ids','[]'::jsonb)<>'[]'::jsonb OR COALESCE(i.event_filter->'agent_types','[]'::jsonb)<>'[]'::jsonb)
    THEN RETURN QUERY SELECT 'revoked','0',i.authorization_epoch::text,'0';RETURN;END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(i.event_filter->'daemon_ids','[]'::jsonb)||COALESCE(i.event_filter->'agent_types','[]'::jsonb)) entry WHERE jsonb_typeof(entry) <> 'string')
    OR (COALESCE(i.event_filter->'daemon_ids','[]'::jsonb)<>'[]'::jsonb AND NOT (i.event_filter->'daemon_ids' ? s.daemon_id))
    OR (COALESCE(i.event_filter->'agent_types','[]'::jsonb)<>'[]'::jsonb AND (s.agent_type IS NULL OR NOT (i.event_filter->'agent_types' ? s.agent_type)))
    THEN RETURN QUERY SELECT 'revoked','0',i.authorization_epoch::text,'0';RETURN;END IF;
   `}
   IF s.content_state IN('deleting','deleted') THEN RETURN QUERY SELECT 'deleted','0',i.authorization_epoch::text,'0';RETURN;END IF;
   SELECT sum(revision)+COALESCE((native->>'revision')::bigint,0) AS revision,sum(work.storage_revision) AS storage_revision INTO w
    FROM shared.memory_source_work work WHERE source_kind=p_kind AND root_key IN(SELECT owner_id::text||':'||id FROM unnest(session_ids) id);
   IF w.revision IS NULL THEN RETURN QUERY SELECT 'changed','0',i.authorization_epoch::text,'0';RETURN;END IF;
   IF NOT FOUND THEN RETURN QUERY SELECT 'changed','0',i.authorization_epoch::text,'0';RETURN;END IF;
   RETURN QUERY SELECT 'current',w.revision::text,i.authorization_epoch::text,
    (w.storage_revision+COALESCE((SELECT rights.revision FROM shared.memory_local_source_rights rights WHERE rights.installation_id=i.installation_id),0))::text;
  END $$`
/** Personal canonical-event and explicit personal archive authority. Each
 * body adapter remains separate; unsupported kinds cannot fall through. */
export const SHARED_SOURCE_READER_FUNCTIONS=[
 `ALTER TABLE shared.memory_source_work ADD COLUMN IF NOT EXISTS storage_revision BIGINT NOT NULL DEFAULT 0 CHECK(storage_revision>=0)`,
 personalAuthority(false),
 personalAuthority(true),
 `REVOKE ALL ON FUNCTION shared.memory_retained_relay_authority(JSONB,TEXT,TEXT) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.read_memory_relay_sources(p_scope JSONB,p_root TEXT,p_after BIGINT,p_limit INT,p_ids BIGINT[])
  RETURNS SETOF JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE a RECORD;native JSONB;selected_mode BOOLEAN;keyed_mode BOOLEAN;metadata_only BOOLEAN;input_fingerprint TEXT;observation JSONB;BEGIN
   selected_mode=COALESCE(p_ids IS NOT NULL AND p_ids[1] IN(-1,-2),FALSE);metadata_only=selected_mode AND p_ids[1]=-2;keyed_mode=selected_mode AND cardinality(p_ids)>1;
   IF p_ids IS NOT NULL AND NOT selected_mode AND EXISTS(SELECT 1 FROM unnest(p_ids) k WHERE k<0) THEN RAISE EXCEPTION 'invalid_source_metadata_request';END IF;
   IF selected_mode THEN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 OR p_after IS NOT NULL AND p_after<0 OR array_ndims(p_ids)<>1 OR array_lower(p_ids,1)<>1 OR cardinality(p_ids)>257 OR array_position(p_ids,NULL) IS NOT NULL
     OR EXISTS(SELECT 1 FROM unnest(p_ids[2:]) k WHERE k<=0)
     OR (SELECT count(*) FROM unnest(p_ids[2:]))<>(SELECT count(DISTINCT k) FROM unnest(p_ids[2:]) k)
     OR EXISTS(SELECT 1 FROM(SELECT k,lag(k) OVER(ORDER BY n) AS previous FROM unnest(p_ids[2:]) WITH ORDINALITY x(k,n)) ordered WHERE k<=previous)
     OR metadata_only AND NOT keyed_mode OR keyed_mode AND(p_after IS NOT NULL OR p_limit<>cardinality(p_ids)-1) THEN RAISE EXCEPTION 'invalid_source_metadata_request';END IF;
   END IF;
   IF p_limit NOT BETWEEN 1 AND 256 OR p_ids IS NOT NULL AND NOT selected_mode AND cardinality(p_ids)>256 THEN RAISE EXCEPTION 'source_page_limit';END IF;
   SELECT * INTO a FROM shared.memory_relay_source_authority(p_scope,'relay_event',p_root);
   IF a.state<>'current' THEN RAISE EXCEPTION 'source_%',a.state;END IF;
   native=public.native_session_authority(substr(p_root,strpos(p_root,':')+1),(p_scope->>'principalUserId')::int,NULL);
   IF selected_mode THEN
    IF NOT EXISTS(SELECT 1 FROM shared.memory_source_contract WHERE capture_version=2 AND header_version=1) THEN RAISE EXCEPTION 'source_metadata_proof_unavailable';END IF;
    input_fingerprint=${metadataInputFingerprint()};
    IF metadata_only THEN
     WITH admitted AS MATERIALIZED(
      SELECT e.id,${metadataRowLocator()} AS value,${metadataInputAdmission()} AS admission FROM public.events e
      LEFT JOIN memory.source_events r ON r.installation_id=(p_scope->>'installationId')::uuid AND r.source_kind='relay_event'
       AND r.canonical_key=e.id::text AND r.mapping_state='verified'
      WHERE e.id=ANY(p_ids[2:]) AND e.session_id=native->>'sessionId' AND e.user_id=(p_scope->>'principalUserId')::int
       AND NOT e.owner_retired AND e.effect_status IN('none','completed') AND public.native_event_authority(e.id,e.user_id)->>'state'='current'
       AND NOT(${metadataUsageDenied()})),observed AS(SELECT id,value,admission FROM admitted WHERE admission<>'denied' ORDER BY id LIMIT p_limit)
     SELECT jsonb_build_object('contract','personal-metadata-observation-v1','version',jsonb_build_object('content',a.content_revision,'authorization',a.authorization_revision,'storage',a.storage_revision),
      'inputFingerprint',input_fingerprint,'nativeSessionFingerprint',encode(sha256(convert_to(native::text,'UTF8')),'hex'),
      'upperId',COALESCE((SELECT boundary.id::text FROM public.events boundary WHERE boundary.session_id=native->>'sessionId' ORDER BY boundary.id DESC LIMIT 1),'0'),
      'rows',COALESCE((SELECT jsonb_agg(value ORDER BY id) FROM observed),'[]'::jsonb),'admissions',COALESCE((SELECT jsonb_agg(admission ORDER BY id) FROM observed),'[]'::jsonb)) INTO observation;
     IF observation->'admissions' ? 'unsupported' THEN RAISE EXCEPTION 'source_metadata_proof_unavailable';END IF;
     IF observation->'admissions' ? 'unproven' THEN RAISE EXCEPTION 'source_input_start_unproven';END IF;
     RETURN NEXT observation-'admissions';RETURN;
    END IF;
    WITH selected AS MATERIALIZED(
     SELECT event_row.*,event_row.xmin::text AS memory_source_xmin,input_admission.value AS memory_input_admission,legacy_fallback.required AS memory_legacy_fallback FROM(
      SELECT id FROM public.events WHERE session_id=native->>'sessionId' AND(p_after IS NULL OR id>p_after)
       AND(NOT keyed_mode OR id=ANY(p_ids[2:])) ORDER BY id OFFSET 0)ordered
     CROSS JOIN LATERAL(SELECT event_body.*,event_body.xmin AS xmin FROM public.events event_body WHERE id=ordered.id OFFSET 0)event_row
     LEFT JOIN memory.source_events eligible_ref ON eligible_ref.installation_id=(p_scope->>'installationId')::uuid
      AND eligible_ref.source_kind='relay_event' AND eligible_ref.canonical_key=event_row.id::text AND eligible_ref.mapping_state='verified'
     CROSS JOIN LATERAL(SELECT ${metadataInputAdmission('event_row','eligible_ref','keyed_mode')} AS value OFFSET 0)input_admission
     CROSS JOIN LATERAL(SELECT CASE WHEN NOT keyed_mode THEN ${legacySelectionFallback('event_row','eligible_ref')} ELSE FALSE END AS required OFFSET 0)legacy_fallback
     WHERE NOT event_row.owner_retired AND event_row.user_id=(p_scope->>'principalUserId')::int
      AND public.native_event_authority(event_row.id,event_row.user_id)->>'state'='current'
      AND event_row.effect_status IN('none','completed')
      AND (legacy_fallback.required OR NOT(${metadataUsageDenied('event_row','eligible_ref')})) AND input_admission.value<>'denied'
     ORDER BY ordered.id LIMIT p_limit),legacy_required AS MATERIALIZED(
      SELECT 1 FROM selected WHERE memory_legacy_fallback LIMIT 1
     ),page AS(
      SELECT selected.*,sum(CASE WHEN payload IS NULL THEN 0 ELSE octet_length(payload::text) END) OVER(ORDER BY id) AS page_bytes
      FROM selected WHERE NOT EXISTS(SELECT 1 FROM legacy_required)
     ),observed AS(
     SELECT e.id,jsonb_build_object('id',e.id::text,'session_id',e.logical_source_session_id,'current_session_id',e.session_id,
      'event_type',e.event_type,'user_id',e.user_id::text,'occurred_at',e.created_at::text,
      'payload',CASE WHEN e.page_bytes<=33554432 THEN e.payload ELSE NULL END,'body_limit',e.page_bytes>33554432,
      'body_session_id',e.body_session_id,'body_storage',e.body_storage,'manifest_id',e.body_manifest_id,'ordinal',e.body_chunk_ordinal,
      'activity_epoch',e.body_activity_epoch::text,'body_owner_user_id',e.body_owner_user_id::text,
      'canonical_hash',COALESCE(e.canonical_payload_hash,encode(r.content_hash,'hex')),'source_header_version',e.source_header_version,
      'canonical_sequence',e.source_sequence::text,'ref_sequence',r.source_sequence::text,'ref_turn_id',COALESCE(r.turn_id,e.source_classification->'memory_source'->>'turn_id'),
      'provenance',COALESCE(r.source_provenance,CASE WHEN e.source_header_version=1 THEN jsonb_build_object('memory',e.source_classification->'memory_source') END),
      'classification',COALESCE(r.classification,e.source_classification),
      'header_ref_conflict',e.source_header_version=1 AND r.source_event_id IS NOT NULL AND
       (encode(r.content_hash,'hex') IS DISTINCT FROM e.canonical_payload_hash OR r.source_sequence IS NOT NULL AND r.source_sequence::text IS DISTINCT FROM e.source_sequence::text OR r.classification IS DISTINCT FROM e.source_classification),
      'journal_sequences',(SELECT jsonb_agg(j.source_seq::text ORDER BY j.source_seq) FROM public.extension_source_outbox j WHERE j.source_kind='canonical_event' AND j.source_id='event:'||e.id::text AND j.owner_user_id=e.user_id AND j.session_id=e.logical_source_session_id AND j.event_type=e.event_type),
      'retention_denied',FALSE,'input_admission',e.memory_input_admission,'metadata',${metadataRowLocator('e','r','e.memory_source_xmin')}) AS value
     FROM page e LEFT JOIN memory.source_events r ON r.installation_id=(p_scope->>'installationId')::uuid
      AND r.source_kind='relay_event' AND r.canonical_key=e.id::text AND r.mapping_state='verified')
    SELECT jsonb_build_object('contract','personal-metadata-observation-v1','version',jsonb_build_object('content',a.content_revision,'authorization',a.authorization_revision,'storage',a.storage_revision),
     'inputFingerprint',input_fingerprint,'nativeSessionFingerprint',encode(sha256(convert_to(native::text,'UTF8')),'hex'),
     'upperId',COALESCE((SELECT boundary.id::text FROM public.events boundary WHERE boundary.session_id=native->>'sessionId' ORDER BY boundary.id DESC LIMIT 1),'0'),
     'rows',COALESCE((SELECT jsonb_agg(value ORDER BY id) FROM observed),'[]'::jsonb),
      'legacyFallback',EXISTS(SELECT 1 FROM legacy_required)) INTO observation;
    IF (observation->>'legacyFallback')::boolean THEN RAISE EXCEPTION 'source_metadata_proof_unavailable';END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(observation->'rows') row WHERE row->>'input_admission'='unsupported') THEN RAISE EXCEPTION 'source_metadata_proof_unavailable';END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(observation->'rows') row WHERE row->>'input_admission'='unproven') THEN RAISE EXCEPTION 'source_input_start_unproven';END IF;
    RETURN NEXT observation-'legacyFallback';RETURN;
   END IF;
   RETURN QUERY WITH selected AS (SELECT e.*,(${usageDenied('e','eligible_ref')}) AS memory_usage_denied
      -- Keep identity enumeration ordered and narrow before evaluating the
      -- native/input/retention guards. A bitmap+sort over wide event rows would
      -- run those guards for the whole Session before producing one page.
      -- OFFSET 0 preserves both subquery boundaries on generic cached plans;
      -- eligibility still runs before the only page LIMIT below.
      FROM(SELECT id FROM public.events WHERE session_id=native->>'sessionId'
       AND(p_after IS NULL OR id>p_after) AND(p_ids IS NULL OR id=ANY(p_ids))
       ORDER BY id OFFSET 0)ordered
      CROSS JOIN LATERAL(SELECT * FROM public.events WHERE id=ordered.id OFFSET 0)e
      LEFT JOIN memory.source_events eligible_ref ON eligible_ref.installation_id=(p_scope->>'installationId')::uuid
       AND eligible_ref.source_kind='relay_event' AND eligible_ref.canonical_key=e.id::text AND eligible_ref.mapping_state='verified'
      WHERE NOT e.owner_retired AND public.native_event_authority(e.id,(p_scope->>'principalUserId')::int)->>'state'='current'
       AND e.user_id=(p_scope->>'principalUserId')::int AND e.session_id=native->>'sessionId'
       AND shared.memory_relay_input_admitted(p_scope,e.id,p_ids IS NOT NULL)
       AND e.effect_status IN('none','completed') AND (p_after IS NULL OR e.id>p_after) AND (p_ids IS NULL OR e.id=ANY(p_ids))
       AND(p_ids IS NOT NULL OR NOT(${usageDenied('e','eligible_ref')}))
       ORDER BY ordered.id LIMIT p_limit), page AS (SELECT selected.*,sum(CASE WHEN memory_usage_denied OR payload IS NULL THEN 0 ELSE octet_length(payload::text) END) OVER(ORDER BY id) AS page_bytes FROM selected)
    SELECT jsonb_build_object('id',e.id::text,'session_id',e.logical_source_session_id,'current_session_id',e.session_id,'event_type',e.event_type,'user_id',e.user_id::text,'occurred_at',to_jsonb(e)->>'created_at',
      'payload',CASE WHEN NOT(${usageDenied('e','r')}) AND e.page_bytes<=33554432 THEN e.payload ELSE NULL END,'body_limit',e.page_bytes>33554432,
      'body_session_id',e.body_session_id,'body_storage',COALESCE(to_jsonb(e)->>'body_storage','hot'),'manifest_id',to_jsonb(e)->>'body_manifest_id','ordinal',to_jsonb(e)->>'body_chunk_ordinal',
      'activity_epoch',to_jsonb(e)->>'body_activity_epoch','body_owner_user_id',to_jsonb(e)->>'body_owner_user_id','canonical_hash',COALESCE(to_jsonb(e)->>'canonical_payload_hash',encode(r.content_hash,'hex')),
      'source_header_version',to_jsonb(e)->>'source_header_version',
      'canonical_sequence',to_jsonb(e)->>'source_sequence','ref_sequence',r.source_sequence::text,
      'ref_turn_id',CASE WHEN r.source_event_id IS NOT NULL THEN r.turn_id WHEN to_jsonb(e)->>'source_header_version'='1' THEN to_jsonb(e)->'source_classification'->'memory_source'->>'turn_id' END,
      'provenance',CASE WHEN r.source_event_id IS NOT NULL THEN r.source_provenance WHEN to_jsonb(e)->>'source_header_version'='1' THEN jsonb_build_object('memory',to_jsonb(e)->'source_classification'->'memory_source') END,
      'classification',CASE WHEN r.source_event_id IS NOT NULL THEN r.classification WHEN to_jsonb(e)->>'source_header_version'='1' THEN to_jsonb(e)->'source_classification' END,
      'header_ref_conflict',to_jsonb(e)->>'source_header_version'='1' AND r.source_event_id IS NOT NULL AND
       (r.content_hash IS NOT NULL AND encode(r.content_hash,'hex') IS DISTINCT FROM to_jsonb(e)->>'canonical_payload_hash'
        OR r.source_sequence IS NOT NULL AND r.source_sequence::text IS DISTINCT FROM to_jsonb(e)->>'source_sequence'
        OR r.classification IS DISTINCT FROM to_jsonb(e)->'source_classification'),
      'journal_sequences',(SELECT jsonb_agg(j.source_seq::text ORDER BY j.source_seq) FROM public.extension_source_outbox j WHERE j.source_kind='canonical_event' AND j.source_id='event:'||e.id::text AND j.owner_user_id=e.user_id AND j.session_id=e.logical_source_session_id AND j.event_type=e.event_type),
      'retention_denied',(${usageDenied('e','r')}))
    FROM page e LEFT JOIN memory.source_events r ON r.installation_id=(p_scope->>'installationId')::uuid AND r.source_kind='relay_event' AND r.canonical_key=e.id::text AND r.mapping_state='verified'
    ORDER BY e.id;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.read_memory_relay_archive(p_scope JSONB,p_root TEXT,p_manifest UUID,p_ordinal INT)
  RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE a RECORD;result JSONB;native JSONB;BEGIN
   SELECT * INTO a FROM shared.memory_relay_source_authority(p_scope,'relay_event',p_root);
   IF a.state<>'current' THEN RAISE EXCEPTION 'source_%',a.state;END IF;
   native=public.native_session_authority(substr(p_root,strpos(p_root,':')+1),(p_scope->>'principalUserId')::int,NULL);
   SELECT jsonb_build_object('user_id',m.user_id,'session_id',m.session_id,'activity_epoch',m.activity_epoch::text,'manifest_id',m.manifest_id::text,
      'schema_version',m.schema_version,'codec',m.codec,'state',m.state,'storage_namespace',m.storage_namespace,
      'ordinal',c.ordinal,'object_key',c.object_key,'first_event_id',c.first_event_id::text,'last_event_id',c.last_event_id::text,'event_count',c.event_count,
      'raw_bytes',c.raw_bytes::text,'compressed_bytes',c.compressed_bytes::text,'raw_sha256',c.raw_sha256,'compressed_sha256',c.compressed_sha256)
     INTO result FROM public.session_archive_manifests m JOIN public.session_archive_chunks c USING(manifest_id)
     WHERE m.manifest_id=p_manifest AND c.ordinal=p_ordinal AND m.user_id=(p_scope->>'principalUserId')::int AND m.state='published'
      AND EXISTS(SELECT 1 FROM public.events e LEFT JOIN memory.source_events r ON r.installation_id=(p_scope->>'installationId')::uuid AND r.source_kind='relay_event' AND r.canonical_key=e.id::text AND r.mapping_state='verified' WHERE NOT e.owner_retired AND public.native_event_authority(e.id,m.user_id)->>'state'='current' AND e.user_id=m.user_id AND e.session_id=native->>'sessionId'
        AND shared.memory_relay_input_admitted(p_scope,e.id,TRUE)
        AND e.body_storage='cold' AND e.body_manifest_id=m.manifest_id AND e.body_chunk_ordinal=c.ordinal
        AND e.body_owner_user_id=m.user_id AND e.body_session_id=m.session_id AND e.body_activity_epoch=m.activity_epoch
        AND NOT(${usageDenied('e','r')}))
      ;
   RETURN result;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_relay_source_authority(JSONB,TEXT,TEXT),shared.read_memory_relay_sources(JSONB,TEXT,BIGINT,INT,BIGINT[]),shared.read_memory_relay_archive(JSONB,TEXT,UUID,INT) FROM PUBLIC`,
] as const
