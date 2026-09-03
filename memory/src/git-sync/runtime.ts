import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createPrivateKey } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { createGitHubReadCapability } from './github.js'
import { createGiteeReadCapability } from './gitee.js'
import { FixedGitTarget } from './read-adapter.js'
import { createGitTransport } from './transport.js'
import { createDatabaseAttestationRegistry } from './key-registry.js'
import { gitSyncModeForScope,type GitSyncConfig,type GitSyncMode } from './config.js'
import { createGitInboxService,type GitQueueDeps } from './inbox-service.js'
import { GitReadError,type GitReadRegistry } from './provider.js'
import type { GitConnection,GitTargetRegistry } from './repository.js'
import { parseStrictJson } from './strict-json.js'
import type { GitRecoveryReadRegistry } from './recovery-service.js'
import { gitWriteEndpoint } from './write-protocol.js'
const mode=z.enum(['off','shadow','enabled']),uuid=z.uuid()
const registration=FixedGitTarget.extend({installationId:uuid,repositoryId:uuid,targetId:z.string().min(1).max(256),
  provider:z.enum(['github','gitee']),credentialRef:z.string().min(1).max(512),credentialFile:z.string().min(1).max(1024),scopeMode:mode,
  webhookSecretFile:z.string().min(1).max(1024).optional()}).strict()
const registrySchema=z.object({targets:z.array(registration).max(128)}).strict()
const consentSchema=z.object({consents:z.array(z.object({installationId:uuid,connectionId:uuid,providerRepositoryId:z.string(),branch:z.string(),consentId:uuid,
  permission:z.literal('read'),expiresAt:z.iso.datetime()}).strict()).max(1024)}).strict()
