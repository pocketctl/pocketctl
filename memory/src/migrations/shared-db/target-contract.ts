import type pg from 'pg'
export type SharedSourceTargetProfile='full'|'personal-relay-only'
/** Bounded trusted scope candidates. No event bodies or client-selected
 * principals; every candidate crosses the existing current authority adapter.
 * Revoked candidates still advance the scan cursor and carry an explicit state. */
export const SHARED_SOURCE_TARGET_FUNCTIONS=[
`CREATE OR REPLACE FUNCTION shared.enumerate_memory_source_targets(p_kind TEXT,p_root TEXT,p_after TEXT,p_limit INT)
 RETURNS TABLE(cursor_key TEXT,source_scope JSONB,target_mode TEXT,state TEXT,source_version JSONB)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
 DECLARE call_key TEXT;reader_id INT;BEGIN
  IF p_kind IS NULL OR p_kind NOT IN('relay_event','team_collaboration','team_delivery') OR p_root IS NULL OR length(p_root) NOT BETWEEN 1 AND 1024
   OR p_after IS NULL OR length(p_after)>2048 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'invalid_source_target_page';END IF;
  IF p_kind='relay_event' THEN
   IF split_part(p_root,':',1)!~'^[1-9][0-9]{0,9}$' OR strpos(p_root,':')=0 THEN RAISE EXCEPTION 'invalid_source_target_root';END IF;
   RETURN QUERY WITH candidates AS(
    SELECT i.installation_id::text AS key,m.mode,jsonb_build_object('installationId',i.installation_id::text,'principalUserId',i.owner_user_id::text,
     'ownerScopeKind',i.owner_scope_kind,'ownerScopeId',i.owner_scope_id::text,'authorizationRevision',i.authorization_epoch::text,
     'configVersion',i.config_version::text,'modeGeneration',m.generation::text) AS scope
    FROM public.extension_installations i JOIN shared.memory_source_modes m USING(installation_id)
     JOIN memory.memory_installations local USING(installation_id)
    WHERE i.provider_id='pocketctl-memory' AND i.owner_scope_kind='personal' AND i.owner_user_id=split_part(p_root,':',1)::int
     AND i.status='active' AND m.mode IN('shared-shadow','shared-active') AND local.relay_status='active'
     AND local.local_status NOT IN('purging','purged','integrity_error')
   ), page AS(SELECT * FROM candidates WHERE key COLLATE "C">p_after COLLATE "C" ORDER BY key COLLATE "C" LIMIT p_limit)
   SELECT page.key,page.scope,page.mode,a.state,jsonb_build_object('content',a.content_revision,'authorization',a.authorization_revision,'storage',a.storage_revision)
    FROM page CROSS JOIN LATERAL shared.memory_relay_source_authority(page.scope,p_kind,p_root) a ORDER BY page.key COLLATE "C";
   RETURN;
  END IF;
  call_key=p_root;
  IF p_kind='team_delivery' THEN
   SELECT s.source_call_id,r.reader_user_id INTO call_key,reader_id FROM public.team_delivery_memory_sources r
    JOIN public.team_task_submissions s USING(submission_id) WHERE r.source_session_id=p_root;
   IF NOT FOUND THEN RETURN;END IF;
  END IF;
  RETURN QUERY WITH candidates AS(
   SELECT DISTINCT i.installation_id::text||':'||lpad(p.user_id::text,10,'0')||':'||b.binding_id AS key,m.mode,b.binding_id,
    jsonb_build_object('installationId',i.installation_id::text,'principalUserId',p.user_id::text,'ownerScopeKind',i.owner_scope_kind,
     'ownerScopeId',i.owner_scope_id::text,'authorizationRevision',i.authorization_epoch::text,'configVersion',i.config_version::text,
     'modeGeneration',m.generation::text,'bindingRevision',b.revision::text,'participantRevision',p.revision::text) AS scope
   FROM public.collaboration_calls c JOIN public.collaboration_sessions s USING(team_session_id)
    JOIN public.team_memory_bindings b ON b.team_id=s.team_id AND b.state='active'
    JOIN public.collaboration_session_participants p ON p.team_session_id=s.team_session_id
    JOIN public.extension_installations i ON(i.owner_scope_kind='personal' AND i.owner_user_id=p.user_id
     OR i.owner_scope_kind IN('team','organization') AND i.installation_id=b.installation_id)
    JOIN shared.memory_source_modes m ON m.installation_id=i.installation_id
    JOIN memory.memory_installations local ON local.installation_id=i.installation_id
   WHERE c.call_id=call_key AND(reader_id IS NULL OR p.user_id=reader_id) AND i.provider_id='pocketctl-memory' AND i.status='active'
    AND m.mode IN('shared-shadow','shared-active') AND local.relay_status='active' AND local.local_status NOT IN('purging','purged','integrity_error')
  ),page AS(SELECT * FROM candidates WHERE key COLLATE "C">p_after COLLATE "C" ORDER BY key COLLATE "C" LIMIT p_limit)
  SELECT page.key,page.scope,page.mode,CASE WHEN a.state='current' AND a.context->>'bindingId' IS DISTINCT FROM page.binding_id THEN 'revoked' ELSE a.state END,
   jsonb_build_object('content',a.content_revision,'authorization',a.authorization_revision,'storage',a.storage_revision)
   FROM page CROSS JOIN LATERAL shared.memory_team_source_authority(page.scope,p_kind,p_root) a ORDER BY page.key COLLATE "C";
 END $$`,
`REVOKE ALL ON FUNCTION shared.enumerate_memory_source_targets(TEXT,TEXT,TEXT,INT) FROM PUBLIC`,
] as const

