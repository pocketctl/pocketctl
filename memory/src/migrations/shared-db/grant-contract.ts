/** Current Relay facts for already signature-verified grants. No bearer/JWT,
 * credentials or text enter the database function; local Memory state stays local. */
export const SHARED_GRANT_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_current_grant_states(p_installations UUID[],p_members UUID[])
  RETURNS TABLE(installation_id UUID,state JSONB)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   IF p_installations IS NULL OR cardinality(p_installations) NOT BETWEEN 1 AND 16 OR cardinality(p_members)>16 THEN RAISE EXCEPTION 'grant_scope_limit';END IF;
   RETURN QUERY SELECT i.installation_id,jsonb_build_object('status',i.status,'config_version',i.config_version::text,
    'provider_enabled',EXISTS(SELECT 1 FROM public.extension_providers provider WHERE provider.provider_id=i.provider_id AND provider.status='enabled'),
    'curation_input_allowed',i.granted_scopes @> ARRAY['session:events:read']::text[] AND i.enabled_services @> ARRAY['memory.manage']::text[],
    'owner_user_id',i.owner_user_id::text,'owner_scope_kind',i.owner_scope_kind,'owner_scope_id',i.owner_scope_id::text,
    'owner_exists',i.owner_scope_kind<>'personal' OR EXISTS(SELECT 1 FROM public.users u WHERE u.id=i.owner_user_id),
    'scope_state',CASE i.owner_scope_kind WHEN 'team' THEN t.state WHEN 'organization' THEN org.state ELSE 'active' END,
    'parent_state',CASE WHEN i.owner_scope_kind='team' THEN parent.state ELSE NULL END,
    'policy_contract_version',1,'parent_organization_id',t.organization_id::text,'parent_authorization_epoch',parent.authorization_epoch::text,
    'parent_installation',CASE WHEN parent_installation.installation_id IS NULL THEN NULL ELSE jsonb_build_object(
      'installation_id',parent_installation.installation_id::text,'status',parent_installation.status,
      'owner_scope_kind',parent_installation.owner_scope_kind,'owner_scope_id',parent_installation.owner_scope_id::text,
      'authorization_epoch',parent.authorization_epoch::text,'scope_state',parent.state) END,
    'authorization_epoch',CASE i.owner_scope_kind WHEN 'team' THEN t.authorization_epoch::text WHEN 'organization' THEN org.authorization_epoch::text ELSE i.authorization_epoch::text END,
    'member_user_id',member.user_id::text,'membership_id',member.membership_id::text,'membership_state',member.state,'membership_revision',member.membership_revision::text,'roles',member.roles,
    'member_exists',EXISTS(SELECT 1 FROM public.users u WHERE u.id=member.user_id))
   FROM public.extension_installations i LEFT JOIN public.extension_teams t ON i.owner_scope_kind='team' AND t.team_id=i.owner_scope_id
    LEFT JOIN public.extension_organizations parent ON parent.organization_id=t.organization_id
    LEFT JOIN public.extension_organizations org ON i.owner_scope_kind='organization' AND org.organization_id=i.owner_scope_id
    -- Prefer the unique live installation. A historical terminal installation
    -- still forbids silently falling back to the uninstalled organization floor.
    LEFT JOIN LATERAL(SELECT pi.* FROM public.extension_installations pi
      WHERE pi.provider_id='pocketctl-memory' AND pi.owner_scope_kind='organization' AND pi.owner_scope_id=t.organization_id
      ORDER BY (pi.status IN('pending','active','paused','revoking')) DESC,pi.created_at DESC,pi.installation_id LIMIT 1) parent_installation ON TRUE
    LEFT JOIN public.extension_scope_memberships member ON member.scope_kind=i.owner_scope_kind AND member.scope_id=i.owner_scope_id AND member.membership_id=ANY(p_members)
   WHERE i.installation_id=ANY(p_installations) AND i.provider_id='pocketctl-memory' ORDER BY i.installation_id,member.membership_id;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_current_grant_states(UUID[],UUID[]) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.lock_memory_grant_authority(p_installations UUID[],p_members UUID[])
  RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  BEGIN
   IF p_installations IS NULL OR cardinality(p_installations) NOT BETWEEN 1 AND 16 OR p_members IS NULL OR cardinality(p_members)>16
    OR array_position(p_installations,NULL) IS NOT NULL OR array_position(p_members,NULL) IS NOT NULL THEN RAISE EXCEPTION 'grant_scope_limit';END IF;
   -- NOWAIT is essential: Relay control writers have several existing row
   -- orders. Never wait while holding a partial authority set. The exception
   -- block releases every partial lock; success retains locks until COMMIT.
   BEGIN
    PERFORM i.installation_id FROM public.extension_installations i WHERE i.installation_id=ANY(p_installations) AND i.provider_id='pocketctl-memory'
     ORDER BY i.installation_id FOR SHARE OF i NOWAIT;
    IF (SELECT count(DISTINCT i.installation_id) FROM public.extension_installations i WHERE i.installation_id=ANY(p_installations) AND i.provider_id='pocketctl-memory')
      <> (SELECT count(DISTINCT id) FROM unnest(p_installations) id) THEN RAISE lock_not_available;END IF;
    PERFORM t.team_id FROM public.extension_teams t WHERE t.team_id IN(SELECT i.owner_scope_id FROM public.extension_installations i WHERE i.installation_id=ANY(p_installations) AND i.owner_scope_kind='team')
     ORDER BY t.team_id FOR SHARE OF t NOWAIT;
    PERFORM o.organization_id FROM public.extension_organizations o WHERE o.organization_id IN(
      SELECT i.owner_scope_id FROM public.extension_installations i WHERE i.installation_id=ANY(p_installations) AND i.owner_scope_kind='organization'
      UNION SELECT t.organization_id FROM public.extension_teams t JOIN public.extension_installations i ON i.owner_scope_kind='team' AND i.owner_scope_id=t.team_id WHERE i.installation_id=ANY(p_installations))
     ORDER BY o.organization_id FOR SHARE OF o NOWAIT;
    PERFORM m.membership_id FROM public.extension_scope_memberships m WHERE m.membership_id=ANY(p_members) AND EXISTS(
      SELECT 1 FROM public.extension_installations i WHERE i.installation_id=ANY(p_installations) AND i.owner_scope_kind=m.scope_kind AND i.owner_scope_id=m.scope_id)
     ORDER BY m.membership_id FOR SHARE OF m NOWAIT;
    PERFORM u.id FROM public.users u WHERE u.id IN(
      SELECT i.owner_user_id FROM public.extension_installations i WHERE i.installation_id=ANY(p_installations) AND i.owner_scope_kind='personal'
      UNION SELECT m.user_id FROM public.extension_scope_memberships m WHERE m.membership_id=ANY(p_members) AND EXISTS(
       SELECT 1 FROM public.extension_installations i WHERE i.installation_id=ANY(p_installations) AND i.owner_scope_kind=m.scope_kind AND i.owner_scope_id=m.scope_id))
     ORDER BY u.id FOR SHARE OF u NOWAIT;
    PERFORM p.provider_id FROM public.extension_providers p WHERE p.provider_id='pocketctl-memory' FOR SHARE OF p NOWAIT;
   EXCEPTION WHEN lock_not_available THEN RETURN FALSE;
   END;
   RETURN TRUE;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.lock_memory_grant_authority(UUID[],UUID[]) FROM PUBLIC`,
] as const
