/** Original delivery identity is global across reader/installation copies.
 * Keep this content-free fence after personal installation deletion: a shared
 * reviewed copy can outlive its originating personal installation. */
export const DELIVERY_WITHDRAWAL_MIGRATION = { version: 68, statements: [
  `CREATE TABLE memory_team_delivery_withdrawals (
    team_id TEXT NOT NULL, team_session_id TEXT NOT NULL,
    submission_id UUID NOT NULL, decision_id UUID NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(team_id,team_session_id,submission_id,decision_id)
  )`,
  `CREATE FUNCTION memory_delivery_source_available(provenance JSONB) RETURNS boolean LANGUAGE SQL STABLE AS $$
    SELECT NOT EXISTS(SELECT 1 FROM memory_team_delivery_withdrawals w
      WHERE provenance->>'source_kind'='team_session' AND provenance->>'source_version'='2'
        AND w.team_id=provenance->>'team_id' AND w.team_session_id=provenance->>'team_session_id'
        AND w.submission_id::text=provenance->'accepted_delivery'->>'submission_id'
        AND w.decision_id::text=provenance->'accepted_delivery'->>'decision_id')
  $$`,
  `CREATE FUNCTION memory_delivery_version_available(scope UUID,version UUID) RETURNS boolean LANGUAGE SQL STABLE AS $$
    SELECT NOT EXISTS(SELECT 1 FROM knowledge_evidence e WHERE e.installation_id=scope AND e.version_id=version
      AND NOT memory_delivery_source_available(e.locator->'source_provenance'))
  $$`,
] } as const
