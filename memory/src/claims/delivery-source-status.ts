import type pg from 'pg'
import { candidateDeliverySource } from './review-service.js'
import { currentClaimVersionSql } from './version-selection.js'

/** A personal, grant-scoped snapshot. Relay capture is not extraction or review.
 * A single SQL statement prevents mixing pre-withdrawal and post-withdrawal rows.
 * Never consult a global withdrawal identity until owned provenance is present. */
export async function deliverySourceStatus(pool: Pick<pg.Pool, 'query'>, input: {
  installationId: string; submissionId: string; decisionId: string
}) {
  const identity = JSON.stringify({ source_kind: 'team_session', source_version: 2,
    accepted_delivery: { submission_id: input.submissionId, decision_id: input.decisionId } })
  const result = await pool.query(`WITH
    personal AS (SELECT 1 FROM memory_owner_scopes WHERE installation_id=$1 AND owner_scope_kind='personal'),
    episodes AS (
      SELECT e.* FROM work_episodes e WHERE e.installation_id=$1 AND EXISTS(SELECT 1 FROM personal)
        AND e.summary->'references'->'source' @> $2::jsonb
    ),
    evidence AS (
      SELECT e.* FROM knowledge_evidence e WHERE e.installation_id=$1 AND EXISTS(SELECT 1 FROM personal)
        AND e.locator->'source_provenance' @> $2::jsonb
    ),
    provenance AS (
      SELECT summary->'references'->'source' AS source FROM episodes
      UNION ALL SELECT locator->'source_provenance' FROM evidence
      UNION ALL SELECT source_provenance FROM source_events
        WHERE installation_id=$1 AND EXISTS(SELECT 1 FROM personal) AND source_provenance @> $2::jsonb
    ),
    candidates AS (
      SELECT c.status, (r.episode_source_digest=e.source_digest AND NOT EXISTS(
        SELECT 1 FROM memory_feed_inbox gap WHERE gap.installation_id=e.installation_id AND gap.session_id=e.session_id
          AND gap.error_code='oversized_content' AND gap.projection_state='quarantined'
          AND (gap.turn_id IS NULL OR gap.turn_id=e.turn_id))) AS fresh
      FROM memory_candidates c JOIN episodes e ON e.installation_id=c.installation_id AND e.episode_id=c.episode_id
      JOIN memory_extraction_runs r ON r.installation_id=c.installation_id AND r.run_id=c.run_id
    ),
    personal_claims AS (
      SELECT DISTINCT c.claim_id, (${currentClaimVersionSql('c', 'v')}
        AND c.state='active' AND (v.valid_from IS NULL OR v.valid_from<=clock_timestamp())
        AND (v.valid_until IS NULL OR v.valid_until>clock_timestamp())) AS current
      FROM evidence e JOIN knowledge_versions v ON v.installation_id=e.installation_id AND v.version_id=e.version_id
      JOIN knowledge_claims c ON c.installation_id=v.installation_id AND c.claim_id=v.claim_id
      WHERE v.authority IN ('user_accepted','user_corrected')
    )
    SELECT (SELECT source FROM provenance LIMIT 1) AS source,
      NOT EXISTS(SELECT 1 FROM provenance WHERE NOT memory_delivery_source_available(source)) AS available,
      (SELECT count(*)::int FROM candidates WHERE status IN ('validated','conflict') AND fresh) AS pending,
      (SELECT count(*)::int FROM candidates WHERE status IN ('validated','conflict') AND NOT fresh) AS stale,
      (SELECT count(*)::int FROM candidates WHERE status='rejected') AS rejected,
      (SELECT count(DISTINCT claim_id)::int FROM personal_claims) AS confirmed,
      (SELECT count(DISTINCT claim_id)::int FROM personal_claims WHERE current) AS current,
      (SELECT r.state FROM memory_extraction_runs r JOIN episodes e
        ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id AND e.source_digest=r.episode_source_digest
        ORDER BY r.started_at DESC,r.run_id DESC LIMIT 1) AS extraction_state`, [input.installationId, identity])
  const row = result.rows[0]
  const source = candidateDeliverySource(row?.source, row?.available)
  // This is also the response for foreign/nonexistent identities, including global withdrawals.
  if (!source) return { source: null }
  return { source, candidates: { pending: source.state === 'available' ? row.pending : 0,
    stale: row.stale, rejected: row.rejected },
  personal_claims: { confirmed: row.confirmed, current: row.current },
  extraction_state: row.extraction_state as string | null }
}
