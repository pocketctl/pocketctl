import type pg from 'pg'
import {MemoryApiError} from '../api/errors.js'
import {guardRetainedEvidence,assertRetainedSourceGuards} from '../sources/retained-authority.js'
import {preparedSourceUnavailable} from '../sources/prepared-sources.js'

export const MAX_USER_EXTRACTION_RETRIES = 3
const ZERO = '00000000-0000-0000-0000-000000000000'

/** Shared with readiness: running/new failed attempts cannot resolve an older failure. */
export const UNRESOLVED_EXTRACTION_SOURCE = `
 FROM memory_extraction_runs r
 JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id AND e.source_digest=r.episode_source_digest
 JOIN source_sessions s ON s.installation_id=e.installation_id AND s.session_id=e.session_id
 WHERE r.installation_id=$1 AND r.state IN('failed','quarantined') AND s.deleted_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=e.installation_id AND t.session_id=e.session_id)
 AND NOT EXISTS(SELECT 1 FROM memory_extraction_runs done WHERE done.installation_id=r.installation_id
   AND done.episode_id=r.episode_id AND done.episode_source_digest=r.episode_source_digest
   AND done.state='succeeded' AND (done.started_at,done.run_id)>(r.started_at,r.run_id))`

function reason(code:string|null) {
 if(code?.includes('claim_type:invalid_value'))return 'invalid_claim_type'
 if(code?.includes('evidence_handles'))return 'invalid_evidence'
 if(code?.startsWith('invalid_output'))return 'invalid_output'
 if(code==='provider_result_unknown')return 'provider_result_unknown'
 return 'extraction_failed'
}

export async function listExtractionIssues(pool:Pick<pg.Pool,'query'>,installationId:string,consentFingerprint?:string) {
 const result=await pool.query(`WITH current_issues AS (
 SELECT DISTINCT ON(r.episode_id) r.run_id,r.episode_id,r.state,r.error_code,r.started_at,r.completed_at,
 e.session_id,e.turn_id,e.source_digest,e.compiled_at,e.body_reclaimed_at
 ${UNRESOLVED_EXTRACTION_SOURCE} ORDER BY r.episode_id,r.started_at DESC,r.run_id DESC
 ) SELECT c.run_id,c.episode_id,c.session_id,c.turn_id,c.state,c.error_code,c.completed_at,
 j.state AS job_state,j.last_error_code AS job_error,
 (SELECT COUNT(*)::int FROM (
   SELECT attempt.retry_key FROM memory_extraction_runs attempt WHERE attempt.installation_id=$1 AND attempt.episode_id=c.episode_id
     AND attempt.episode_source_digest=c.source_digest AND attempt.retry_key<>'00000000-0000-0000-0000-000000000000'
   UNION SELECT tries.job_id FROM memory_jobs tries WHERE tries.installation_id=$1 AND tries.job_type='extract_candidates'
     AND tries.payload->>'user_retry_episode_id'=c.episode_id::text
     AND tries.payload->>'expected_source_digest'=encode(c.source_digest,'hex')
 ) attempts) AS retry_count,
 (c.compiled_at IS NOT NULL AND c.body_reclaimed_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM memory_source_retention_receipts retained WHERE retained.installation_id=$1 AND retained.turn_id=c.turn_id)
   AND NOT EXISTS(SELECT 1 FROM memory_feed_inbox gap WHERE gap.installation_id=$1 AND gap.session_id=c.session_id
     AND gap.projection_state='quarantined' AND gap.error_code='oversized_content' AND (gap.turn_id IS NULL OR gap.turn_id=c.turn_id))) AS source_available,
 (i.relay_status='active' AND i.local_status='ready' AND NOT i.snapshot_required
   AND f.extraction_mode IN('enabled','shadow') AND f.extraction_consent_fingerprint=$2::text) AS extraction_available
 FROM current_issues c JOIN memory_installations i ON i.installation_id=$1
 LEFT JOIN memory_feature_settings f ON f.installation_id=$1
 LEFT JOIN memory_jobs j ON j.installation_id=$1 AND j.job_type='extract_candidates' AND j.idempotency_key='user-extraction-retry:'||c.run_id::text
 ORDER BY c.completed_at,c.run_id LIMIT 51`,[installationId,consentFingerprint??null])
 return {issues:result.rows.slice(0,50).map(row=>{
  const active=['pending','running'].includes(row.job_state)
  const blocked = active ? null : row.error_code==='provider_result_unknown' ? 'operator_required'
   : !row.source_available ? 'source_unavailable'
   : !row.extraction_available ? 'settings_required'
   : row.retry_count>=MAX_USER_EXTRACTION_RETRIES ? 'retry_limit'
   : row.job_state && !['pending','running'].includes(row.job_state) ? 'retry_incomplete' : null
  return {run_id:row.run_id as string,episode_id:row.episode_id as string,session_id:row.session_id as string,
   turn_id:row.turn_id as string,completed_at:row.completed_at,reason:reason(row.error_code),
   status:row.job_state==='pending'?'pending':row.job_state==='running'?'running':'unresolved',
   retry_count:row.retry_count as number,blocked_reason:blocked,
   can_retry:!blocked&&!['pending','running'].includes(row.job_state)}
 }),has_more:result.rows.length>50}
}

