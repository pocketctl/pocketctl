import {DIALOGUE_PROCESSOR_REVISION} from '../migrations/shared-db/dialogue-generations.js'
import {createHash} from 'node:crypto'
import type pg from 'pg'
import { assertJobFence,releaseJobFence } from '../generation/fence.js'
import { type JobClaim, type JobFence } from '../jobs/types.js'
import { workerErrorCode } from '../jobs/worker-diagnostics.js'
import { confirmedDialogueLock, markConfirmedDialogueLock } from '../sources/processing-pins.js'
import {SourceUnavailableError, type SourceScope, type SourceVersion} from '@pocketctl/session-source'

type Db = Pick<pg.Pool, 'query'>
export type DialogueGeneration = {install:string; session:string; turn:string; generation:string; fence:JobFence}
export class DialogueSuperseded extends Error {
  constructor(){super('dialogue_generation_changed')}
}
const stages=new WeakMap<object,string>()
export function markDialogueStage(error:unknown,stage:'prepare'|'publish'){
  if(error && typeof error==='object')stages.set(error,stage)
}
export const identity = (g:DialogueGeneration)=>[g.install,g.session,g.turn,g.generation]
const finished = ['published','not_admitted','input_gap','superseded','failed']

export async function dialogueAlreadyProcessed(db:Db,g:DialogueGeneration) {
  const result=await db.query(`SELECT t.requested_generation,r.status FROM memory_dialogue_turns t
    LEFT JOIN memory_dialogue_compile_receipts r ON (r.installation_id,r.session_id,r.turn_id)=(t.installation_id,t.session_id,t.turn_id)
      AND r.generation=$4 WHERE (t.installation_id,t.session_id,t.turn_id)=($1,$2,$3)`,identity(g))
  if(result.rows[0]?.requested_generation!==g.generation)throw new DialogueSuperseded()
  return finished.includes(result.rows[0].status)
}

