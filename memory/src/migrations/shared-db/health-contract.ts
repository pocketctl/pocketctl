/** Aggregate metadata only: no root/installation identity, body or SQL text. */
export const SHARED_SOURCE_HEALTH_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_missing_transport_relation(p_relation TEXT) RETURNS TEXT
  LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ BEGIN RAISE EXCEPTION 'source_health_relation_missing';END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_missing_transport_relation(TEXT) FROM PUBLIC`,
 `CREATE OR REPLACE FUNCTION shared.memory_source_health() RETURNS JSONB
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   RETURN (SELECT jsonb_build_object('ready',COALESCE((SELECT activation_ready FROM shared.memory_source_contract WHERE singleton),FALSE),
    'roots',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM(SELECT source_kind AS kind,
      CASE WHEN dead_at IS NOT NULL THEN 'dead' WHEN lease_token IS NOT NULL AND lease_until>clock_timestamp() THEN 'leased' ELSE 'pending' END AS state,
      count(*)::text AS count,greatest(0,extract(epoch FROM clock_timestamp()-min(COALESCE(dirty_since,updated_at))))::text AS oldest_seconds
      FROM shared.memory_source_work WHERE processed_revision<revision GROUP BY source_kind,state)r),'[]'::jsonb),
    'modes',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM(SELECT COALESCE(m.mode,'legacy-feed') AS mode,count(*)::text AS count FROM memory.memory_installations i LEFT JOIN shared.memory_source_modes m USING(installation_id) GROUP BY COALESCE(m.mode,'legacy-feed'))m),'[]'::jsonb),
    'copies',(SELECT jsonb_agg(jsonb_build_object('table',relation,'bytes',CASE WHEN to_regclass('memory.'||relation) IS NOT NULL THEN pg_total_relation_size(to_regclass('memory.'||relation))::text
       WHEN relation IN('memory_feed_inbox','memory_snapshot_events') AND (SELECT legacy_transport_retired FROM shared.memory_source_contract WHERE singleton) THEN '0'
       ELSE shared.memory_missing_transport_relation(relation) END))
      FROM unnest(ARRAY['source_events','source_artifacts','memory_feed_inbox','memory_snapshot_events'])relation)));
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_health() FROM PUBLIC`,
] as const
