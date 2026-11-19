-- Bind installation UUID, session ID and turn ID in a read-only transaction.
-- Compare a deterministic sample of up to 32 projected personal Relay events
-- to the current controlled reader. An absent header is never a match.
WITH sample AS MATERIALIZED (
  SELECT event_type, canonical_key::bigint AS id, source_provenance->'memory' AS projected
    FROM memory.source_events
   WHERE installation_id = $1 AND session_id = $2 AND turn_id = $3
     AND source_kind = 'relay_event' AND mapping_state = 'verified'
   ORDER BY canonical_key LIMIT 32
), target AS MATERIALIZED (
  SELECT payload->'scope' AS scope, payload->'root'->>'key' AS root
    FROM memory.memory_jobs
   WHERE installation_id = $1 AND job_type = 'project_shared_source'
     AND payload->'scope'->>'ownerScopeKind' = 'personal'
     AND payload->'root'->>'kind' = 'relay_event'
     AND payload->'root'->>'key' = (payload->'scope'->>'principalUserId') || ':' || $2
   ORDER BY created_at DESC, job_id DESC LIMIT 1
), keys AS (
  SELECT array_agg(id ORDER BY id) AS ids FROM sample HAVING count(*) > 0
), headers AS MATERIALIZED (
  -- The reader prefers reference classification when present. Its independent
  -- header_ref_conflict comparison must succeed before using that as Relay proof.
  SELECT row->>'id' AS id, row->'header_ref_conflict' = 'false'::jsonb AS verified,
         row->'classification'->'memory_source' AS proof
    FROM target CROSS JOIN keys
   CROSS JOIN LATERAL shared.read_memory_relay_sources(
     target.scope, target.root, NULL, cardinality(ids), array_prepend(-1::bigint,ids)
   ) AS obs(value)
   CROSS JOIN LATERAL jsonb_array_elements(obs.value->'rows') AS entry(row)
   WHERE obs.value->>'contract' = 'personal-metadata-observation-v1'
     AND row->>'session_id' = $2 AND row->>'source_header_version' = '1'
)
SELECT count(*) AS sampled, (SELECT count(*) FROM target) AS stored_scopes,
       count(*) FILTER (WHERE h.verified) AS matched_headers,
       count(*) FILTER (WHERE h.id IS NOT NULL AND h.verified IS NOT TRUE) AS unverified_headers,
       count(*) FILTER (WHERE h.verified AND h.proof IS NULL) AS missing_header_proof,
       count(*) FILTER (WHERE h.verified AND h.proof IS DISTINCT FROM s.projected) AS projection_differences,
       count(*) FILTER (WHERE h.verified AND h.proof->'lineage_complete' = 'false'::jsonb) AS incomplete_at_relay,
       count(*) FILTER (WHERE h.verified AND s.event_type = 'turn_status' AND h.proof->'lineage_complete' = 'false'::jsonb)
         AS incomplete_status_at_relay,
       count(*) FILTER (WHERE s.projected->'lineage_complete' = 'false'::jsonb) AS incomplete_at_memory,
       count(*) FILTER (WHERE s.projected->>'skill_state' = 'skill') AS marked_skill
  FROM sample s LEFT JOIN headers h ON h.id = s.id::text;
