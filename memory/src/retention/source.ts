import type pg from 'pg'
import { retentionTransaction,readRetentionPlan } from './transaction.js'

export interface SourceRetentionSettings {
  mode: 'off' | 'enabled'
  bodyDays: number
  batchSize: number
  /** Legacy standalone helper cadence; the production Worker uses daily maintenance. */
  intervalMs: number
  reportDirectory?: string
}
export interface SourceRetentionKey { installationId: string; sessionId: string; turnId: string; episodeId: string }
export interface SourceRetentionResult {
  events: number; artifacts: number; snapshots: number; candidates: number; episodes: number
  finished: boolean; skipped: string | null
}
export interface SourceRetentionReceipt {
  installation_id: string; session_id: string; turn_id: string; episode_id: string
  source_digest: Buffer; compiler_version: string; extraction_completed_at: Date; reclaimed_at: Date
}

export const MIGRATION_PROTECTS_SCOPE_SQL = `EXISTS(SELECT 1 FROM memory_governance_migration_runs m
  WHERE m.sealed_at IS NULL AND m.abandoned_at IS NULL AND m.details_reclaimed_at IS NULL
    AND (cardinality(m.scope_ids)=0 OR e.installation_id=ANY(m.scope_ids)))`

/** One row per current episode; LATERAL aggregates cannot multiply source rows. */
const eligibilityFrom = `FROM work_episodes e
  JOIN source_turns t ON t.installation_id=e.installation_id AND t.turn_id=e.turn_id
  JOIN memory_installations i ON i.installation_id=e.installation_id
  JOIN memory_feature_settings f ON f.installation_id=e.installation_id
  JOIN LATERAL(SELECT max(r.completed_at) completed_at FROM memory_extraction_runs r
    WHERE r.installation_id=e.installation_id AND r.episode_id=e.episode_id
      AND r.episode_source_digest=e.source_digest AND r.state='succeeded') success ON success.completed_at IS NOT NULL
  WHERE e.state='ready' AND e.body_reclaimed_at IS NULL AND e.compiled_at<=success.completed_at
    AND t.terminal_at IS NOT NULL AND t.state IN('completed','interrupted','failed','abandoned') AND t.updated_at<=success.completed_at
    AND i.local_status='ready' AND i.relay_status='active' AND NOT i.snapshot_required
    AND f.extraction_mode IN('enabled','shadow')
    AND success.completed_at<=statement_timestamp()-($1::int*INTERVAL '24 hours')
    AND NOT EXISTS(SELECT 1 FROM memory_source_retention_receipts a WHERE a.installation_id=e.installation_id AND a.turn_id=e.turn_id)
    AND NOT ${MIGRATION_PROTECTS_SCOPE_SQL}
    AND NOT EXISTS(SELECT 1 FROM memory_snapshot_runs r WHERE r.installation_id=e.installation_id
      AND (r.state='running' OR(r.state='completed' AND r.relay_acked_at IS NULL)))
    AND NOT EXISTS(SELECT 1 FROM memory_extraction_runs r WHERE r.installation_id=e.installation_id AND r.episode_id=e.episode_id
      AND r.episode_source_digest=e.source_digest AND r.state IN('running','failed','quarantined'))
    AND NOT EXISTS(SELECT 1 FROM memory_candidates c WHERE c.installation_id=e.installation_id AND c.episode_id=e.episode_id
      AND c.review_expires_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM source_events s WHERE s.installation_id=e.installation_id AND s.turn_id=e.turn_id
      AND s.created_at>success.completed_at)
    AND NOT EXISTS(SELECT 1 FROM memory_feed_inbox g WHERE g.installation_id=e.installation_id AND g.session_id=e.session_id
      AND (g.turn_id IS NULL OR g.turn_id=e.turn_id) AND(g.projection_state='pending'
        OR(g.projection_state='quarantined' AND g.error_code='oversized_content')))
    AND NOT EXISTS(SELECT 1 FROM memory_jobs j WHERE j.installation_id=e.installation_id AND j.state IN('pending','running')
      AND ((j.job_type IN('compile_episode','extract_candidates','extract_skill_candidate')
        AND(j.payload->>'turn_id'=e.turn_id OR j.payload->>'episode_id'=e.episode_id::text
          OR j.idempotency_key='compile_episode:'||e.turn_id)) OR j.job_type='snapshot_reconcile'))
    AND NOT EXISTS(SELECT 1 FROM knowledge_evidence k WHERE k.installation_id=e.installation_id AND
      (k.episode_id=e.episode_id OR EXISTS(SELECT 1 FROM source_events s WHERE s.installation_id=e.installation_id
        AND s.turn_id=e.turn_id AND s.source_event_id=k.source_event_id)
       OR EXISTS(SELECT 1 FROM source_artifacts a WHERE a.installation_id=e.installation_id
        AND a.turn_id=e.turn_id AND a.artifact_id=k.artifact_id)))
    AND NOT EXISTS(SELECT 1 FROM memory_skill_archives a WHERE a.installation_id=e.installation_id AND a.episode_id=e.episode_id)
    AND NOT EXISTS(SELECT 1 FROM memory_skill_task_runs r WHERE r.installation_id=e.installation_id AND r.episode_id=e.episode_id
      AND r.state NOT IN('cancelled','stale_generation'))
    AND NOT EXISTS(SELECT 1 FROM memory_skill_archive_sources k WHERE k.installation_id=e.installation_id AND
      (EXISTS(SELECT 1 FROM source_events s WHERE s.installation_id=e.installation_id AND s.turn_id=e.turn_id AND s.source_event_id=k.source_event_id)
       OR EXISTS(SELECT 1 FROM source_artifacts a WHERE a.installation_id=e.installation_id AND a.turn_id=e.turn_id AND a.artifact_id=k.artifact_id)))`

