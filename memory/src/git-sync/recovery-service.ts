import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import type { V2GrantFacts } from '../governance/authorization.js'
import { canonicalPayloadHash } from '../inbox/canonical-json.js'
import { requireGitPermission,requireCurrentGitAuthorization,lockGitPolicyScopes } from './authorization.js'
import { gitQueueTransaction,gitAdmissionMode,type GitQueueDeps } from './inbox-service.js'
import { lockGitConnection,type GitConnection } from './repository.js'
import { FixedGitTarget } from './read-adapter.js'
import { GitReadError,type GitReadResponse } from './provider.js'
import type { GitRecognitionRequest,GitRemoteMetadata } from './remote-recognition.js'

/** A fresh server-owned READ consent; contains no method for remote mutation. */
export interface GitRecoveryReadCapability {
  kind:'fixture'|'live';provider:'github'|'gitee';target:FixedGitTarget
  request(request:GitRecognitionRequest,signal:AbortSignal):Promise<GitReadResponse>
}
export interface GitRecoveryReadRegistry {resolve(c:GitConnection):Promise<GitRecoveryReadCapability|null>}
export function assertRecoveryTarget(c:GitConnection,metadata:GitRemoteMetadata,cap:GitRecoveryReadCapability,mode:'shadow'|'enabled') {
  if(mode==='shadow'&&cap.kind!=='fixture'||cap.provider!==c.provider||cap.provider!==metadata.provider
    ||JSON.stringify(FixedGitTarget.parse(cap.target))!==JSON.stringify(FixedGitTarget.parse(metadata.target))
    ||cap.target.providerRepositoryId!==c.providerRepositoryId||cap.target.branch!==c.targetBranch)throw new GitReadError('read_not_authorized')
}
export async function loadGitRecoveryMetadata(client:Pick<pg.PoolClient,'query'>,installationId:string,connectionId:string,exportId:string):Promise<GitRemoteMetadata> {
  const row=(await client.query(`SELECT * FROM memory_git_remote_cleanup WHERE installation_id=$1 AND connection_id=$2 AND export_id=$3 AND cleanup_pending`,[installationId,connectionId,exportId])).rows[0]
  if(!row||!['github','gitee'].includes(row.provider)||!row.expected_commit||!row.expected_tree||!row.description_hash)throw new GitReadError('reconcile_unverifiable')
  const target=FixedGitTarget.safeParse({providerRepositoryId:row.provider_repository_id,owner:row.target_owner,repository:row.target_repository,private:row.target_private,branch:row.target_branch})
  if(!target.success)throw new GitReadError('reconcile_unverifiable')
  return {oldRunId:row.old_run_id,installationId,connectionId,exportId,provider:row.provider,target:target.data,branch:row.remote_branch,
    commit:row.expected_commit,tree:row.expected_tree,descriptionHash:row.description_hash}
}
const request=z.object({installationId:z.uuid(),connectionId:z.uuid(),exportId:z.uuid(),expectedGeneration:z.string().regex(/^[1-9][0-9]{0,18}$/),
  idempotencyKey:z.string().min(1).max(128)}).strict()
const factsSchema=z.object({primaryInstallationId:z.uuid(),configVersion:z.string(),scopeBindings:z.array(z.object({installation_id:z.uuid(),
  owner_scope_kind:z.enum(['personal','team','organization']),owner_scope_id:z.string(),membership_id:z.string().nullable(),membership_revision:z.string(),authorization_epoch:z.string(),permissions:z.array(z.string()).max(16)})).max(64)})
export function createGitRecoveryService(deps:GitQueueDeps&{recoveryReads?:GitRecoveryReadRegistry}) {
  return {async admit(grant:V2GrantFacts,raw:unknown):Promise<{runId:string;jobId:string|null;duplicate:boolean}> {
    const s=request.parse(raw),facts=factsSchema.parse(grant) as V2GrantFacts
    return gitQueueTransaction(deps.pool,async client=>{
      await lockGitPolicyScopes(client,facts,s.installationId)
      const stamp=await requireGitPermission(client,facts,s.installationId,'contribute')
      const c=await lockGitConnection(client,s.installationId,s.connectionId,s.expectedGeneration),mode=await gitAdmissionMode(deps,c)
      const metadata=await loadGitRecoveryMetadata(client,s.installationId,s.connectionId,s.exportId)
      const cap=await deps.recoveryReads?.resolve(c)
      if(!cap)throw new GitReadError('read_not_authorized')
      assertRecoveryTarget(c,metadata,cap,mode)
      const hash=canonicalPayloadHash({operation:'recovery',exportId:s.exportId,idempotencyKey:s.idempotencyKey,membershipId:stamp.membershipId,
        membershipRevision:stamp.membershipRevision,authorizationEpoch:stamp.authorizationEpoch}).toString('hex')
      const existing=(await client.query(`SELECT p.run_id,r.job_id FROM memory_git_run_receipts p LEFT JOIN memory_git_runs r USING(installation_id,run_id)
        WHERE p.installation_id=$1 AND p.connection_id=$2 AND p.generation=$3 AND p.request_hash=$4`,[s.installationId,s.connectionId,s.expectedGeneration,hash])).rows[0]
      if(existing)return {runId:existing.run_id,jobId:existing.job_id??null,duplicate:true}
      const runId=randomUUID(),jobId=randomUUID()
      await client.query(`INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,payload) VALUES($1,$2,'git_reconcile',$3,79,$4)`,[jobId,s.installationId,`git:${runId}`,{runId}])
      await client.query(`INSERT INTO memory_git_runs(run_id,installation_id,connection_id,generation,direction,mode,outcome_kind,state,
        membership_id,membership_revision,authorization_epoch,config_version,request_hash,job_id,grant_facts,trigger_source,recovery_export_id,expires_at)
        VALUES($1,$2,$3,$4,'import',$5,$6,'received',$7,$8,$9,$10,$11,$12,$13,'recovery',$14,clock_timestamp()+($15*interval '1 millisecond'))`,
      [runId,s.installationId,s.connectionId,s.expectedGeneration,mode,deps.outcomeKind??'fixture',stamp.membershipId,stamp.membershipRevision,stamp.authorizationEpoch,stamp.configVersion,
        hash,jobId,facts,s.exportId,deps.config.maxTaskAgeMs])
      await client.query(`INSERT INTO memory_git_run_receipts(installation_id,connection_id,generation,run_id,request_hash,admission_hash,outcome_kind,state)
        VALUES($1,$2,$3,$4,$5,$5,$6,'received')`,[s.installationId,s.connectionId,s.expectedGeneration,runId,hash,deps.outcomeKind??'fixture'])
      await requireCurrentGitAuthorization(client,stamp,'contribute')
      return {runId,jobId,duplicate:false}
    })
  }}
}