/** Bounded explicit server-owned file. Secret paths never appear in DTO/errors. */
async function readRuntimeFile(path:string,secret=false):Promise<Buffer>{
  if(!isAbsolute(path))throw new GitReadError('git_runtime_config_invalid')
  let file:Awaited<ReturnType<typeof open>>|undefined
  try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await file.stat()
    if(!stat.isFile()||stat.size>262144||secret&&(stat.mode&0o077)!==0)throw new Error()
    const bytes=await file.readFile();if(bytes.byteLength>262144)throw new Error();return bytes
  }catch{throw new GitReadError('git_runtime_config_invalid')}finally{await file?.close()}
}
export async function createGitRuntime(deps:{pool:pg.Pool;config:GitSyncConfig;globalMode:GitSyncMode;sharedMode:GitSyncMode;
  env?:Record<string,string|undefined>;readFile?:(path:string)=>Promise<Buffer>;fetch?:typeof fetch}) {
  const env=deps.env??process.env,read=deps.readFile??readRuntimeFile
  const disabled=deps.config.mode==='off'||deps.globalMode==='off'
  const readTargets=async()=>{if(disabled||!env.MEMORY_GIT_TARGET_REGISTRY_PATH)return []
    try{return registrySchema.parse(parseStrictJson(await read(env.MEMORY_GIT_TARGET_REGISTRY_PATH))).targets}catch{throw new GitReadError('git_runtime_config_invalid')}}
  async function targetFor(c:GitConnection){const values=(await readTargets()).filter(t=>t.installationId===c.installationId&&t.repositoryId===c.repositoryId&&t.provider===c.provider&&t.providerRepositoryId===c.providerRepositoryId&&t.branch===c.targetBranch)
    if(values.length!==1)return null;return values[0]}
  const scopeMode=async(c:GitConnection):Promise<GitSyncMode>=>{if(disabled)return 'off';const target=await targetFor(c);if(!target)return 'off'
    return gitSyncModeForScope({globalMode:deps.globalMode,syncMode:deps.config.mode,connectionMode:c.syncMode,scopeMode:target.scopeMode,
      sharedMode:deps.sharedMode,ownerScopeKind:c.ownerScopeKind,installationActive:c.state==='active'})}
  const targets:GitTargetRegistry={resolve:async input=>{const values=(await readTargets()).filter(t=>t.installationId===input.installationId&&t.repositoryId===input.repositoryId&&t.targetId===input.targetId)
    if(values.length!==1)return null;const t=values[0];return {provider:t.provider,providerRepositoryId:t.providerRepositoryId,branch:t.branch,credentialRef:t.credentialRef}}}
  let keys:ReturnType<typeof createDatabaseAttestationRegistry>|undefined
  if(!disabled&&env.MEMORY_GIT_SIGNING_KEY_FILE){
    if(!env.MEMORY_GIT_SIGNING_KEY_ID)throw new GitReadError('git_runtime_config_invalid')
    try{const bytes=deps.readFile?await read(env.MEMORY_GIT_SIGNING_KEY_FILE):await readRuntimeFile(env.MEMORY_GIT_SIGNING_KEY_FILE,true)
      keys=createDatabaseAttestationRegistry({pool:deps.pool,signer:{keyId:env.MEMORY_GIT_SIGNING_KEY_ID,privateKey:createPrivateKey(bytes)}})
      await keys.registerSigner()
    }catch{throw new GitReadError('git_runtime_key_invalid')}
  }else if(!disabled)keys=createDatabaseAttestationRegistry({pool:deps.pool}) // verification only; never generate a signing key
  const consented=async(c:GitConnection)=>{
    if(await scopeMode(c)!=='enabled'||!env.MEMORY_GIT_READ_CONSENT_FILE)return false
    try{const entries=consentSchema.parse(parseStrictJson(await read(env.MEMORY_GIT_READ_CONSENT_FILE))).consents
      return entries.some(v=>v.installationId===c.installationId&&v.connectionId===c.connectionId&&v.providerRepositoryId===c.providerRepositoryId&&v.branch===c.targetBranch&&Date.parse(v.expiresAt)>Date.now())
    }catch{return false}
  }
  const reads:GitReadRegistry|undefined=disabled?undefined:{resolve:async c=>{
    if(!await consented(c))return null
    const target=await targetFor(c);if(!target)return null
    const current=(await deps.pool.query<{target_id:string;credential_ref:string}>(`SELECT target_id,credential_ref FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2`,[c.installationId,c.connectionId])).rows[0]
    if(!current||current.target_id!==target.targetId||current.credential_ref!==target.credentialRef)return null
    const fixed=FixedGitTarget.parse({providerRepositoryId:target.providerRepositoryId,owner:target.owner,repository:target.repository,branch:target.branch,private:target.private})
    const bytes=deps.readFile?await read(target.credentialFile):await readRuntimeFile(target.credentialFile,true),token=bytes.toString('utf8').trim()
    const cap=(target.provider==='github'?createGitHubReadCapability:createGiteeReadCapability)({target:fixed,transport:createGitTransport({provider:target.provider,token,maxResponseBytes:deps.config.maxTotalBytes,fetch:deps.fetch})})
    const original=cap.request.bind(cap)
    cap.request=async(request,signal)=>{const fresh=await targetFor(c)
      if(!await consented(c)||!fresh||JSON.stringify(fresh)!==JSON.stringify(target))throw new GitReadError('read_not_authorized')
      return original(request,signal)}
    return cap
  }}
  const recoveryReads:GitRecoveryReadRegistry|undefined=disabled?undefined:{resolve:async c=>{
    if(!await consented(c))return null
    const target=await targetFor(c);if(!target)return null
    const current=(await deps.pool.query<{target_id:string;credential_ref:string}>(`SELECT target_id,credential_ref FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2`,[c.installationId,c.connectionId])).rows[0]
    if(!current||current.target_id!==target.targetId||current.credential_ref!==target.credentialRef)return null
    const fixed=FixedGitTarget.parse({providerRepositoryId:target.providerRepositoryId,owner:target.owner,repository:target.repository,branch:target.branch,private:target.private})
    const bytes=deps.readFile?await read(target.credentialFile):await readRuntimeFile(target.credentialFile,true)
    const transport=createGitTransport({provider:target.provider,token:bytes.toString('utf8').trim(),maxResponseBytes:deps.config.maxTotalBytes,fetch:deps.fetch})
    return {kind:'live',provider:target.provider,target:fixed,request:async(request,signal)=>{
      const fresh=await targetFor(c)
      if(!await consented(c)||!fresh||JSON.stringify(fresh)!==JSON.stringify(target))throw new GitReadError('read_not_authorized')
      if(!['repository','branch','commit','tree','pulls'].includes(request.action))throw new GitReadError('read_not_authorized')
      const endpoint=gitWriteEndpoint(target.provider,fixed,request)
      if(endpoint.method!=='GET')throw new GitReadError('read_not_authorized')
      return transport(endpoint,signal)
    }}
  }}
  async function webhookRegistration(connectionId:string) {
    if(disabled||!uuid.safeParse(connectionId).success)return null
    const row=(await deps.pool.query(`SELECT installation_id,repository_id,provider,provider_repository_id,target_id,target_branch,credential_ref,state,sync_mode
      FROM memory_git_connections WHERE connection_id=$1`,[connectionId])).rows[0]
    if(!row||row.state!=='active'||row.sync_mode==='off')return null
    const registered=(await readTargets()).filter(t=>t.installationId===row.installation_id&&t.repositoryId===row.repository_id&&t.targetId===row.target_id
      &&t.provider===row.provider&&t.providerRepositoryId===row.provider_repository_id&&t.branch===row.target_branch&&t.credentialRef===row.credential_ref)
    if(registered.length!==1||!registered[0].webhookSecretFile)return null
    const target=registered[0],secret=(deps.readFile?await read(target.webhookSecretFile!):await readRuntimeFile(target.webhookSecretFile!,true)).toString('utf8').trim()
    if(!secret||secret.length>4096)throw new GitReadError('git_runtime_config_invalid')
    return {installationId:row.installation_id as string,provider:target.provider,providerRepositoryId:target.providerRepositoryId,targetBranch:target.branch,secret,
      eventType:target.provider==='github'?'pull_request':'Merge Request Hook'}
  }
  return {scopeMode,targets,reads,keys,recoveryReads,webhookRegistration}
}
/** Bounded polling admission; next_poll_at is the durable cross-process cadence.
 * No network in scheduler. Each provider page is dispatched by the queued worker. */
