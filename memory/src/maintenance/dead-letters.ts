import {createHash} from 'node:crypto'
import type pg from 'pg'

export interface FailureRetentionSettings {
  mode: 'preview' | 'enabled'
  scopes: readonly string[]
  detailDays: number
  receiptDays: number
  batchSize: number
}

export function failureRetentionSettings(env: NodeJS.ProcessEnv = process.env): FailureRetentionSettings {
  function positive(key: string, fallback: number, max: number) {
    const n=Number(env[key] ?? fallback)
    if (!Number.isSafeInteger(n) || n<1 || n>max) throw Error('invalid_'+key.toLowerCase())
    return n
  }
  const mode=env.MEMORY_FAILURE_RETENTION_MODE ?? 'preview'
  if (mode!=='preview' && mode!=='enabled') throw Error('invalid_memory_failure_retention_mode')
  const scopes=(env.MEMORY_FAILURE_RETENTION_SCOPES ?? '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
  if(scopes.some(s=>s!=='global' && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s))) throw Error('invalid_memory_failure_retention_scopes')
  return {mode,scopes,detailDays:positive('MEMORY_FAILURE_DETAIL_DAYS',30,3650),
    receiptDays:positive('MEMORY_FAILURE_RECEIPT_DAYS',90,3650),batchSize:positive('MEMORY_FAILURE_RETENTION_BATCH_SIZE',100,100)}
}

export interface FailureCursor { at: string; id: string }
type Db = Pick<pg.PoolClient,'query'>