export interface RetentionPreviewCursor {installationId?:string;eligibleEpisodeId?:string;receiptInstallationId?:string;receiptTurnId?:string}
export async function previewSourceRetention(pool: pg.Pool, bodyDays = 14, limit = 20, cursor:RetentionPreviewCursor={}) {
  if (!Number.isInteger(bodyDays) || bodyDays < 14 || bodyDays > 365) throw new Error('invalid_source_retention_days')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_retention_preview_limit')
  return readRetentionPlan(pool,async client=>{
  const result = await client.query(`SELECT e.installation_id,e.session_id,e.turn_id,e.episode_id,
      success.completed_at AS extraction_completed_at ${eligibilityFrom}
    AND ($4::uuid IS NULL OR e.installation_id=$4::uuid) AND ($3::uuid IS NULL OR e.episode_id>$3::uuid) ORDER BY e.episode_id LIMIT $2`, [bodyDays, limit, cursor.eligibleEpisodeId??null,cursor.installationId??null])
  const pending = await client.query(`SELECT installation_id,session_id,turn_id,episode_id
    FROM memory_source_retention_receipts WHERE state='reclaiming' AND ($4::uuid IS NULL OR installation_id=$4::uuid)
      AND ($2::uuid IS NULL OR (installation_id,turn_id)>($2::uuid,$3::text))
      ORDER BY installation_id,turn_id LIMIT $1`, [limit,cursor.receiptInstallationId??null,cursor.receiptTurnId??null,cursor.installationId??null])
  return { eligible: result.rows, reclaiming: pending.rows, previewLimit: limit }
  })
}

function emptyResult(): SourceRetentionResult {
  return { events: 0, artifacts: 0, snapshots: 0, candidates: 0, episodes: 0, finished: false, skipped: null }
}

/** The receipt freezes all readers/ingress before the first bounded batch.
 * Interruption leaves a resumable reclaiming receipt, never an apparently
 * complete episode compiled from half-cleared sources. */
