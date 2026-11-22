// Scope usage is separate from canonical custody. Enumerating eligible input
// must skip expired use before LIMIT; explicit keys remain denied references.
const sourceTurn=(e:string,r:string)=>`COALESCE(${r}.turn_id,${e}.payload->>'turn_id',${e}.payload->>'source_turn_id',CASE WHEN to_jsonb(${e})->>'source_header_version'='1' THEN to_jsonb(${e})->'source_classification'->'memory_source'->>'turn_id' END)`
export const relaySourceUsageDeniedSql=(e:string,r:string,scope='p_scope')=>`${r}.body_reclaimed_at IS NOT NULL OR EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts receipt WHERE receipt.installation_id=(${scope}->>'installationId')::uuid AND receipt.session_id=COALESCE(to_jsonb(${e})->>'logical_source_session_id',${e}.session_id) AND(receipt.turn_id=${sourceTurn(e,r)} OR ${sourceTurn(e,r)} IS NULL))`
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
   IF p_kind='legacy_archive' AND NOT EXISTS(SELECT 1 FROM shared.memory_archive_records archive
     WHERE archive.installation_id=i.installation_id AND archive.owner_user_id=owner_id AND archive.session_id=session_key)
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
 `REVOKE ALL ON FUNCTION shared.memory_relay_source_authority(JSONB,TEXT,TEXT) FROM PUBLIC`,
 `DROP FUNCTION IF EXISTS shared.scan_memory_relay_projection_page(JSONB,TEXT,BIGINT,INT),
  shared.read_memory_relay_sources(JSONB,TEXT,BIGINT,INT,BIGINT[]),shared.read_memory_relay_archive(JSONB,TEXT,UUID,INT) RESTRICT`,
] as const