// Legacy attribution can be established only by the pre-requeue verifier.
// A current job with a similar error, or a newer turn with unrelated input,
// cannot close an unmatched failure. Compilation performs no paid work.
function evidenceQuery(native: boolean, global: boolean) {
  const relations=native ? `
    LEFT JOIN LATERAL (
      SELECT link.*,count(*) OVER() AS matches FROM memory_dialogue_legacy_failures link
      WHERE link.job_id=f.job_id AND link.installation_id=f.installation_id AND link.dead_at=f.dead_at
        AND link.attempts=f.attempts AND link.error_code=f.error_code
        AND ((f.origin='legacy_summary' AND link.payload_hash=f.payload_hash)
         OR (f.origin='worker' AND link.payload_hash=f.payload_hash AND link.claim_epoch=f.claim_epoch)
         OR (f.origin='legacy_job' AND link.claim_epoch=f.claim_epoch))
      ORDER BY link.claim_epoch LIMIT 1
    ) l ON true
    LEFT JOIN memory_dialogue_compile_receipts r ON f.job_type='compile_episode' AND r.installation_id=f.installation_id
      AND r.job_id=f.job_id AND r.session_id=COALESCE(l.session_id,f.session_id) AND r.turn_id=COALESCE(l.turn_id,f.turn_id)
      AND r.generation::text=CASE WHEN l.job_id IS NOT NULL THEN l.generation::text WHEN f.origin='worker' THEN f.input_generation END
      AND r.claim_epoch>=COALESCE(l.claim_epoch,f.claim_epoch) AND r.closed_at>=f.dead_at
    LEFT JOIN memory_dialogue_turns t ON (t.installation_id,t.session_id,t.turn_id)=(r.installation_id,r.session_id,r.turn_id)
    LEFT JOIN memory_dialogue_compile_receipts successor ON r.status='superseded'
      AND (successor.installation_id,successor.session_id,successor.turn_id)=(r.installation_id,r.session_id,r.turn_id)
      AND successor.generation=t.requested_generation AND successor.generation>r.generation
      AND successor.status IN('published','not_admitted','input_gap') AND successor.closed_at IS NOT NULL AND successor.next_probe_at IS NULL`
    : ''
  const evidence=native ? `r.session_id, r.turn_id,r.generation,r.claim_epoch AS receipt_epoch,r.status,r.reason,r.next_probe_at,r.closed_at,
    successor.generation AS successor_generation, GREATEST(r.closed_at,successor.closed_at) AS resolved_at,
    EXISTS(SELECT 1 FROM memory_jobs other WHERE other.job_id<>f.job_id AND other.installation_id=r.installation_id
      AND other.job_type=f.job_type AND other.state IN('pending','running','dead')
      AND other.idempotency_key='dialogue:'||encode(sha256(convert_to(jsonb_build_array(r.session_id,r.turn_id)::text,'UTF8')),'hex')) AS active_replay,
    COALESCE(f.claim_epoch,l.claim_epoch) AS failed_epoch,COALESCE(l.matches=1,false) AS verified_legacy,COALESCE(l.matches,0)>1 AS ambiguous_legacy,
    CASE WHEN r.job_id IS NOT NULL THEN sha256(convert_to('dialogue:'||encode(sha256(convert_to(jsonb_build_array(r.session_id,r.turn_id)::text,'UTF8')),'hex'),'UTF8')) END AS expected_key`
    : `NULL::text AS session_id,NULL::text AS turn_id,NULL::bigint AS generation,NULL::bigint AS receipt_epoch,false AS verified_legacy,false AS ambiguous_legacy,false AS active_replay,NULL::text AS status,NULL::text AS reason,
       NULL::timestamptz AS next_probe_at,NULL::timestamptz AS closed_at,NULL::bigint AS successor_generation,
       NULL::timestamptz AS resolved_at,NULL::bigint AS failed_epoch,NULL::bytea AS expected_key`
  return `WITH candidates AS MATERIALIZED (
    SELECT * FROM memory_job_failures f WHERE ${global?'f.installation_id IS NULL AND $1::uuid IS NULL':'f.installation_id=$1::uuid'}
      AND ($2::uuid IS NULL OR f.failure_id=$2)
      AND (NOT $7::boolean OR COALESCE(next_review_at,dead_at)<=CURRENT_TIMESTAMP)
      AND ($4::timestamptz IS NULL OR (COALESCE(next_review_at,dead_at),failure_id)>($4,$5::uuid))
    ORDER BY COALESCE(next_review_at,dead_at),failure_id LIMIT $6
  ), evidence AS (
    SELECT f.failure_id,f.job_id,f.installation_id,f.origin,f.job_type,f.key_hash,f.dead_at,f.claim_epoch,
      COALESCE(f.next_review_at,f.dead_at) AS review_at,
      j.state AS job_state,j.claim_epoch AS job_epoch,j.payload->>'dialogue_generation' AS job_generation,
      j.installation_id IS NOT DISTINCT FROM f.installation_id AND j.job_type=f.job_type
       AND f.key_hash=sha256(convert_to(j.idempotency_key,'UTF8')) AS same_key,
      d.job_id IS NOT NULL AS summary_present,
      (d.job_type=f.job_type AND d.installation_id IS NOT DISTINCT FROM f.installation_id AND d.dead_at=f.dead_at
        AND d.claim_epoch IS NOT DISTINCT FROM f.claim_epoch AND d.payload_hash=f.payload_hash AND d.attempts=f.attempts
        AND d.error_code=f.error_code) AS matching_summary,
      ${evidence}
    FROM candidates f LEFT JOIN memory_jobs j USING(job_id) LEFT JOIN memory_dead_letters d USING(job_id)
     ${relations}
  ), classified AS (
    SELECT *,
      CASE
        WHEN job_type='project_shared_source' THEN 'historical_projection'
        WHEN job_type IN('consolidate_task','curate_conclusions','report_usage','extract_skill_candidate','extract_candidates') THEN 'provider_or_accounting'
        WHEN job_type<>'compile_episode' THEN 'no_disposition_contract'
        WHEN ambiguous_legacy OR (origin<>'worker' AND NOT verified_legacy) OR failed_epoch IS NULL THEN 'unmatched'
        WHEN active_replay OR job_state IN('pending','running') THEN 'active_job'
        WHEN job_state IS NOT NULL AND same_key IS DISTINCT FROM true THEN 'identity_changed'
        WHEN job_state='dead' AND job_epoch<>failed_epoch THEN 'new_failure'
        WHEN closed_at IS NULL OR next_probe_at IS NOT NULL THEN 'unresolved'
        WHEN NOT (verified_legacy AND key_hash IS NULL) AND key_hash IS DISTINCT FROM expected_key THEN 'identity_changed'
        WHEN status='superseded' AND successor_generation IS NULL THEN 'successor_unproven'
        WHEN status NOT IN('published','not_admitted','input_gap','superseded') THEN 'unresolved'
        WHEN resolved_at + $3::integer*INTERVAL '1 day'>CURRENT_TIMESTAMP THEN 'retention'
        ELSE 'eligible' END AS classification
    FROM evidence)
    SELECT *,COALESCE(key_hash,expected_key) AS dedupe_hash,resolved_at::text AS resolved_timestamp,review_at::text AS cursor_at,
      GREATEST(0,floor(extract(epoch FROM CURRENT_TIMESTAMP-resolved_at)))::bigint AS age_seconds FROM classified
    ORDER BY review_at,failure_id`
}

