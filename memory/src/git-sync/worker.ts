import type pg from 'pg'
import type { V2GrantFacts } from '../governance/authorization.js'
import type { JobFence } from '../jobs/types.js'
import type { JobHandler } from '../jobs/worker.js'
import type { GitAuthorizationStamp } from './authorization.js'
import { requireCurrentGitAuthorization } from './authorization.js'
import { lockGitConnection,type GitConnection } from './repository.js'
import { createGitProposalService } from './proposal-service.js'
import { createGitExportService } from './export-service.js'
import { gitAdmissionMode,gitQueueTransaction,insertGitQueuedRun,type GitQueueDeps,type GitPrincipal } from './inbox-service.js'
import { assertGitReadTarget,CommitRead,GitReadError,MergeObservation,parseGitRead,PollRead,TreeRead,
  type GitReadCapability,type GitReadRegistry,type GitReadRequest,type VerifiedGitMerge } from './provider.js'
import type { RepositoryFile } from './types.js'
import { validateRepositoryFiles } from './paths.js'
import { createGitRequestExecutor } from './request-executor.js'
import { isDatabaseRegistry } from './key-registry.js'
import { dispatchGitOutbox } from './outbox-service.js'
import type { GitFixtureWriteRegistry } from './write-protocol.js'
import { loadGitRecoveryMetadata,assertRecoveryTarget,type GitRecoveryReadRegistry } from './recovery-service.js'
import { recognizeGitRemoteOperation } from './remote-recognition.js'

interface Run {
  run_id:string;installation_id:string;connection_id:string;generation:string;export_id:string;job_id:string;grant_facts:V2GrantFacts
  membership_id:string;membership_revision:string;authorization_epoch:string;config_version:string;mode:'shadow'|'enabled';state:string
  change_number:string|null;trigger_source:string;http_attempts:number;failure_count:number;next_attempt_at:Date|null;expires_at:Date;recovery_export_id:string|null
}
export interface GitWorkerDeps extends GitQueueDeps {
  reads?:GitReadRegistry
  recoveryReads?:GitRecoveryReadRegistry
  /** Testing modules only. Runtime composition never supplies this property. */
  fixtureWrites?:GitFixtureWriteRegistry
  keys?:Parameters<typeof createGitExportService>[0]['keys']
  skill?:Parameters<typeof createGitExportService>[0]['skill']
}
const terminal=new Set(['planned','applied','dead','cancelled','invalidated','authorization_stale','closed'])
const columns=`*,generation::text,membership_revision::text,authorization_epoch::text,config_version::text`
const subject=(r:Run)=>({installationId:r.installation_id,connectionId:r.connection_id,exportId:r.export_id,expectedGeneration:r.generation})
function stamp(r:Run):GitAuthorizationStamp {
  const b=r.grant_facts?.scopeBindings.find(b=>b.installation_id===r.installation_id)
  if(!b||b.owner_scope_kind==='personal')throw new GitReadError('authorization_stale')
  return {installationId:r.installation_id,ownerScopeKind:b.owner_scope_kind,ownerScopeId:b.owner_scope_id,membershipId:r.membership_id,
    membershipRevision:r.membership_revision,authorizationEpoch:r.authorization_epoch,configVersion:r.config_version}
}
async function jobFence(client:pg.PoolClient,r:Run,fence:JobFence) {
  const valid=await client.query(`SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_id=$2 AND claimed_by=$3
    AND claim_epoch=$4 AND state='running' AND claim_expires_at>clock_timestamp() FOR UPDATE`,[r.installation_id,fence.jobId,fence.claimedBy,fence.claimEpoch])
  if(fence.jobId!==r.job_id||!valid.rowCount)throw new GitReadError('lease_lost')
}
async function lockRun(client:pg.PoolClient,r:Run) {
  const value=(await client.query<Run>(`SELECT ${columns} FROM memory_git_runs WHERE installation_id=$1 AND run_id=$2 FOR UPDATE`,[r.installation_id,r.run_id])).rows[0]
  if(!value||terminal.has(value.state))throw new GitReadError('run_terminal')
  return value
}
/** Shared session advisory gate serializes all Git types across processes. It
 * holds no transaction or row lock across external I/O; connection loss aborts.
 * Every request first commits a reservation, which is never refunded on crash. */
