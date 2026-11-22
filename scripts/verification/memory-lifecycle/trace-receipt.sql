-- Bind installation UUID, logical session ID and turn ID. This read-only
-- diagnostic compares the stored dialogue locators with authorized native
-- members. It returns counts only and never retrieves message bodies.
WITH episode AS MATERIALIZED (
  SELECT summary, evidence_manifest->'dialogue' AS terminal
    FROM memory.work_episodes
   WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3 AND compiler_version='relay-turn-v1'
), locators AS (
  SELECT message->'reference' AS ref FROM episode
   CROSS JOIN LATERAL jsonb_array_elements(summary->'messages') message
  UNION ALL SELECT terminal FROM episode WHERE terminal IS NOT NULL
), members AS MATERIALIZED (
  SELECT id, kind, hash, proof FROM shared.memory_dialogue_members($1,$2,$3)
   WHERE kind IN ('user_text','agent_text','turn_status')
)
SELECT (SELECT count(*) FROM episode) AS compiled_turns, count(*) AS stored_locators,
       count(*) FILTER (WHERE m.id IS NULL) AS unavailable_members,
       count(*) FILTER (WHERE m.id IS NOT NULL AND m.hash IS NOT NULL AND m.hash = l.ref->>'eventHash'
         AND l.ref->>'session'=$2 AND l.ref->>'turn'=$3) AS matching_locators,
       count(*) FILTER (WHERE m.id IS NOT NULL AND m.hash IS DISTINCT FROM (l.ref->>'eventHash')) AS hash_differences,
       count(*) FILTER (WHERE m.proof->>'lineage_complete'='false') AS incomplete_at_relay,
       count(*) FILTER (WHERE m.proof->>'skill_state'='skill') AS marked_skill
  FROM locators l LEFT JOIN members m ON m.id=l.ref->>'event';