/** A finite deployment choice. The original Team implementation stays intact
 * but is not reachable from the personal Session release candidate. */
export function normalizeTargetInstallations(ids:readonly string[]|undefined):string[]{
 if(!ids||ids.length<1||ids.length>16||new Set(ids).size!==ids.length||ids.some(id=>!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)))throw Error('shared_source_launch_scope_mismatch')
 return [...ids].sort()
}
export function sharedSourceTargetFunctions(profile:SharedSourceTargetProfile,installations?:readonly string[]):readonly string[]{
 if(profile==='full')return SHARED_SOURCE_TARGET_FUNCTIONS
 if(profile!=='personal-relay-only')throw Error('unsupported_shared_source_target_profile')
 const ids=normalizeTargetInstallations(installations)
 const personal=(SHARED_SOURCE_TARGET_FUNCTIONS[0].split('\n  call_key=p_root;')[0]+'\n  RETURN;\n END $$')
  .replace("WHERE i.provider_id='pocketctl-memory'",`WHERE i.installation_id=ANY(ARRAY[${ids.map(id=>"'"+id+"'").join(',')}]::uuid[]) AND i.provider_id='pocketctl-memory'`)
 return [personal,SHARED_SOURCE_TARGET_FUNCTIONS[1]]
}

/** Verify the executable definition, not just a profile label. Runtime never
 * installs/repairs this function or gains native table privileges. */
export async function assertPersonalRelayTargetProfile(db:Pick<pg.Pool,'query'>,installations:readonly string[]):Promise<void>{
 const ids=normalizeTargetInstallations(installations)
 const body=sharedSourceTargetFunctions('personal-relay-only',ids)[0].split('AS $$')[1].slice(0,-2)
 const result=await db.query(`SELECT EXISTS(SELECT 1 FROM shared.memory_source_contract c
  WHERE c.singleton AND to_jsonb(c)->>'target_profile'='personal-relay-only' AND to_jsonb(c)->'target_installations'=$2::jsonb) AND EXISTS(
   SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('shared.enumerate_memory_source_targets(text,text,text,integer)')
    AND p.prosrc=$1 AND p.prosecdef AND p.provolatile='s' AND p.proretset
    AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='memory.memory_schema_migrations'::regclass)
    AND pg_get_function_result(p.oid)='TABLE(cursor_key text, source_scope jsonb, target_mode text, state text, source_version jsonb)'
    AND p.proconfig=ARRAY['search_path=pg_catalog, shared']::text[]) AS ready`,[body,JSON.stringify(ids)])
 if(result.rows[0]?.ready!==true)throw Error('shared_source_target_profile_mismatch')
}
