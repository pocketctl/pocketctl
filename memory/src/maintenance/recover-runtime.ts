import type pg from 'pg'
import { classifyEnvelope } from '../relay/validation.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import type { ExtensionFeedEnvelopeV1 } from '../relay/contracts.js'

export interface RuntimeRecoveryInput {
  installationId: string
  /** Original sanitized quarantine envelopes exported from trusted Relay data. */
  discoveryEnvelopes?: unknown[]
  /** Explicit failed run IDs; only the current evidence version can be retried. */
  failedRunIds?: string[]
  apply?: boolean
}

/** Bounded, atomic operator repair. Dry-run takes the same locks and rolls back. */
export async function recoverRuntime(pool: pg.Pool, input: RuntimeRecoveryInput) {
  const raw = input.discoveryEnvelopes ?? []
  const failedRunIds = [...new Set(input.failedRunIds ?? [])]
  if (raw.length + failedRunIds.length === 0 || raw.length + failedRunIds.length > 100) throw new Error('recovery_requires_1_to_100_targets')
  const envelopes: ExtensionFeedEnvelopeV1[] = raw.map(value => {
    const result = classifyEnvelope(value)
    if (result.kind !== 'discovery_gap') throw new Error('recovery_requires_verified_discovery_envelope')
    return result.envelope
  })
  if (new Set(envelopes.map(e => e.feed_id)).size !== envelopes.length) throw new Error('duplicate_recovery_feed_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout='5s'`)
    await client.query(`SET LOCAL statement_timeout='10s'`)
    const discovered = failedRunIds.length ? (await client.query<{session_id:string}>(`
      SELECT e.session_id FROM memory_extraction_runs r JOIN work_episodes e USING(installation_id,episode_id)
      WHERE r.installation_id=$1 AND r.run_id=ANY($2::uuid[])`, [input.installationId,failedRunIds])).rows : []
    const sessions = [...new Set([...envelopes.map(e => e.subject.session_id!), ...discovered.map(e => e.session_id)])].sort()
    for (const session of sessions) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:'||$1||':'||$2,0))`, [input.installationId,session])
    await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))`, [input.installationId])
    const installation = await client.query(`SELECT 1 FROM memory_installations WHERE installation_id=$1 AND relay_status='active' AND local_status IN('ready','degraded') AND NOT snapshot_required FOR SHARE`, [input.installationId])
    if (!installation.rowCount) throw new Error('recovery_installation_unavailable')
    if ((await client.query(`SELECT 1 FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=ANY($2::text[])`,[input.installationId,sessions])).rowCount) throw new Error('recovery_source_purged')
    if ((await client.query(`SELECT 1 FROM source_sessions WHERE installation_id=$1 AND session_id=ANY($2::text[]) AND deleted_at IS NOT NULL`,[input.installationId,sessions])).rowCount) throw new Error('recovery_source_deleted')
    const reclassified: string[] = []
    const alreadyClassified: string[] = []
    for (const envelope of envelopes) {
      const row = (await client.query<{payload_hash:Buffer;error_code:string;projection_state:string;session_id:string;turn_id:string|null}>(`
        SELECT payload_hash,error_code,projection_state,session_id,turn_id FROM memory_feed_inbox
        WHERE installation_id=$1 AND feed_id=$2::bigint FOR UPDATE`,[input.installationId,envelope.feed_id])).rows[0]
      if (!row || !row.payload_hash.equals(canonicalPayloadHash(envelope)) || row.projection_state !== 'quarantined'
        || row.session_id !== envelope.subject.session_id || row.turn_id !== (envelope.subject.turn_id ?? null)
        || !['oversized_content','oversized_discovery'].includes(row.error_code)) throw new Error('recovery_envelope_mismatch')
      if (row.error_code === 'oversized_discovery') { alreadyClassified.push(envelope.feed_id); continue }
      // Preserve the original hash and metadata. Only the impact classification changes.
      await client.query(`UPDATE memory_feed_inbox SET error_code='oversized_discovery',event_type=$3,data=data||jsonb_build_object('impact_reclassified_at',clock_timestamp(),'previous_error_code','oversized_content') WHERE installation_id=$1 AND feed_id=$2::bigint`,[input.installationId,envelope.feed_id,envelope.subject.event_type])
      reclassified.push(envelope.feed_id)
    }
    const failed = failedRunIds.length ? (await client.query<{run_id:string;episode_id:string;session_id:string;turn_id:string;digest:string}>(`
      SELECT r.run_id::text,e.episode_id::text,e.session_id,e.turn_id,encode(e.source_digest,'hex') digest
      FROM memory_extraction_runs r JOIN work_episodes e USING(installation_id,episode_id)
      WHERE r.installation_id=$1 AND r.run_id=ANY($2::uuid[]) AND r.state='failed'
        AND r.error_code='provider_result_unknown' AND r.episode_source_digest=e.source_digest
        AND e.compiled_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM memory_extraction_runs s WHERE s.installation_id=r.installation_id AND s.episode_id=r.episode_id
          AND s.episode_source_digest=r.episode_source_digest AND (s.state IN('running','succeeded') OR s.started_at>r.started_at))
      FOR SHARE OF e,r`,[input.installationId,failedRunIds])).rows : []
    if (failed.length !== failedRunIds.length || failed.some(row=>!sessions.includes(row.session_id))) throw new Error('recovery_run_not_current_or_retryable')
    const changedScopes = envelopes.filter(e=>reclassified.includes(e.feed_id)).map(e=>({session_id:e.subject.session_id!,turn_id:e.subject.turn_id??null}))
    const episodes = changedScopes.length ? (await client.query<{episode_id:string;turn_id:string;digest:string}>(`
      SELECT e.episode_id::text,e.turn_id,encode(e.source_digest,'hex') digest FROM work_episodes e
      JOIN source_sessions s USING(installation_id,session_id)
      WHERE e.installation_id=$1 AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS affected(session_id text,turn_id text)
          WHERE affected.session_id=e.session_id AND (affected.turn_id IS NULL OR affected.turn_id=e.turn_id)) AND e.compiled_at IS NOT NULL AND e.source_digest IS NOT NULL
        AND s.deleted_at IS NULL
      ORDER BY e.episode_id LIMIT 501 FOR SHARE OF e,s`,[input.installationId,JSON.stringify(changedScopes)])).rows : []
    if (episodes.length > 500) throw new Error('recovery_episode_limit_exceeded')
    const targets = [...episodes.map(e=>({...e,key:`recovery:discovery:${e.episode_id}:${e.digest}`})),...failed.map(e=>({...e,key:`recovery:provider:${e.run_id}`}))]
    const scheduled: string[] = []
    for (const target of targets) {
      const result=await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
        SELECT gen_random_uuid(),e.installation_id,'extract_candidates',$3,20,
          jsonb_build_object('turn_id',e.turn_id,'expected_source_digest',encode(e.source_digest,'hex')) ||
          CASE WHEN $5::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retry_failed_run_id',$5::text) END
        FROM work_episodes e JOIN source_sessions s USING(installation_id,session_id)
        JOIN memory_feature_settings f USING(installation_id)
        WHERE e.installation_id=$1 AND e.episode_id=$2 AND e.source_digest=decode($4,'hex')
          AND s.deleted_at IS NULL AND f.extraction_mode IN('enabled','shadow')
          AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=e.installation_id AND t.session_id=e.session_id)
          AND NOT EXISTS(SELECT 1 FROM memory_feed_inbox gap WHERE gap.installation_id=e.installation_id AND gap.session_id=e.session_id
            AND gap.error_code='oversized_content' AND gap.projection_state='quarantined' AND (gap.turn_id IS NULL OR gap.turn_id=e.turn_id))
        ON CONFLICT DO NOTHING RETURNING job_id`,[input.installationId,target.episode_id,target.key,target.digest,'run_id' in target ? target.run_id : null])
      if (result.rowCount) scheduled.push(target.episode_id)
    }
    await client.query(input.apply ? 'COMMIT' : 'ROLLBACK')
    return {applied:!!input.apply,reclassified,alreadyClassified,scheduledEpisodes:scheduled,requestedFailedRuns:failedRunIds}
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined)
    throw error
  } finally { client.release() }
}
