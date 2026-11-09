/** Only explicit, reviewed legacy_archive rows are canonical here. This is
 * not a payload fallback for missing Relay/Team identities. */
export const SHARED_LEGACY_ARCHIVE_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.read_memory_legacy_sources(p_scope JSONB,p_root TEXT,p_after UUID,p_limit INT,p_ids UUID[],p_body BOOLEAN)
  RETURNS SETOF JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ DECLARE a RECORD;BEGIN
   IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256 OR p_ids IS NOT NULL AND cardinality(p_ids)>256 OR p_body IS NULL THEN RAISE EXCEPTION 'source_page_limit';END IF;
   SELECT * INTO a FROM shared.memory_relay_source_authority(p_scope,'legacy_archive',p_root);
   IF a.state<>'current' THEN RAISE EXCEPTION 'source_%',a.state;END IF;
   RETURN QUERY WITH selected AS(SELECT s.*,EXISTS(SELECT 1 FROM memory.memory_source_retention_receipts receipt WHERE receipt.installation_id=s.installation_id AND receipt.session_id=s.session_id AND(receipt.turn_id=s.turn_id OR s.turn_id IS NULL)) AS retention_denied FROM memory.source_events s
    WHERE s.installation_id=(p_scope->>'installationId')::uuid AND s.source_kind='legacy_archive' AND s.mapping_state='verified'
     AND s.legacy_owner_user_id=(p_scope->>'principalUserId')::int AND s.canonical_session_key=substr(p_root,strpos(p_root,':')+1)
     AND s.canonical_key=s.source_event_id::text AND s.adapter_version='legacy-archive-v1' AND s.legacy_manifest_hash IS NOT NULL
     AND left(s.session_id,5)<>'team_' AND s.origin IN('feed','snapshot') AND NOT(s.source_provenance ? 'team') AND NOT(s.source_provenance ? 'accepted_delivery')
     AND (p_after IS NULL OR s.source_event_id>p_after) AND(p_ids IS NULL OR s.source_event_id=ANY(p_ids))
    ORDER BY s.source_event_id LIMIT p_limit), bounded AS(SELECT selected.*,
     sum(CASE WHEN p_body AND NOT retention_denied AND body_reclaimed_at IS NULL THEN octet_length(payload::text) ELSE 0 END) OVER(ORDER BY source_event_id) AS page_bytes FROM selected)
   SELECT jsonb_build_object('id',s.source_event_id::text,'session_id',s.session_id,'turn_id',s.turn_id,'event_type',s.event_type,
    'hash',encode(s.content_hash,'hex'),'stored_hash',encode(s.payload_hash,'hex'),'origin',s.origin,'origin_position',s.origin_position,'occurred_at',s.occurred_at,'classification',s.classification,'provenance',s.source_provenance,
    'sequence',s.source_sequence::text,'manifest_hash',s.legacy_manifest_hash,'adapter_version',s.adapter_version,
    'reclaimed',s.body_reclaimed_at IS NOT NULL OR s.retention_denied,'body_limit',s.page_bytes>33554432,
    'payload',CASE WHEN p_body AND NOT s.retention_denied AND s.body_reclaimed_at IS NULL AND s.page_bytes<=33554432 THEN s.payload ELSE NULL END) FROM bounded s ORDER BY s.source_event_id;
  END $$`,
 `REVOKE ALL ON FUNCTION shared.read_memory_legacy_sources(JSONB,TEXT,UUID,INT,UUID[],BOOLEAN) FROM PUBLIC`,
] as const