type Review = {
  failure_id:string;job_id:string;installation_id:string|null;job_type:string;classification:string;cursor_at:string;
  dedupe_hash:Buffer;resolved_timestamp:string;receipt_epoch:string;session_id:string;turn_id:string;failed_epoch:string;generation:string;successor_generation:string|null;
  status:string;closed_at:Date;resolved_at:Date;job_state:string|null;job_epoch:string|null;job_generation:string|null;
  matching_summary:boolean|null;age_seconds:string
}

async function hasNativeReceipts(db:Db) {
  return (await db.query(`SELECT to_regclass('memory_dialogue_compile_receipts') IS NOT NULL
    AND to_regclass('memory_dialogue_legacy_failures') IS NOT NULL AS available`)).rows[0].available as boolean
}

/** Ordinary completed work keeps its existing 24-hour policy. Fenced retry
 * receipts retain the queue row used by the repair scheduler across upgrades. */
export async function removeExpiredCompletedJobs(db:Db) {
  const native=await hasNativeReceipts(db)
  const stages=(await db.query("SELECT to_regclass('memory_stage_dispositions') IS NOT NULL AS present")).rows[0].present
  const result=await db.query(`WITH expired AS (SELECT j.job_id FROM memory_jobs j
    WHERE j.state='completed' AND j.completed_at<CURRENT_TIMESTAMP-INTERVAL '24 hours' AND NOT j.had_failure
      AND NOT EXISTS(SELECT 1 FROM memory_dead_letters d WHERE d.job_id=j.job_id)
      AND NOT EXISTS(SELECT 1 FROM memory_job_failures f WHERE f.job_id=j.job_id)
      AND NOT (j.job_type='compile_episode' AND j.payload ? 'dialogue_generation' AND j.last_error_code IS NOT NULL)
      ${native?`AND NOT EXISTS(SELECT 1 FROM memory_dialogue_compile_receipts r WHERE
        (r.installation_id,r.session_id,r.turn_id)=(j.installation_id,j.payload->>'dialogue_session',j.payload->>'turn')
        AND r.job_id=j.job_id AND r.generation::text=j.payload->>'dialogue_generation'
        AND (r.status IN('failed','retrying') OR r.next_probe_at IS NOT NULL))`:''}
      ${stages?`AND NOT EXISTS(SELECT 1 FROM memory_stage_dispositions s WHERE s.job_id=j.job_id
        AND (s.status IN('isolated','repair_queued','retrying') OR s.next_probe_at IS NOT NULL))`:''}
    ORDER BY j.completed_at,j.job_id LIMIT 500 FOR UPDATE SKIP LOCKED)
    DELETE FROM memory_jobs j USING expired x WHERE j.job_id=x.job_id`)
  return result.rowCount??0
}

function readPage(db:Db,sql:string,installation:string|null,settings:FailureRetentionSettings,cursor?:FailureCursor,id?:string,dueOnly=false) {
  return db.query<Review>(sql,[installation,id??null,settings.detailDays,cursor?.at??null,cursor?.id??null,settings.batchSize,dueOnly])
}

export async function previewFailureRetention(db:Db,installation:string|null,settings:FailureRetentionSettings,cursor?:FailureCursor) {
  const result=await readPage(db,evidenceQuery(await hasNativeReceipts(db),installation===null),installation,settings,cursor)
  return result.rows.map(r=>({failureId:r.failure_id,jobId:r.job_id,reason:r.classification,
    nextCursor:{at:r.cursor_at,id:r.failure_id},ageSeconds:Number(r.age_seconds)}))
}

