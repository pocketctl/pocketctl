/** Only explicit, reviewed legacy_archive rows are canonical here. This is
 * not a payload fallback for missing Relay/Team identities. */
export const SHARED_LEGACY_ARCHIVE_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.read_memory_legacy_sources(p_scope JSONB,p_root TEXT,p_after UUID,p_limit INT,p_ids UUID[],p_body BOOLEAN)
  RETURNS SETOF JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE a RECORD;BEGIN
   IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 OR p_ids IS NOT NULL AND cardinality(p_ids)>256 OR p_body IS NULL THEN RAISE EXCEPTION 'source_page_limit';END IF;
   SELECT * INTO a FROM shared.memory_relay_source_authority(p_scope,'legacy_archive',p_root);
   IF a.state<>'current' THEN RAISE EXCEPTION 'source_%',a.state;END IF;
   RETURN QUERY WITH selected AS(SELECT s.*,EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts receipt WHERE receipt.installation_id=s.installation_id AND receipt.session_id=s.session_id AND(receipt.turn_id=s.turn_id OR s.turn_id IS NULL)) AS retention_denied FROM shared.memory_archive_records s
    WHERE s.installation_id=(p_scope->>'installationId')::uuid
     AND s.owner_user_id=(p_scope->>'principalUserId')::int AND s.session_id=substr(p_root,strpos(p_root,':')+1)
     AND (p_after IS NULL OR s.source_event_id>p_after) AND(p_ids IS NULL OR s.source_event_id=ANY(p_ids))
    ORDER BY s.source_event_id LIMIT p_limit), bounded AS(SELECT selected.*,
     sum(CASE WHEN p_body AND NOT retention_denied AND body_reclaimed_at IS NULL THEN octet_length(payload::text) ELSE 0 END) OVER(ORDER BY source_event_id) AS page_bytes FROM selected)
   SELECT jsonb_build_object('id',s.source_event_id::text,'session_id',s.session_id,'turn_id',s.turn_id,'event_type',s.event_type,
    'hash',encode(s.content_hash,'hex'),'stored_hash',encode(s.payload_hash,'hex'),'origin',s.origin,'origin_position',s.origin_position,'occurred_at',s.occurred_at,'classification',s.classification,'provenance',s.source_provenance,
    'sequence',s.source_sequence::text,'manifest_hash',s.manifest_hash,'adapter_version','legacy-archive-v1',
    'reclaimed',s.body_reclaimed_at IS NOT NULL OR s.retention_denied,'body_limit',s.page_bytes>33554432,
    'payload',CASE WHEN p_body AND NOT s.retention_denied AND s.body_reclaimed_at IS NULL AND s.page_bytes<=33554432 THEN s.payload ELSE NULL END) FROM bounded s ORDER BY s.source_event_id;
  END $$`,
 `CREATE OR REPLACE FUNCTION shared.memory_archive_reference_headers(p_install UUID,p_ids UUID[])
 RETURNS TABLE(source_event_id UUID,installation_id UUID,session_id TEXT,turn_id TEXT,origin TEXT,origin_position TEXT,
  event_type TEXT,occurred_at TIMESTAMPTZ,payload_hash BYTEA,classification JSONB,source_provenance JSONB,
  body_reclaimed_at TIMESTAMPTZ,row_version TEXT,source_version JSONB,source_kind TEXT,canonical_key TEXT,mapping_state TEXT,content_hash BYTEA)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'source_page_limit'; END IF;
  RETURN QUERY SELECT a.source_event_id,a.installation_id,a.session_id,a.turn_id,a.origin,a.origin_position,
   a.event_type,a.occurred_at,a.payload_hash,a.classification,a.source_provenance,a.body_reclaimed_at,
   a.xmin::text,a.source_version,'legacy_archive',a.source_event_id::text,'verified',a.content_hash
   FROM shared.memory_archive_records a JOIN public.extension_installations i ON i.installation_id=a.installation_id
   JOIN shared.memory_source_modes m ON m.installation_id=a.installation_id
   WHERE a.installation_id=p_install AND a.source_event_id=ANY(p_ids) AND i.owner_scope_kind='personal' AND i.owner_user_id=a.owner_user_id
    AND EXISTS(SELECT 1 FROM shared.memory_retained_relay_authority(jsonb_build_object(
     'installationId',i.installation_id,'principalUserId',i.owner_user_id::text,'ownerScopeKind','personal',
     'ownerScopeId',i.owner_scope_id,'authorizationRevision',i.authorization_epoch::text,'configVersion',i.config_version::text,
     'modeGeneration',m.generation::text),'legacy_archive',a.owner_user_id::text||':'||a.session_id) v WHERE v.state='current')
   ORDER BY a.source_event_id;
 END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_archive_reference_headers(UUID,UUID[]) FROM PUBLIC`,
 `REVOKE ALL ON FUNCTION shared.read_memory_legacy_sources(JSONB,TEXT,UUID,INT,UUID[],BOOLEAN) FROM PUBLIC`,
] as const