export async function reclaimSourceTurn(pool: pg.Pool, key: SourceRetentionKey, settings: SourceRetentionSettings): Promise<SourceRetentionResult> {
  if (!Number.isInteger(settings.bodyDays) || settings.bodyDays < 14 || settings.bodyDays > 365) throw new Error('invalid_source_retention_days')
  if (settings.mode === 'off') return { ...emptyResult(), skipped: 'disabled' }
  if (!Number.isInteger(settings.batchSize) || settings.batchSize < 1 || settings.batchSize > 5000) throw new Error('invalid_retention_batch')
  return retentionTransaction(pool, async client => {
    const result = emptyResult()
    const session = (await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0)) AS locked`, [key.installationId, key.sessionId])).rows[0].locked
    if (!session) return { ...result, skipped: 'busy' }
    const installation = (await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0)) AS locked`, [key.installationId])).rows[0].locked
    if (!installation) return { ...result, skipped: 'busy' }
    const state = (await client.query(`SELECT i.local_status,i.relay_status,i.snapshot_required,
        EXISTS(SELECT 1 FROM memory_session_tombstones s WHERE s.installation_id=i.installation_id AND s.session_id=$2) tombstoned,
        EXISTS(SELECT 1 FROM memory_governance_migration_runs m WHERE m.sealed_at IS NULL AND m.abandoned_at IS NULL
          AND (cardinality(m.scope_ids)=0 OR i.installation_id=ANY(m.scope_ids))) migration,
        EXISTS(SELECT 1 FROM memory_snapshot_runs r WHERE r.installation_id=i.installation_id
          AND(r.state='running' OR(r.state='completed' AND r.relay_acked_at IS NULL))) snapshot_busy
      FROM memory_installations i WHERE i.installation_id=$1`, [key.installationId, key.sessionId])).rows[0]
    if (!state || state.local_status !== 'ready' || state.relay_status !== 'active' || state.tombstoned) return { ...result, skipped: 'inactive' }
    if (state.migration) return { ...result, skipped: 'migration' }
    if (state.snapshot_required || state.snapshot_busy) return { ...result, skipped: 'snapshot' }
    let receipt = (await client.query<SourceRetentionReceipt>(`SELECT * FROM memory_source_retention_receipts
      WHERE installation_id=$1 AND turn_id=$2 FOR UPDATE`, [key.installationId, key.turnId])).rows[0]
    if (!receipt) {
      const episode = (await client.query(`SELECT e.installation_id,e.session_id,e.turn_id,e.episode_id,
          e.source_digest,e.document_compiler_version,success.completed_at ${eligibilityFrom}
        AND e.installation_id=$2 AND e.episode_id=$3 AND e.turn_id=$4`,
      [settings.bodyDays, key.installationId, key.episodeId, key.turnId])).rows[0]
      if (!episode || episode.session_id !== key.sessionId) return { ...result, skipped: 'not_eligible' }
      receipt = (await client.query<SourceRetentionReceipt>(`INSERT INTO memory_source_retention_receipts
          (installation_id,session_id,turn_id,episode_id,source_digest,compiler_version,extraction_completed_at,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'reclaiming') RETURNING *`,
      [key.installationId, key.sessionId, key.turnId, key.episodeId, episode.source_digest,
        episode.document_compiler_version ?? 'unknown', episode.completed_at])).rows[0]
    }
    if (receipt.session_id !== key.sessionId || receipt.episode_id !== key.episodeId) return { ...result, skipped: 'source_discovery_changed' }
    return reclaimReceiptBatch(client, receipt, settings.batchSize)
  })
}

