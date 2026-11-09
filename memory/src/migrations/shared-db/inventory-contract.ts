/** Bounded native equivalent of the existing provider v2 inventory. It
 * exposes current metadata only, never credentials, bodies or public tables. */
export const SHARED_NATIVE_INVENTORY_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_installation_inventory_page(p_after UUID,p_limit INT,p_revision BIGINT)
  RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$
  DECLARE clock_revision BIGINT;items JSONB;last_id UUID;count_items INT;result JSONB;BEGIN
   IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 128 OR p_revision IS NOT NULL AND p_revision<1 THEN RAISE EXCEPTION 'invalid_native_inventory_page';END IF;
   PERFORM shared.assert_memory_control_capture();
   clock_revision=shared.memory_source_control_snapshot()::bigint;
   IF clock_revision IS NULL OR p_revision IS NOT NULL AND p_revision<>clock_revision THEN RAISE EXCEPTION 'native_inventory_changed';END IF;
   IF EXISTS(SELECT 1 FROM public.extension_installations i WHERE i.provider_id='pocketctl-memory'
    AND(p_after IS NULL OR i.installation_id>p_after)
    AND(i.owner_scope_kind,i.owner_scope_id) IN(SELECT scope_kind,scope_id FROM public.extension_scope_memberships GROUP BY scope_kind,scope_id HAVING count(*)>256)
    AND EXISTS(SELECT 1 FROM shared.memory_source_contract c WHERE c.singleton AND(c.target_profile='full' OR i.installation_id=ANY(c.target_installations))))
    THEN RAISE EXCEPTION 'native_inventory_membership_limit';END IF;
   WITH page AS(
    SELECT i.installation_id,jsonb_build_object('installation_id',i.installation_id,'status',i.status,'config_version',i.config_version::text,
     'owner_scope_kind',i.owner_scope_kind,'owner_scope_id',i.owner_scope_id,
     'parent_organization_id',CASE WHEN i.owner_scope_kind='team' THEN t.organization_id ELSE NULL END,
     'authorization_epoch',CASE i.owner_scope_kind WHEN 'team' THEN t.authorization_epoch::text WHEN 'organization' THEN o.authorization_epoch::text ELSE i.authorization_epoch::text END,
     'scope_snapshot',CASE WHEN i.owner_scope_kind IN('team','organization') THEN jsonb_build_object(
      'state',CASE i.owner_scope_kind WHEN 'team' THEN t.state ELSE o.state END,
      'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('membership_id',m.membership_id,'membership_revision',m.membership_revision::text,'roles',m.roles,'state',m.state) ORDER BY m.membership_id)
       FROM public.extension_scope_memberships m WHERE m.scope_kind=i.owner_scope_kind AND m.scope_id=i.owner_scope_id),'[]'::jsonb)) ELSE NULL END,
     'granted_scopes',COALESCE(i.granted_scopes,'{}'::text[]),'subscriptions',COALESCE(i.subscriptions,'{}'::text[]),
     'enabled_services',COALESCE(i.enabled_services,'{}'::text[]),'event_filter',COALESCE(i.event_filter,'{}'::jsonb),
     'snapshot_required',c.snapshot_required_at IS NOT NULL,'created_at',i.created_at,'updated_at',i.updated_at) AS item
    FROM public.extension_installations i LEFT JOIN public.extension_checkpoints c USING(installation_id)
     LEFT JOIN public.extension_teams t ON i.owner_scope_kind='team' AND t.team_id=i.owner_scope_id
     LEFT JOIN public.extension_organizations o ON i.owner_scope_kind='organization' AND o.organization_id=i.owner_scope_id
    WHERE i.provider_id='pocketctl-memory' AND(p_after IS NULL OR i.installation_id>p_after)
     AND EXISTS(SELECT 1 FROM public.extension_providers p WHERE p.provider_id=i.provider_id AND p.status='enabled')
     AND EXISTS(SELECT 1 FROM shared.memory_source_contract contract WHERE contract.singleton AND(contract.target_profile='full' OR i.installation_id=ANY(contract.target_installations)))
    ORDER BY i.installation_id LIMIT p_limit)
   SELECT COALESCE(jsonb_agg(item ORDER BY installation_id),'[]'::jsonb),count(*)::int,(array_agg(installation_id ORDER BY installation_id DESC))[1] INTO items,count_items,last_id FROM page;
   result=jsonb_build_object('control_revision',clock_revision::text,'installations',items,'has_more',count_items=p_limit,'next_cursor',CASE WHEN count_items=p_limit THEN last_id ELSE NULL END);
   IF octet_length(result::text)>1048576 THEN RAISE EXCEPTION 'native_inventory_byte_limit';END IF;
   RETURN result;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_installation_inventory_page(UUID,INT,BIGINT) FROM PUBLIC`,
] as const
