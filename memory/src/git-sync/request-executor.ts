import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { GitSyncConfig } from './config.js'
import type { JobFence } from '../jobs/types.js'
import { GitReadError,type GitReadResponse } from './provider.js'
import { gitQueueTransaction } from './inbox-service.js'

export type GitRequestOperation='repository'|'merge'|'commit'|'tree'|'poll'|'write_tree'|'write_commit'|'write_branch'|'write_file'|'write_pull_request'|'reconcile'
interface BudgetRun{http_attempts:number;failure_count:number;expires_at:Date}
/** The owner holds the shared dispatcher SESSION gate. Each transaction callback
 * rechecks current authorization, key status, connection, run and job fence. This
 * executor commits one durable reservation before exactly one provider attempt. */
export function createGitRequestExecutor(deps:{pool:pg.Pool;config:GitSyncConfig;installationId:string;runId:string;fence:JobFence;signal:AbortSignal;
  withRun<T>(run:(client:pg.PoolClient,current:BudgetRun)=>Promise<T>):Promise<T>}) {
  return async(operation:GitRequestOperation,perform:(signal:AbortSignal)=>Promise<GitReadResponse>,success:readonly number[]=[200]):Promise<GitReadResponse>=>{
    if(deps.signal.aborted)throw new GitReadError('request_aborted')
    const reservation=await deps.withRun(async(client,current)=>{
      if(current.expires_at.getTime()<=Date.now())throw new GitReadError('run_expired')
      if(current.http_attempts>=deps.config.maxHttpAttempts)throw new GitReadError('request_budget_exhausted')
      if(current.failure_count>=deps.config.maxFailures)throw new GitReadError('failure_budget_exhausted')
      const id=randomUUID(),attempt=current.http_attempts+1
      await client.query(`INSERT INTO memory_git_request_reservations(reservation_id,installation_id,run_id,attempt,job_id,claim_epoch,operation,request_limit,byte_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,deps.installationId,deps.runId,attempt,deps.fence.jobId,deps.fence.claimEpoch,operation,deps.config.maxHttpAttempts,deps.config.maxTotalBytes])
      await client.query('UPDATE memory_git_runs SET http_attempts=$2 WHERE run_id=$1',[deps.runId,attempt])
      await client.query('UPDATE memory_git_run_receipts SET attempts=$2 WHERE installation_id=$3 AND run_id=$1',[deps.runId,attempt,deps.installationId])
      return id
    })
    const requestController=new AbortController(),stop=()=>requestController.abort()
    deps.signal.addEventListener('abort',stop,{once:true});if(deps.signal.aborted)stop()
    const timeout=setTimeout(stop,deps.config.requestTimeoutMs)
    let rejectAbort:(e:Error)=>void=()=>undefined
    const cancelled=new Promise<never>((_resolve,reject)=>{rejectAbort=reject})
    const onAbort=()=>rejectAbort(new GitReadError(deps.signal.aborted?'request_aborted':'request_timeout',!deps.signal.aborted))
    requestController.signal.addEventListener('abort',onAbort,{once:true})
    // Metadata accounting does not assert content authority or revive runs. It
    // also works after cancellation/fence loss, preserving spent response bytes.
    let started:number|undefined
    async function account(bytes:number,state:'responded'|'failed'|'aborted',countsFailure=false){
      if(!Number.isSafeInteger(bytes)||bytes<0)throw new GitReadError('response_limit')
      const duration=started===undefined?null:(performance.now()-started)/1000
      return gitQueueTransaction(deps.pool,async client=>{
        const row=(await client.query<{response_bytes:string}>('SELECT response_bytes::text FROM memory_git_request_reservations WHERE reservation_id=$1 FOR UPDATE',[reservation])).rows[0]
        if(!row)return 0
        const delta=Math.max(0,bytes-Number(row.response_bytes))
        await client.query(`UPDATE memory_git_request_reservations SET state=$2,response_bytes=GREATEST(response_bytes,$3),counts_failure=counts_failure OR $4,
          duration_seconds=COALESCE(duration_seconds,$5) WHERE reservation_id=$1`,[reservation,state,bytes,countsFailure,duration])
        const total=(await client.query<{byte_count:string}>('UPDATE memory_git_runs SET byte_count=byte_count+$2 WHERE run_id=$1 RETURNING byte_count::text',[deps.runId,delta])).rows[0]
        return Number(total?.byte_count??0)
      })
    }
    let observedBytes=0
    try {
      if(requestController.signal.aborted)throw new GitReadError('request_aborted')
      started=performance.now()
      const attempt=perform(requestController.signal).catch(async error=>{
        if(error instanceof GitReadError&&error.receivedBytes>0){observedBytes=error.receivedBytes
          await account(observedBytes,requestController.signal.aborted?'aborted':'failed',!deps.signal.aborted&&error.retryable)}
        throw error
      })
      const response=await Promise.race([attempt,cancelled]);observedBytes=response.receivedBytes??0
      const total=await account(observedBytes,'responded')
      if(total>deps.config.maxTotalBytes)throw new GitReadError('response_limit')
      if(deps.signal.aborted)throw new GitReadError('request_aborted')
      await deps.withRun(async()=>undefined)
      if(!success.includes(response.status))throw new GitReadError(response.status===429?'provider_rate_limited':response.status===409||response.status===422?'provider_conflict':'provider_failure',
        response.status===429||response.status>=500,Number.isFinite(response.retryAfterMs)?Math.max(1000,response.retryAfterMs!):1000)
      return response
    }catch(error){
      await account(error instanceof GitReadError?Math.max(observedBytes,error.receivedBytes):observedBytes,
        requestController.signal.aborted?'aborted':'failed',!deps.signal.aborted&&(!(error instanceof GitReadError)||error.retryable)).catch(()=>undefined)
      throw error
    }finally{clearTimeout(timeout);deps.signal.removeEventListener('abort',stop);requestController.signal.removeEventListener('abort',onAbort)}
  }
}