// Observe the current root vector, then take its ordinary source fence. Once
// held no root write can slip between the second inventory and COMMIT. Check
// the original rights/storage plus the turn lock before reading that inventory.
export async function lockDialogueInput(db:Db,g:DialogueGeneration,ctx:{scope:SourceScope;root:string;version:SourceVersion}){
  const result=await db.query(`WITH a AS MATERIALIZED(SELECT * FROM shared.memory_relay_source_authority($1::jsonb,'relay_event',$2)),
   locked AS MATERIALIZED(SELECT CASE WHEN state='current' AND authorization_revision=$3 AND storage_revision=$4
      THEN shared.lock_memory_personal_source_commit($1::jsonb,'relay_event',$2,
        jsonb_build_object('content',content_revision,'authorization',authorization_revision,'storage',storage_revision),FALSE)
      ELSE FALSE END AS valid FROM a)
   SELECT valid,current_setting('pocketctl.personal_commit_reason',true) AS reason FROM locked`,
   [ctx.scope,ctx.root,ctx.version.authorization,ctx.version.storage])
  if(!result.rows[0]?.valid){
    if(result.rows[0]?.reason==='lock_conflict')throw markConfirmedDialogueLock(new SourceUnavailableError('source_store_busy'))
    throw new SourceUnavailableError('changed')
  }
  const lock=await db.query(`SELECT pg_try_advisory_xact_lock(hashtextextended('turn-dialogue:'||$1::text||':'||$2||':'||$3,0)) AS held`,
    [g.install,g.session,g.turn])
  if(!lock.rows[0]?.held)throw Object.assign(new Error('dialogue_commit_lock_busy'),{code:'55P03'})
  const current=await db.query('SELECT state,content_revision FROM shared.memory_dialogue_version($1,$2,$3)',[ctx.scope,ctx.root,g.turn])
  if(current.rows[0]?.state!=='current'||current.rows[0].content_revision!==g.generation)throw new DialogueSuperseded()
}
export async function recordDialogueResult(db:Db,g:DialogueGeneration,status:string,reason:string|null,digest:string|null){
  await db.query(`INSERT INTO memory_dialogue_compile_receipts(installation_id,session_id,turn_id,generation,job_id,claim_epoch,status,reason,input_digest,closed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
    ON CONFLICT(installation_id,session_id,turn_id,generation) DO UPDATE SET
    status=excluded.status,reason=excluded.reason,input_digest=excluded.input_digest,claim_epoch=excluded.claim_epoch,
    closed_at=excluded.closed_at,updated_at=clock_timestamp(),next_probe_at=NULL
    WHERE memory_dialogue_compile_receipts.status IN('retrying','failed')`,
    [...identity(g),g.fence.jobId,g.fence.claimEpoch,status,reason,digest])
}
export function generationForJob(job:JobClaim,fence:JobFence):DialogueGeneration|undefined{
  const {dialogue_session:session,turn,dialogue_generation:generation}=job.payload
  if(job.job_type==='compile_episode'&&job.installation_id&&job.idempotency_key.startsWith('dialogue:')&&typeof session==='string'&&typeof turn==='string'
      &&typeof generation==='string'&&/^[1-9][0-9]{0,18}$/.test(generation))
    return {install:job.installation_id,session,turn,generation,fence}
}
// Failure settlement is its own transaction, after source pins and rolled back
// output have released their connections. An uncertain output COMMIT is
// resolved by querying the receipt under the original job lock.
export async function settleDialogueFailure(pool:pg.Pool,g:DialogueGeneration,error:unknown){
  const db=await pool.connect()
  try{
    await db.query('BEGIN')
    await assertJobFence(db,g.fence)
    const current=await db.query(`SELECT t.requested_generation,r.status,r.attempts,r.first_failed_at,
       r.first_failed_at<clock_timestamp()-interval '2 minutes' AS exhausted,j.attempts AS claims,
       j.payload->>'dialogue_generation' AS dispatched
      FROM memory_jobs j LEFT JOIN memory_dialogue_turns t ON (t.installation_id,t.session_id,t.turn_id)=($1,$2,$3)
      LEFT JOIN memory_dialogue_compile_receipts r ON (r.installation_id,r.session_id,r.turn_id,r.generation)=($1,$2,$3,$4)
      WHERE j.job_id=$5`,[...identity(g),g.fence.jobId])
    const row=current.rows[0],superseded=row?.requested_generation!==g.generation
    let retryMs=0,reason:string|null=null
    if(row?.requested_generation && !finished.includes(row.status)){
      if(superseded)await recordDialogueResult(db,g,'superseded','new_generation',null)
      else{
        reason=confirmedDialogueLock(error)?'lock_conflict':error instanceof Error&&error.message==='source_reference_unavailable'?'source_reference_unavailable':workerErrorCode(error)
        const attempts=Math.max(Number(row.attempts??0)+1,Number(row.claims))
        const stage=typeof error==='object'&&error?stages.get(error)??'capture_or_ack':'capture_or_ack'
        const fingerprint=createHash('sha256').update([stage,reason,error instanceof Error?error.name:typeof error,
          error instanceof Error?error.stack?.split('\n').find(line=>line.trim().startsWith('at '))?.trim():undefined].join('|')).digest('hex')
        const waits=[1000,5000,20000]
        if(attempts<=waits.length&&!row.exhausted)retryMs=waits[attempts-1]+Math.floor(Math.random()*400)
        await db.query(`INSERT INTO memory_dialogue_compile_receipts(installation_id,session_id,turn_id,generation,
          job_id,claim_epoch,status,reason,attempts,first_failed_at,closed_at,next_probe_at,last_step,error_fingerprint,processor_revision)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),
           CASE WHEN $7='failed' THEN clock_timestamp() END,
           CASE WHEN $7='failed' AND $8 IN('lock_conflict','source_reference_unavailable','changed','revoked') THEN clock_timestamp()+interval '1 minute' END,$10,$11,$12)
         ON CONFLICT(installation_id,session_id,turn_id,generation) DO UPDATE SET status=excluded.status,
           claim_epoch=excluded.claim_epoch,reason=excluded.reason,attempts=excluded.attempts,
           first_failed_at=COALESCE(memory_dialogue_compile_receipts.first_failed_at,excluded.first_failed_at),
           updated_at=clock_timestamp(),closed_at=excluded.closed_at,next_probe_at=CASE WHEN excluded.next_probe_at IS NOT NULL THEN
            clock_timestamp()+interval '1 minute'*LEAST(60,memory_dialogue_compile_receipts.probes+1) END,
           last_step=excluded.last_step,error_fingerprint=excluded.error_fingerprint,processor_revision=excluded.processor_revision`,
          [...identity(g),g.fence.jobId,g.fence.claimEpoch,retryMs?'retrying':'failed',reason,attempts,stage,fingerprint,DIALOGUE_PROCESSOR_REVISION])
      }
    }
    const pending=retryMs>0||row?.dispatched!==g.generation
    if(pending)await releaseJobFence(db,g.fence,'pending')
    await db.query(`UPDATE memory_jobs SET state=$2,claimed_by=CASE WHEN $2='completed' THEN claimed_by END,claim_expires_at=NULL,last_error_code=$3,
      completed_at=CASE WHEN $2='completed' THEN clock_timestamp() END,available_at=clock_timestamp()+$4*interval '1 millisecond'
      WHERE job_id=$1`,[g.fence.jobId,pending?'pending':'completed',reason,retryMs])
    await db.query('COMMIT')
    return pending?'deferred' as const:'completed' as const
  }catch(e){await db.query('ROLLBACK').catch(()=>undefined);throw e}finally{db.release()}
}