async function cleanFailure(db:Db,row:Review,sql:string,settings:FailureRetentionSettings):Promise<string> {
  const {installation_id:install,session_id:session,turn_id:turn,job_id:job}=row
  // Acquire the same fences as input dispatch, source deletion and compilation.
  // Roll back this item's savepoint on contention, leaving every other item free.
  const fenced=await db.query(`SELECT
    pg_try_advisory_xact_lock_shared(hashtextextended('purge:session:'||$1||':'||$2,0)) AND
    pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0)) AND
    pg_try_advisory_xact_lock(hashtextextended('turn-dialogue:'||$1||':'||$2||':'||$3,0)) AND
    pg_try_advisory_xact_lock(hashtextextended('memory:failure-enqueue:'||$1||':'||encode($4::bytea,'hex'),0)) AS acquired`,
    [install,session,turn,row.dedupe_hash])
  if(!fenced.rows[0].acquired) return 'busy'
  await db.query('SELECT 1 FROM memory_jobs WHERE job_id=$1 FOR UPDATE NOWAIT',[job])
  await db.query('SELECT 1 FROM memory_dead_letters WHERE job_id=$1 FOR UPDATE NOWAIT',[job])
  if(!(await db.query('SELECT 1 FROM memory_job_failures WHERE failure_id=$1 FOR UPDATE NOWAIT',[row.failure_id])).rowCount) return 'already_handled'
  await db.query(`SELECT 1 FROM memory_dialogue_turns WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3 FOR SHARE NOWAIT`,[install,session,turn])
  await db.query(`SELECT 1 FROM memory_dialogue_compile_receipts WHERE installation_id=$1 AND session_id=$2 AND turn_id=$3
    AND generation=ANY($4::bigint[]) FOR SHARE NOWAIT`,[install,session,turn,[row.generation,row.successor_generation].filter(Boolean)])
  const current=(await readPage(db,sql,install,settings,undefined,row.failure_id)).rows[0]
  if(current?.classification!=='eligible') return current?.classification??'already_handled'
  if(current.successor_generation!==row.successor_generation) return 'identity_changed'
  let verifiedDead=false
  if(current.job_state==='dead' && current.matching_summary && current.job_epoch===current.failed_epoch) {
    const original=(await db.query(`SELECT j.payload,f.payload_hash FROM memory_job_failures f JOIN memory_jobs j USING(job_id)
      WHERE f.failure_id=$1 AND j.claim_epoch=f.claim_epoch AND j.completed_at=f.dead_at AND j.attempts=f.attempts
        AND j.last_error_code=f.error_code`,[row.failure_id])).rows[0]
    verifiedDead=Boolean(original && createHash('sha256').update(JSON.stringify(original.payload)).digest().equals(original.payload_hash))
    if(!verifiedDead) return 'identity_changed'
  }
  await db.query(`INSERT INTO memory_failure_deduplication(scope_key,installation_id,job_type,key_hash,generation,session_id,turn_id)
    VALUES(COALESCE($1::uuid::text,'global'),$1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[install,row.job_type,row.dedupe_hash,row.generation,session,turn])
  const summary=current.matching_summary ? await db.query('DELETE FROM memory_dead_letters WHERE job_id=$1',[job]) : undefined
  // A same-key job may now be a distinct execution or input. Keep that row.
  const sameExecution=current.job_generation===current.generation && (current.job_state==='completed'
    ? current.job_epoch===current.receipt_epoch : verifiedDead)
  const removed=sameExecution && (current.job_state==='dead'||current.job_state==='completed')
    ? await db.query(`DELETE FROM memory_jobs j WHERE job_id=$1 AND NOT EXISTS(
      SELECT 1 FROM memory_job_failures f WHERE f.job_id=j.job_id AND f.failure_id<>$2)
      AND NOT EXISTS(SELECT 1 FROM memory_dead_letters d WHERE d.job_id=j.job_id)`,[job,row.failure_id]) : undefined
  await db.query(`INSERT INTO memory_failure_cleanup_receipts(failure_id,job_id,installation_id,claim_epoch,generation,
    session_id,turn_id,disposition,closed_at,policy_version,removed_job,removed_summary,removed_failure,successor_generation)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,true,$12)`,[row.failure_id,job,install,current.failed_epoch,current.generation,
    session,turn,current.status,current.resolved_timestamp,Boolean(removed?.rowCount),Boolean(summary?.rowCount),current.successor_generation])
  await db.query('DELETE FROM memory_job_failures WHERE failure_id=$1',[row.failure_id])
  return 'cleaned'
}

/** Called inside the daily checkpoint transaction. Preview mode writes only
 * maintenance counters/checkpoints. Every mutation revalidates after locking. */
export async function retainFailureBatch(db:Db,installation:string|null,settings:FailureRetentionSettings,cursor?:FailureCursor) {
  const sql=evidenceQuery(await hasNativeReceipts(db),installation===null)
  const enabled=settings.mode==='enabled' && settings.scopes.includes(installation??'global')
  const page=(await readPage(db,sql,installation,settings,cursor,undefined,enabled)).rows
  const counts:Record<string,number>={}
  const reviewed:{id:string;reason:string;closed:string|null}[]=[]
  let oldest=0,handled=0,after=cursor
  const started=performance.now()
  for(const row of page) {
    let reason=row.classification
    if(reason==='eligible') {
      oldest=Math.max(oldest,Number(row.age_seconds))
      if(enabled) {
        await db.query('SAVEPOINT failure_cleanup_item')
        try {
          reason=await cleanFailure(db,row,sql,settings)
          if(reason!=='cleaned') await db.query('ROLLBACK TO SAVEPOINT failure_cleanup_item')
        } catch(error) {
          await db.query('ROLLBACK TO SAVEPOINT failure_cleanup_item')
          if((error as {code?:string}).code!=='55P03') throw error
          reason='busy'
        }
        await db.query('RELEASE SAVEPOINT failure_cleanup_item')
      }
    }
    if(enabled && reason!=='cleaned' && reason!=='already_handled') reviewed.push({id:row.failure_id,reason,closed:row.resolved_timestamp})
    counts['failure_'+reason]=(counts['failure_'+reason]??0)+1
    handled++
    after={at:row.cursor_at,id:row.failure_id}
    if(performance.now()-started>=1500) break
  }
  let expired=0
  if(enabled) {
    if(reviewed.length) {
      // Persist each protected item's reason and indexed next review. A row
      // held by another transaction keeps its original due time for tomorrow.
      await db.query(`WITH observations AS (
        SELECT * FROM unnest($1::uuid[],$2::text[],$3::timestamptz[]) AS o(id,reason,closed)
      ), locked AS (
        SELECT f.failure_id,o.reason,o.closed FROM memory_job_failures f JOIN observations o ON f.failure_id=o.id
        FOR UPDATE OF f SKIP LOCKED)
        UPDATE memory_job_failures f SET last_review_reason=o.reason,next_review_at=CASE WHEN o.reason='retention'
          THEN o.closed+$4::integer*INTERVAL '1 day'
          ELSE (date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')+interval '1 day 3 hours') AT TIME ZONE 'Asia/Shanghai' END
        FROM locked o WHERE f.failure_id=o.failure_id`,
        [reviewed.map(r=>r.id),reviewed.map(r=>r.reason),reviewed.map(r=>r.closed),settings.detailDays])
    }
    const result=await db.query(`WITH expired AS (SELECT failure_id FROM memory_failure_cleanup_receipts
      WHERE installation_id IS NOT DISTINCT FROM $1::uuid AND cleaned_at<=CURRENT_TIMESTAMP-$2::integer*INTERVAL '1 day'
      ORDER BY cleaned_at,failure_id LIMIT $3 FOR UPDATE SKIP LOCKED)
      DELETE FROM memory_failure_cleanup_receipts r USING expired e WHERE r.failure_id=e.failure_id`,[installation,settings.receiptDays,settings.batchSize])
    expired=result.rowCount??0
    counts.failure_receipts_expired=expired
  }
  return {counts,oldest,after,more:handled<page.length||page.length===settings.batchSize||expired===settings.batchSize}
}