/** Also used by restore-watermark replay before any consumer may run. */
export async function reclaimReceiptBatch(client: pg.PoolClient, receipt: SourceRetentionReceipt, batchSize: number): Promise<SourceRetentionResult> {
  const result = emptyResult(), args = [receipt.installation_id, receipt.turn_id, batchSize, receipt.reclaimed_at]
  result.events = (await client.query(`WITH due AS MATERIALIZED(
    SELECT source_event_id FROM source_events WHERE installation_id=$1 AND turn_id=$2 AND body_reclaimed_at IS NULL
    ORDER BY source_event_id LIMIT $3 FOR UPDATE SKIP LOCKED)
    UPDATE source_events s SET payload=memory_retention_source_metadata(s.payload),body_reclaimed_at=$4
    FROM due WHERE s.source_event_id=due.source_event_id`, args)).rowCount ?? 0
  result.artifacts = (await client.query(`WITH due AS MATERIALIZED(
    SELECT artifact_id FROM source_artifacts WHERE installation_id=$1 AND turn_id=$2 AND body_reclaimed_at IS NULL
    ORDER BY artifact_id LIMIT $3 FOR UPDATE SKIP LOCKED)
    UPDATE source_artifacts a SET details='{}',body_reclaimed_at=$4 FROM due WHERE a.artifact_id=due.artifact_id`, args)).rowCount ?? 0
  result.snapshots = (await client.query(`WITH due AS MATERIALIZED(
    SELECT relay_event_id,session_id FROM memory_snapshot_events WHERE installation_id=$1 AND
      COALESCE(NULLIF(payload->>'turn_id',''),NULLIF(payload->>'source_turn_id',''))=$2 AND body_reclaimed_at IS NULL
    ORDER BY relay_event_id LIMIT $3 FOR UPDATE SKIP LOCKED)
    UPDATE memory_snapshot_events s SET payload=memory_retention_source_metadata(s.payload),body_reclaimed_at=$4 FROM due
    WHERE s.installation_id=$1 AND s.relay_event_id=due.relay_event_id AND s.session_id=due.session_id`, args)).rowCount ?? 0
  result.candidates = (await client.query(`WITH due AS MATERIALIZED(
    SELECT candidate_id FROM memory_candidates WHERE installation_id=$1 AND episode_id=$2 AND body_reclaimed_at IS NULL
    ORDER BY candidate_id LIMIT $3 FOR UPDATE SKIP LOCKED)
    UPDATE memory_candidates c SET
      retained_content_hash=encode(sha256(convert_to(jsonb_build_object('statement',c.statement,
        'structured_content',c.structured_content,'evidence_handles',c.evidence_handles)::text,'UTF8')),'hex'),
      statement='[content reclaimed]',structured_content='{}',evidence_handles='[]',body_reclaimed_at=$4,revision=revision+1,
      status=CASE WHEN status IN('validated','conflict') AND review_expires_at<=clock_timestamp() THEN 'expired' ELSE status END,
      validation=CASE WHEN status IN('validated','conflict') THEN validation||'{"expiry_reason":"review_ttl_elapsed"}'::jsonb ELSE validation END
    FROM due WHERE c.candidate_id=due.candidate_id`,
  [receipt.installation_id, receipt.episode_id, batchSize, receipt.reclaimed_at])).rowCount ?? 0
  const outstanding = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM source_events WHERE installation_id=$1 AND turn_id=$2 AND body_reclaimed_at IS NULL)
    OR EXISTS(SELECT 1 FROM source_artifacts WHERE installation_id=$1 AND turn_id=$2 AND body_reclaimed_at IS NULL)
    OR EXISTS(SELECT 1 FROM memory_snapshot_events WHERE installation_id=$1 AND
      COALESCE(NULLIF(payload->>'turn_id',''),NULLIF(payload->>'source_turn_id',''))=$2 AND body_reclaimed_at IS NULL)
    OR EXISTS(SELECT 1 FROM memory_candidates WHERE installation_id=$1 AND episode_id=$3 AND body_reclaimed_at IS NULL) pending`,
  [receipt.installation_id, receipt.turn_id, receipt.episode_id])).rows[0].pending
  if (!outstanding) {
    result.episodes = (await client.query(`UPDATE work_episodes SET
      retained_content_hash=encode(sha256(convert_to(jsonb_build_object('document',document,'manifest',evidence_manifest,'summary',summary)::text,'UTF8')),'hex'),
      document='{}',evidence_manifest='{}',summary=jsonb_strip_nulls(jsonb_build_object('references',summary->'references',
        'retention',jsonb_build_object('policy','source-body-v1','body_reclaimed_at',$3::timestamptz))),body_reclaimed_at=$3
      WHERE installation_id=$1 AND episode_id=$2 AND body_reclaimed_at IS NULL`,
    [receipt.installation_id, receipt.episode_id, receipt.reclaimed_at])).rowCount ?? 0
    await client.query(`UPDATE memory_source_retention_receipts SET state='reclaimed',finished_at=COALESCE(finished_at,clock_timestamp())
      WHERE installation_id=$1 AND turn_id=$2`, [receipt.installation_id, receipt.turn_id])
    result.finished = true
  }
  return result
}