export function createGitSyncWorker(deps:GitWorkerDeps) {
  if(deps.config.mode!=='off'&&(deps.pool.options.max??10)<2)throw new GitReadError('git_pool_capacity')
  let locallyBusy=false
  const waiters=new Set<()=>void>()
  async function acquireLocal(signal:AbortSignal,deadline:Date) {
    while(locallyBusy)await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);waiters.delete(ready);signal.removeEventListener('abort',cancel)}
      const ready=()=>{cleanup();resolve()},cancel=()=>{cleanup();reject(new GitReadError('request_aborted'))}
      const timer=setTimeout(()=>{cleanup();reject(new GitReadError('run_expired'))},Math.max(0,deadline.getTime()-Date.now()))
      waiters.add(ready);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel()
    })
    if(signal.aborted)throw new GitReadError('request_aborted')
    if(deadline.getTime()<=Date.now())throw new GitReadError('run_expired')
    locallyBusy=true
    return ()=>{locallyBusy=false;waiters.values().next().value?.()}
  }
  async function withRun<T>(r:Run,fence:JobFence,fn:(client:pg.PoolClient,current:Run,c:GitConnection)=>Promise<T>,early?:(client:pg.PoolClient)=>Promise<void>) {
    return gitQueueTransaction(deps.pool,async client=>{
      if(deps.keys&&isDatabaseRegistry(deps.keys)){
        await deps.keys.transactionView(client)
        const key=r.trigger_source==='recovery'?{rowCount:1}:await client.query(`SELECT 1 FROM memory_git_snapshot_keys b JOIN memory_git_attestation_keys k USING(key_id)
          WHERE b.installation_id=$1 AND b.connection_id=$2 AND b.export_id=$3 AND k.state<>'revoked'`,[r.installation_id,r.connection_id,r.export_id])
        if(!key.rowCount)throw new GitReadError('git_attestation_invalid')
      }
      await early?.(client)
      await requireCurrentGitAuthorization(client,stamp(r),'contribute')
      const c=await lockGitConnection(client,r.installation_id,r.connection_id,r.generation)
      await gitAdmissionMode(deps,c)
      const current=await lockRun(client,r)
      await jobFence(client,current,fence)
      return fn(client,current,c)
    })
  }
  async function durableFailures(client:pg.PoolClient,r:Run):Promise<number> {
    const evidence=(await client.query<{failures:number}>(`SELECT GREATEST(p.failures,(SELECT COUNT(*)::int FROM memory_git_request_reservations a
      WHERE a.installation_id=p.installation_id AND a.run_id=p.run_id AND a.counts_failure)) AS failures
      FROM memory_git_run_receipts p WHERE p.installation_id=$1 AND p.run_id=$2`,[r.installation_id,r.run_id])).rows[0]
    return Math.min(5,Math.max(r.failure_count,evidence?.failures??0))
  }
  async function finish(client:pg.PoolClient,r:Run,fence:JobFence,state:'planned'|'duplicate'|'observed',merge?:Pick<VerifiedGitMerge,'mergeCommit'|'tree'|'actorId'>) {
    await jobFence(client,r,fence)
    const alive=await client.query('SELECT 1 FROM memory_git_runs WHERE run_id=$1 AND expires_at>clock_timestamp()',[r.run_id])
    if(!alive.rowCount)throw new GitReadError('run_expired')
    await client.query(`UPDATE memory_git_runs SET state=$5,merge_commit=$2,tree_sha=$3,provider_actor_id=$4,
      updated_at=NOW(),error_code=$6 WHERE run_id=$1`,[r.run_id,merge?.mergeCommit??null,merge?.tree??null,merge?.actorId??null,state==='observed'?'closed':'planned',state==='observed'?'not_merged':null])
    await client.query(`UPDATE memory_git_run_receipts SET state=$2,eligible=$3,unfinished=false,reason_code=$5,updated_at=NOW() WHERE installation_id=$4 AND run_id=$1`,
      [r.run_id,state==='observed'?'rejected':state,!!merge&&state!=='duplicate',r.installation_id,state==='observed'?'not_merged':null])
    await client.query(`UPDATE memory_git_inbox SET state=$2 WHERE installation_id=$3 AND run_id=$1`,[r.run_id,state==='duplicate'?'duplicate':'processed',r.installation_id])
    await client.query(`UPDATE memory_jobs SET state='completed',completed_at=NOW(),claim_expires_at=NULL,last_error_code=NULL WHERE job_id=$1`,[fence.jobId])
  }
  async function releaseLostLease(r:Run,fence:JobFence) {
      // Generic completion checks epoch, but not wall-clock expiry. Release our
      // expired, unreclaimed claim first so that wrapper cannot complete it.
      const released=await deps.pool.query(`UPDATE memory_jobs SET state='pending',claimed_by=NULL,claim_expires_at=NULL,available_at=NOW()
        WHERE installation_id=$1 AND job_id=$2 AND state='running' AND claimed_by=$3 AND claim_epoch=$4
          AND claim_expires_at<=clock_timestamp()`,[r.installation_id,fence.jobId,fence.claimedBy,fence.claimEpoch])
      if(released.rowCount)return
      const stillOwned=await deps.pool.query(`SELECT 1 FROM memory_jobs WHERE installation_id=$1 AND job_id=$2
        AND state='running' AND claimed_by=$3 AND claim_epoch=$4`,[r.installation_id,fence.jobId,fence.claimedBy,fence.claimEpoch])
      if(stillOwned.rowCount)throw new GitReadError('failure_persistence_failed',true)
  }
  async function fail(r:Run,fence:JobFence,error:unknown,aborted:boolean) {
    // Only bounded codes reach persistence; provider exceptions are never logged.
    const e=error instanceof GitReadError?error:new GitReadError('provider_failure',true)
    if(e.code==='lease_lost') {
      await releaseLostLease(r,fence);return
    }
    if(e.code==='run_terminal')return
    let failureFacts:{failures:number;code:string}|undefined
    try{await gitQueueTransaction(deps.pool,async client=>{
      const c=await lockGitConnection(client,r.installation_id,r.connection_id)
      const current=await lockRun(client,r);await jobFence(client,current,fence)
      const recovered=await durableFailures(client,current)
      const exhausted=recovered>=deps.config.maxFailures||current.expires_at.getTime()<=Date.now()
      // The same failed reservation may already be in the receipt. Merge its
      // evidence with this transition, never increment it twice or regress it.
      const failures=Math.min(5,Math.max(recovered,current.failure_count+(e.retryable&&!aborted&&!['dispatcher_busy','retry_not_due'].includes(e.code)?1:0)))
      const dead=exhausted||failures>=deps.config.maxFailures||!e.retryable
      const state=aborted?'cancelled':dead?'dead':'received',code=aborted?'request_aborted':e.code
      failureFacts={failures,code}
      const delay=Math.min(deps.config.maxTaskAgeMs,Math.max(1000,e.retryAfterMs))
      await client.query(`UPDATE memory_git_runs SET state=$2,failure_count=$3,error_code=$4,next_attempt_at=clock_timestamp()+($5*interval '1 millisecond'),updated_at=NOW() WHERE run_id=$1`,[r.run_id,state,failures,code,delay])
      await client.query(`UPDATE memory_git_run_receipts SET state=$2,failures=GREATEST(failures,$3),reason_code=$4,updated_at=NOW() WHERE installation_id=$5 AND run_id=$1`,
        [r.run_id,state==='received'?'received':state,failures,code,r.installation_id])
      await client.query(`UPDATE memory_git_inbox SET state=$2 WHERE installation_id=$3 AND run_id=$1`,[r.run_id,state==='received'?'received':state==='cancelled'?'invalidated':'dead',r.installation_id])
      await client.query(`UPDATE memory_jobs SET state=$2,claim_expires_at=NULL,claimed_by=NULL,available_at=clock_timestamp()+($3*interval '1 millisecond'),last_error_code=$4
        WHERE job_id=$1`,[fence.jobId,state==='received'?'pending':'dead',delay,code])
      void c
    })}catch(persistenceError){
      if(persistenceError instanceof GitReadError&&persistenceError.code==='lease_lost'){await releaseLostLease(r,fence);return}
      if(persistenceError instanceof GitReadError&&persistenceError.code==='run_terminal')return
      // A rolled-back state write is not successful completion. Keep bounded
      // failure evidence separately when the database has already recovered.
      if(failureFacts)await deps.pool.query(`UPDATE memory_git_run_receipts p SET failures=GREATEST(p.failures,$3),reason_code=$4
        FROM memory_jobs j WHERE p.installation_id=$1 AND p.run_id=$2 AND j.installation_id=p.installation_id
          AND j.job_id=$5 AND j.state='running' AND j.claimed_by=$6 AND j.claim_epoch=$7`,
        [r.installation_id,r.run_id,failureFacts.failures,failureFacts.code,fence.jobId,fence.claimedBy,fence.claimEpoch]).catch(()=>undefined)
      throw new GitReadError('failure_persistence_failed',true)
    }
  }
  const handle:JobHandler=async(job,signal,ctx)=>{
    if(!ctx||typeof job.payload.runId!=='string'||!job.installation_id)return
    const r=(await deps.pool.query<Run>(`SELECT ${columns} FROM memory_git_runs WHERE installation_id=$1 AND run_id=$2 AND job_id=$3`,
      [job.installation_id,job.payload.runId,job.job_id])).rows[0]
    if(!r||terminal.has(r.state))return
    if(deps.config.mode==='off'){await fail(r,ctx.fence,new GitReadError('feature_disabled'),signal.aborted);return}
    const fence=ctx.fence,controller=new AbortController(),abort=()=>controller.abort()
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    let gate:pg.PoolClient|undefined,releaseLocal:(()=>void)|undefined,acquired=false,watch:ReturnType<typeof setInterval>|undefined,checking=false
    const notify=(message:pg.Notification)=>{if([r.connection_id,`member:${r.installation_id}:${r.membership_id}`].includes(message.payload??''))abort()}
    try {
      releaseLocal=await acquireLocal(controller.signal,r.expires_at)
      gate=await deps.pool.connect()
      gate.on('error',abort);gate.on('end',abort);gate.on('notification',notify)
      acquired=(await gate.query<{locked:boolean}>(`SELECT pg_try_advisory_lock(hashtextextended('memory:git:dispatcher',0)) AS locked`)).rows[0].locked
      if(!acquired){
        gate.removeListener('error',abort);gate.removeListener('end',abort);gate.removeListener('notification',notify)
        gate.release();gate=undefined
        throw new GitReadError('dispatcher_busy',true,1000)
      }
      await gate.query('LISTEN memory_git_cancel')
      const c=await withRun(r,fence,async(client,current,c)=>{
        const recovered=await durableFailures(client,current)
        // The terminal transaction below re-reads the evidence and commits it
        // with dead state. Do not write a recovered count then throw it away.
        if(recovered>=deps.config.maxFailures)throw new GitReadError('failure_budget_exhausted')
        if(recovered>current.failure_count){
          current.failure_count=recovered
          await client.query('UPDATE memory_git_runs SET failure_count=$2 WHERE run_id=$1',[r.run_id,current.failure_count])
          await client.query('UPDATE memory_git_run_receipts SET failures=GREATEST(failures,$2) WHERE run_id=$1 AND installation_id=$3',[r.run_id,current.failure_count,r.installation_id])
        }
        if(current.expires_at.getTime()<=Date.now())throw new GitReadError('run_expired')
        if(current.failure_count>=deps.config.maxFailures)throw new GitReadError('failure_budget_exhausted')
        if(current.next_attempt_at&&current.next_attempt_at.getTime()>Date.now())throw new GitReadError('retry_not_due',true)
        return c
      })
      watch=setInterval(()=>{
        if(checking||controller.signal.aborted)return;checking=true
        void deps.pool.query(`SELECT 1 FROM memory_git_runs r JOIN memory_jobs j ON j.installation_id=r.installation_id AND j.job_id=r.job_id
          JOIN memory_git_connections c ON c.installation_id=r.installation_id AND c.connection_id=r.connection_id
          JOIN memory_scope_memberships m ON m.installation_id=r.installation_id AND m.membership_id=r.membership_id
          JOIN memory_owner_scopes s ON s.installation_id=r.installation_id JOIN memory_installations i ON i.installation_id=r.installation_id
          WHERE r.run_id=$1 AND j.state='running' AND j.claimed_by=$2 AND j.claim_epoch=$3 AND j.claim_expires_at>clock_timestamp()
            AND c.generation=r.generation AND c.state='active' AND c.sync_mode<>'off' AND m.state='active' AND m.membership_revision=r.membership_revision
            AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()) AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp())
            AND s.state='active' AND s.authorization_epoch=r.authorization_epoch AND i.config_version=r.config_version
            AND i.relay_status='active' AND i.local_status NOT IN('purging','purged','integrity_error') AND r.expires_at>clock_timestamp()`,
          [r.run_id,fence.claimedBy,fence.claimEpoch]).then(result=>{if(!result.rowCount)abort()}).catch(abort).finally(()=>{checking=false})
      },100)
      watch.unref?.()
      if(controller.signal.aborted)throw new GitReadError('request_aborted')
      if(r.trigger_source==='recovery') {
        if(job.job_type!=='git_reconcile'||r.export_id!==null||!r.recovery_export_id)throw new GitReadError('reconcile_not_authorized')
        const metadata=await loadGitRecoveryMetadata(deps.pool,r.installation_id,r.connection_id,r.recovery_export_id)
        const capability=await deps.recoveryReads?.resolve(c)
        if(!capability)throw new GitReadError('read_not_authorized')
        assertRecoveryTarget(c,metadata,capability,await gitAdmissionMode(deps,c))
        const execute=createGitRequestExecutor({pool:deps.pool,config:deps.config,installationId:r.installation_id,runId:r.run_id,fence,signal:controller.signal,
          withRun:fn=>withRun(r,fence,async(client,current,connection)=>{
            const fresh=await deps.recoveryReads?.resolve(connection)
            if(!fresh)throw new GitReadError('read_not_authorized')
            assertRecoveryTarget(connection,metadata,fresh,await gitAdmissionMode(deps,connection))
            return fn(client,current)
          })})
        const recognized=await recognizeGitRemoteOperation(metadata,{currentRunId:r.run_id,execute,read:(request,signal)=>capability.request(request,signal),
          record:proof=>withRun(r,fence,async(client,_current,connection)=>{
            const fresh=await deps.recoveryReads?.resolve(connection)
            if(!fresh)throw new GitReadError('read_not_authorized')
            assertRecoveryTarget(connection,metadata,fresh,await gitAdmissionMode(deps,connection))
            const recorded=await client.query(`UPDATE memory_git_remote_cleanup SET remote_pr_id=$4,recognized_at=NOW(),recognized_run_id=$5
              WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3 AND old_run_id=$6 AND expected_commit=$7 AND expected_tree=$8`,
            [r.installation_id,r.connection_id,r.recovery_export_id,proof.pullNumber,r.run_id,metadata.oldRunId,proof.commit,proof.tree])
            if(recorded.rowCount!==1)throw new GitReadError('reconcile_unverifiable')
            await client.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,export_id,run_id,action,outcome,reason_code)
              VALUES(gen_random_uuid(),$1,$2,$3,$4,'reconcile','allowed','ok')`,[r.installation_id,r.connection_id,r.recovery_export_id,r.run_id])
          })})
        await withRun(r,fence,async client=>{
          await client.query("UPDATE memory_git_runs SET state='closed',grant_facts=NULL,updated_at=NOW() WHERE run_id=$1",[r.run_id])
          await client.query("UPDATE memory_git_run_receipts SET state='planned',unfinished=false,reason_code=$3,updated_at=NOW() WHERE installation_id=$1 AND run_id=$2",[r.installation_id,r.run_id,recognized?'metadata_reconciled':'remote_unconfirmed'])
          await client.query("UPDATE memory_jobs SET state='completed',completed_at=NOW(),claim_expires_at=NULL WHERE job_id=$1",[fence.jobId])
        });return
      }
      if(job.job_type==='git_export') {
        if(!deps.keys||!deps.skill)throw new GitReadError('provider_unavailable')
        if(deps.fixtureWrites){
          if(deps.outcomeKind!=='fixture'||await gitAdmissionMode(deps,c)!=='shadow')throw new GitReadError('write_not_authorized')
          const capability=await deps.fixtureWrites.resolve(c)
          if(!capability||capability.kind!=='fixture'||capability.provider!==c.provider||capability.target.providerRepositoryId!==c.providerRepositoryId||capability.target.branch!==c.targetBranch)throw new GitReadError('write_not_authorized')
          const service=createGitExportService({pool:deps.pool,keys:deps.keys,skill:deps.skill})
          const execute=createGitRequestExecutor({pool:deps.pool,config:deps.config,installationId:r.installation_id,runId:r.run_id,fence,signal:controller.signal,withRun:fn=>withRun(r,fence,fn)})
          await dispatchGitOutbox({pool:deps.pool,service,grant:r.grant_facts,subject:subject(r),runId:r.run_id,capability,signal:controller.signal,
            execute,withRun:fn=>withRun(r,fence,fn),fence:async client=>{await lockRun(client,r);await jobFence(client,r,fence)}})
        }
        await createGitExportService({pool:deps.pool,keys:deps.keys,skill:deps.skill}).withRegisteredBase(r.grant_facts,subject(r),async context=>{
          await lockRun(context.client,r)
          if(controller.signal.aborted)throw new GitReadError('request_aborted')
          await finish(context.client,r,fence,'planned')
        });return
      }
      const capability=await deps.reads?.resolve(c)
      if(!capability)throw new GitReadError('provider_unavailable')
      assertGitReadTarget(c,capability,await gitAdmissionMode(deps,c))
      const execute=createGitRequestExecutor({pool:deps.pool,config:deps.config,installationId:r.installation_id,runId:r.run_id,fence,signal:controller.signal,
        withRun:fn=>withRun(r,fence,async(client,current,connection)=>{
          assertGitReadTarget(connection,capability!,await gitAdmissionMode(deps,connection))
          return fn(client,current)
        })})
      async function request(input:GitReadRequest) {
        const response=await execute(input.operation,async requestSignal=>{
          const result=await capability!.request(input,requestSignal)
          return {...result,receivedBytes:result.receivedBytes??(input.operation==='tree'&&result.status===200
            ?parseGitRead(TreeRead,result.body).files.reduce((sum,file)=>sum+file.bytes.byteLength,0):0)}
        })
        return response.body
      }
      if(capability.kind==='live')await request({operation:'repository'})
      if(job.job_type==='git_reconcile') {
        let cursor=(await deps.pool.query<{cursor:string|null}>('SELECT cursor FROM memory_git_connections WHERE connection_id=$1',[r.connection_id])).rows[0].cursor
        const seen=new Set<string>()
        do {
          const page=parseGitRead(PollRead,await request({operation:'poll',cursor}))
          if(page.providerRepositoryId!==c.providerRepositoryId||page.branch!==c.targetBranch||page.nextCursor&&seen.has(page.nextCursor))throw new GitReadError('provider_unverifiable')
          const principals=new Map<string,GitPrincipal>()
          await withRun(r,fence,async(client,current,connection)=>{
            if(controller.signal.aborted)throw new GitReadError('request_aborted')
            for(const change of page.changes){
              const exportId=change.exportId??(capability.kind==='fixture'?r.export_id:null),principal=exportId?principals.get(exportId):undefined
              if(!exportId||!principal)continue
              const alive=await client.query(`SELECT 1 FROM memory_git_sync_principals p JOIN memory_git_snapshots s USING(installation_id,connection_id,export_id)
                WHERE p.installation_id=$1 AND p.connection_id=$2 AND p.export_id=$3 AND p.generation=$4 AND s.generation=$4
                  AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp()) FOR SHARE OF p,s`,[r.installation_id,r.connection_id,exportId,r.generation])
              if(!alive.rowCount)continue
              await insertGitQueuedRun(client,{subject:{...subject(r),exportId},principal,
                mode:await gitAdmissionMode(deps,connection),trigger:{source:'poll',eventId:`poll:${r.run_id}:${change.number}`,changeNumber:change.number},maxTaskAgeMs:deps.config.maxTaskAgeMs,outcomeKind:deps.outcomeKind})
            }
            await client.query('UPDATE memory_git_connections SET cursor=$2 WHERE connection_id=$1',[r.connection_id,page.nextCursor])
            if(!page.nextCursor)await finish(client,current,fence,'planned')
          },async client=>{
            const hints=[...new Set(page.changes.map(change=>change.exportId??(capability.kind==='fixture'?r.export_id:null)).filter((v):v is string=>!!v))]
            const rows=(await client.query<GitPrincipal&{export_id:string}>(`SELECT p.export_id,p.grant_facts,p.authorization_stamp,p.generation::text
              FROM memory_git_sync_principals p JOIN memory_git_snapshots s USING(installation_id,connection_id,export_id)
              WHERE p.installation_id=$1 AND p.connection_id=$2 AND p.export_id=ANY($3::uuid[]) AND p.generation=$4 AND s.generation=$4
                AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp()) ORDER BY p.membership_id,p.export_id`,[r.installation_id,r.connection_id,hints,r.generation])).rows
            // Prelock child authorization before connection/run/snapshot locks.
            // The parent scanner's grant never confers a child's permission.
            await client.query('SELECT installation_id FROM memory_installations WHERE installation_id=$1 FOR SHARE',[r.installation_id])
            await client.query('SELECT installation_id FROM memory_owner_scopes WHERE installation_id=$1 FOR SHARE',[r.installation_id])
            await client.query(`SELECT membership_id FROM memory_scope_memberships WHERE installation_id=$1 AND membership_id=ANY($2::uuid[])
              ORDER BY membership_id FOR SHARE`,[r.installation_id,[r.membership_id,...rows.map(p=>p.authorization_stamp.membershipId)]])
            for(const principal of rows){try{await requireCurrentGitAuthorization(client,principal.authorization_stamp,'contribute');principals.set(principal.export_id,principal)}catch{/* ineligible locator; no child or denominator */}}
          })
          cursor=page.nextCursor;if(cursor)seen.add(cursor)
        }while(cursor)
        return
      }
      if(!r.change_number)throw new GitReadError('provider_unverifiable')
      const merge=parseGitRead(MergeObservation,await request({operation:'merge',number:r.change_number}))
      if(merge.providerRepositoryId!==c.providerRepositoryId||merge.baseBranch!==c.targetBranch||merge.number!==r.change_number||merge.exportId!==r.export_id)throw new GitReadError('provider_unverifiable')
      if(!merge.merged){await withRun(r,fence,async client=>{if(controller.signal.aborted)throw new GitReadError('request_aborted');await finish(client,r,fence,'observed')});return}
      const commit=parseGitRead(CommitRead,await request({operation:'commit',sha:merge.mergeCommit}))
      if(commit.sha!==merge.mergeCommit)throw new GitReadError('provider_unverifiable')
      const duplicate=await withRun(r,fence,async client=>{
        await client.query(`INSERT INTO memory_git_merge_receipts(installation_id,connection_id,generation,commit_sha,run_id,tree_sha)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[r.installation_id,r.connection_id,r.generation,merge.mergeCommit,r.run_id,commit.tree])
        const canonical=(await client.query<{run_id:string;tree_sha:string}>(`SELECT run_id,tree_sha FROM memory_git_merge_receipts
          WHERE installation_id=$1 AND connection_id=$2 AND generation=$3 AND commit_sha=$4`,[r.installation_id,r.connection_id,r.generation,merge.mergeCommit])).rows[0]
        if(!canonical||canonical.tree_sha!==commit.tree)throw new GitReadError('provider_unverifiable')
        if(canonical.run_id!==r.run_id){
          if(controller.signal.aborted)throw new GitReadError('request_aborted')
          await finish(client,r,fence,'duplicate',{...merge,tree:commit.tree})
          await client.query('UPDATE memory_git_run_receipts SET canonical_run_id=$2 WHERE run_id=$1 AND installation_id=$3',[r.run_id,canonical.run_id,r.installation_id])
          // A purged canonical run still has a durable identity. Do not require
          // its content row to survive just to retain a duplicate observation.
          const exists=await client.query('SELECT 1 FROM memory_git_runs WHERE run_id=$1 AND installation_id=$2',[canonical.run_id,r.installation_id])
          if(exists.rowCount){await client.query("UPDATE memory_git_inbox SET run_id=$2,state='duplicate' WHERE run_id=$1 AND installation_id=$3",[r.run_id,canonical.run_id,r.installation_id])
            await client.query('DELETE FROM memory_git_runs WHERE run_id=$1 AND installation_id=$2',[r.run_id,r.installation_id])}
          return true
        }
        await client.query("UPDATE memory_git_runs SET state='verified',merge_commit=$2,tree_sha=$3,provider_actor_id=$4 WHERE run_id=$1",[r.run_id,merge.mergeCommit,commit.tree,merge.actorId])
        await client.query("UPDATE memory_git_run_receipts SET state='verified',eligible=true,updated_at=NOW() WHERE installation_id=$2 AND run_id=$1",[r.run_id,r.installation_id])
        await client.query("UPDATE memory_git_inbox SET state='verified' WHERE installation_id=$2 AND run_id=$1",[r.run_id,r.installation_id])
        return false
      })
      if(duplicate)return
      const files:RepositoryFile[]=[],seen=new Set<string>();let cursor:string|null=null,bytes=0
      do {
        const page:{commit:string;tree:string;files:RepositoryFile[];nextCursor:string|null}=parseGitRead(TreeRead,await request({operation:'tree',commit:merge.mergeCommit,tree:commit.tree,cursor}))
        if(page.commit!==merge.mergeCommit||page.tree!==commit.tree||page.nextCursor&&seen.has(page.nextCursor))throw new GitReadError('provider_unverifiable')
        for(const file of page.files){bytes+=file.bytes.byteLength;if(file.bytes.byteLength>deps.config.maxFileBytes)throw new GitReadError('response_limit');files.push(file)}
        if(files.length>deps.config.maxFiles||bytes>deps.config.maxTotalBytes)throw new GitReadError('response_limit')
        cursor=page.nextCursor;if(cursor)seen.add(cursor)
      }while(cursor)
      validateRepositoryFiles(files)
      if(!deps.keys||!deps.skill)throw new GitReadError('provider_unavailable')
      const verified={...merge,tree:commit.tree,files}
      await createGitProposalService({pool:deps.pool,keys:deps.keys,skill:deps.skill}).planWithFinalizer(r.grant_facts,
        {...subject(r),headCommit:merge.mergeCommit,files},{
          before:async context=>{
            await gitAdmissionMode(deps,context.connection);await lockRun(context.client,r)
            const saved=(await context.client.query<{run_id:string;tree_sha:string}>(`SELECT run_id,tree_sha FROM memory_git_merge_receipts
              WHERE installation_id=$1 AND connection_id=$2 AND generation=$3 AND commit_sha=$4`,[r.installation_id,r.connection_id,r.generation,merge.mergeCommit])).rows[0]
            if(!saved||saved.run_id!==r.run_id||saved.tree_sha!==commit.tree)throw new GitReadError('provider_unverifiable')
            return true
          },
          finish:async(context,proposals)=>{
            if(controller.signal.aborted)throw new GitReadError('request_aborted')
            // The requester remains the original verified execution principal.
            // Provider actor is independent low-trust identity input for Task 7.
            for(const proposal of proposals)await context.client.query(`UPDATE memory_git_import_proposals SET run_id=$2,provider_actor_id=$3 WHERE proposal_id=$1 AND installation_id=$4`,
              [proposal.proposalId,r.run_id,merge.actorId,r.installation_id])
            await finish(context.client,r,fence,'planned',verified)
          },
        })
    } catch(error){await fail(r,fence,error,controller.signal.aborted)}
    finally {
      if(watch)clearInterval(watch);signal.removeEventListener('abort',abort)
      if(gate){
        gate.removeListener('notification',notify)
        try{await gate.query('UNLISTEN memory_git_cancel');if(acquired)await gate.query(`SELECT pg_advisory_unlock(hashtextextended('memory:git:dispatcher',0))`)}catch{abort()}
        gate.removeListener('error',abort);gate.removeListener('end',abort);gate.release(controller.signal.aborted?new Error('git_connection_released'):undefined)
      }
      releaseLocal?.()
    }
  }
  return {handle}
}