export function createGitPollingScheduler(deps:GitQueueDeps&{signal:AbortSignal;onError?:(code:string)=>void}) {
  let timer:ReturnType<typeof setInterval>|undefined,inFlight:Promise<void>|undefined
  async function tick(){
    if(deps.signal.aborted||deps.config.mode==='off')return
    // This unlocked preselection is only a hint. inbox.poll still locks and
    // revalidates the selected principal's own current authorization and facts.
    const rows=(await deps.pool.query<{installationId:string;connectionId:string;exportId:string|null;expectedGeneration:string}>(`WITH due AS MATERIALIZED (
      SELECT c.* FROM memory_git_connections c
      WHERE c.state='active' AND c.sync_mode<>'off' AND (c.next_poll_at IS NULL OR c.next_poll_at<=clock_timestamp())
        AND EXISTS(SELECT 1 FROM memory_git_sync_principals p JOIN memory_git_snapshots s
          ON s.installation_id=p.installation_id AND s.connection_id=p.connection_id AND s.export_id=p.export_id
          WHERE p.installation_id=c.installation_id AND p.connection_id=c.connection_id AND p.generation=c.generation
            AND s.generation=c.generation AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp()))
      ORDER BY c.next_poll_at NULLS FIRST,c.connection_id LIMIT 32)
      SELECT c.installation_id AS "installationId",c.connection_id AS "connectionId",candidate.export_id AS "exportId",c.generation::text AS "expectedGeneration"
      FROM due c LEFT JOIN LATERAL (
        SELECT p.export_id FROM memory_git_sync_principals p
        JOIN memory_git_snapshots s ON s.installation_id=p.installation_id AND s.connection_id=p.connection_id AND s.export_id=p.export_id
        JOIN memory_scope_memberships m ON m.installation_id=p.installation_id AND m.membership_id=p.membership_id
        JOIN memory_installations i ON i.installation_id=p.installation_id
        JOIN memory_owner_scopes o ON o.installation_id=p.installation_id
        WHERE p.installation_id=c.installation_id AND p.connection_id=c.connection_id AND p.generation=c.generation
          AND s.generation=c.generation AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())
          AND i.relay_status='active' AND i.local_status NOT IN('purging','purged','integrity_error')
          AND o.state='active' AND o.owner_scope_kind IN('team','organization') AND m.state='active'
          AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp())
          AND m.roles && ARRAY['contributor','scope_administrator']::text[]
          AND p.authorization_stamp->>'installationId'=p.installation_id::text
          AND p.authorization_stamp->>'membershipId'=m.membership_id::text
          AND p.authorization_stamp->>'membershipRevision'=m.membership_revision::text
          AND p.authorization_stamp->>'ownerScopeKind'=o.owner_scope_kind
          AND p.authorization_stamp->>'ownerScopeId'=o.owner_scope_id::text
          AND p.authorization_stamp->>'authorizationEpoch'=o.authorization_epoch::text
          AND p.authorization_stamp->>'configVersion'=i.config_version::text
          AND NOT EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_scope_kind=o.owner_scope_kind
            AND t.owner_scope_id=o.owner_scope_id AND t.authorization_epoch>=o.authorization_epoch)
        ORDER BY s.created_at DESC,p.export_id LIMIT 1
      ) candidate ON true ORDER BY c.next_poll_at NULLS FIRST,c.connection_id`)).rows
    const inbox=createGitInboxService(deps)
    for(const row of rows){
      if(deps.signal.aborted)return
      try{if(!row.exportId)throw new Error('git_authorization_stale');await inbox.poll(row)}catch{
        // Rejections must leave the due prefix even across restarts. The CAS
        // cannot overwrite a concurrent admission's future slot or generation.
        await deps.pool.query(`UPDATE memory_git_connections SET next_poll_at=clock_timestamp()+($4*interval '1 millisecond')
          WHERE installation_id=$1 AND connection_id=$2 AND generation=$3 AND state='active' AND sync_mode<>'off'
            AND (next_poll_at IS NULL OR next_poll_at<=clock_timestamp())`,
          [row.installationId,row.connectionId,row.expectedGeneration,deps.config.pollIntervalMs])
        deps.onError?.('git_poll_admission_denied')
      }
    }
  }
  const pass=()=>{if(!inFlight)inFlight=tick().catch(()=>{deps.onError?.('git_poll_failed')}).finally(()=>{inFlight=undefined})}
  return {tick,start(){if(timer||deps.config.mode==='off'||deps.signal.aborted)return;timer=setInterval(pass,deps.config.pollIntervalMs);timer.unref?.();pass()},
    async stop(){if(timer)clearInterval(timer);timer=undefined;await inFlight}}
}