/** Caller owns session -> installation authority locks and the receipt transaction. */
export async function scheduleExtractionRetry(client:pg.PoolClient,input:{installationId:string;runId:string;consentFingerprint?:string}) {
 const row=(await client.query(`SELECT r.run_id,r.episode_id,encode(r.episode_source_digest,'hex') digest,e.turn_id
 ${UNRESOLVED_EXTRACTION_SOURCE} AND r.run_id=$2::uuid FOR SHARE OF r,e,s`,[input.installationId,input.runId])).rows[0]
 if(!row)throw new MemoryApiError('not_found','extraction issue unavailable')
 const currentSource=async()=>{
  try{
   await guardRetainedEvidence(client,input.installationId,[{source_event_id:null,artifact_id:null,episode_id:row.episode_id,evidence_kind:'episode'}])
   await assertRetainedSourceGuards(client)
  }catch(error){if(preparedSourceUnavailable(error))throw new MemoryApiError('revision_conflict','extraction source unavailable');throw error}
 }
 await currentSource()
 // Serialized with all other user retries for this episode under the installation authority lock.
 await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('extraction-retry:'||$1||':'||$2,0))`,[input.installationId,row.episode_id])
 const existing=(await client.query(`SELECT job_id,state FROM memory_jobs WHERE installation_id=$1 AND job_type='extract_candidates' AND idempotency_key=$2`,[input.installationId,`user-extraction-retry:${input.runId}`])).rows[0]
 if(existing){await currentSource();return {job_id:existing.job_id as string,state:existing.state as string}}
 const issue=(await listExtractionIssues(client,input.installationId,input.consentFingerprint)).issues.find(r=>r.run_id===input.runId)
 if(!issue?.can_retry)throw new MemoryApiError('revision_conflict','extraction issue is not retryable; refresh current issues')
 // A different request or automatic worker must finish before another attempt starts.
 const active=await client.query(`SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_type='extract_candidates'
 AND payload->>'turn_id'=$2 AND state IN('pending','running') UNION ALL
 SELECT 1 FROM memory_extraction_runs WHERE installation_id=$1 AND episode_id=$3 AND episode_source_digest=decode($4,'hex') AND state='running' LIMIT 1`,[input.installationId,row.turn_id,row.episode_id,row.digest])
 if(active.rowCount)throw new MemoryApiError('revision_conflict','extraction already pending; refresh current issues')
 const job=(await client.query<{job_id:string}>(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload)
 VALUES(gen_random_uuid(),$1,'extract_candidates',$2,20,jsonb_build_object('turn_id',$3::text,'expected_source_digest',$4::text,
 'retry_extraction_run_id',$5::text,'user_retry_episode_id',$6::text)) RETURNING job_id`,[input.installationId,`user-extraction-retry:${input.runId}`,row.turn_id,row.digest,input.runId,row.episode_id])).rows[0]
 await currentSource()
 return {job_id:job.job_id,state:'pending'}
}

export {ZERO as DEFAULT_EXTRACTION_RETRY_KEY}
