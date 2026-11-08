/** Aggregate metadata only: no root/installation identity, body or SQL text. */
export const SHARED_SOURCE_HEALTH_FUNCTIONS=[
 `CREATE OR REPLACE FUNCTION shared.memory_source_health() RETURNS JSONB
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,shared AS $$ BEGIN
   RETURN (SELECT jsonb_build_object('ready',COALESCE((SELECT activation_ready FROM shared.memory_source_contract WHERE singleton),FALSE),
    'roots',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM(SELECT source_kind AS kind,
      CASE WHEN dead_at IS NOT NULL THEN 'dead' WHEN lease_token IS NOT NULL AND lease_until>clock_timestamp() THEN 'leased' ELSE 'pending' END AS state,
      count(*)::text AS count,greatest(0,extract(epoch FROM clock_timestamp()-min(COALESCE(dirty_since,updated_at))))::text AS oldest_seconds
      FROM shared.memory_source_work WHERE processed_revision<revision GROUP BY source_kind,state)r),'[]'::jsonb),
    'modes',COALESCE((SELECT jsonb_agg(to_jsonb(m)) FROM(SELECT COALESCE(m.mode,'legacy-feed') AS mode,count(*)::text AS count FROM memory.memory_installations i LEFT JOIN shared.memory_source_modes m USING(installation_id) GROUP BY COALESCE(m.mode,'legacy-feed'))m),'[]'::jsonb),
    'copies',(SELECT jsonb_agg(jsonb_build_object('table',relation,'bytes',pg_total_relation_size(('memory.'||relation)::regclass)::text))
      FROM unnest(ARRAY['source_events','source_artifacts','memory_feed_inbox','memory_snapshot_events'])relation)));
  END $$`,
 `REVOKE ALL ON FUNCTION shared.memory_source_health() FROM PUBLIC`,
] as const
