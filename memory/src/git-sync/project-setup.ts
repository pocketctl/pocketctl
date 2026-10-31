import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { requireGitPermission, assertGitGrantClock } from './authorization.js'
import type { GitIdentity } from './read-service.js'
import { GitApiError } from './read-service.js'
import { createGitTransport } from './transport.js'
import { FixedGitTarget } from './read-adapter.js'
import { createGitCredentialVault, createManagedGitKeys } from './credential-vault.js'
import { createGitRepository } from './repository.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { lockGitKeyRegistry } from './key-registry.js'

export const ProjectSetupInput = z.object({
  project_id:z.uuid(), repository_url:z.string().max(2048),
  branch:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/).refine(s=>s!=='HEAD'&&!s.includes('..')&&!s.endsWith('.')&&!s.split('/').some(v=>!v||v.startsWith('.')||v.endsWith('.lock'))),
  access_token:z.string().min(1).max(8192).refine(v=>!/[\x00-\x20\x7f]/.test(v)), read_consent:z.literal(true),
  expected_generation:z.string().regex(/^[1-9][0-9]{0,18}$/).nullable(),
}).strict()
const numericId = z.union([z.string().regex(/^[1-9][0-9]{0,19}$/),z.number().int().positive().safe()])
const sha = z.string().regex(/^[a-f0-9]{40}$/)
export function parseProjectRepository(raw:string) {
  let u:URL
  try { u=new URL(raw) } catch { throw new GitApiError('invalid_request') }
  const parts=u.pathname.replace(/\/$/,'').replace(/\.git$/,'').split('/').slice(1)
  if(u.protocol!=='https:'||!['github.com','gitee.com'].includes(u.hostname)||u.username||u.password||u.port||u.search||u.hash||parts.length!==2
    ||parts.some(v=>! /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(v)||v.includes('..')||v.endsWith('.'))) throw new GitApiError('invalid_request')
  return {provider:u.hostname==='github.com'?'github' as const:'gitee' as const,owner:parts[0],repository:parts[1],url:`https://${u.hostname}/${parts.join('/')}`}
}

export function createGitProjectSetupService(deps:{pool:pg.Pool;secret:string;fetch?:typeof fetch;timeoutMs?:number}) {
  const vault=createGitCredentialVault(deps.secret)
  const keys=createManagedGitKeys(deps.pool,deps.secret)
  async function transaction<T>(id:GitIdentity,permission:'read'|'scope_admin'|'contribute',run:(client:pg.PoolClient)=>Promise<T>) {
    const client=await deps.pool.connect()
    try { await client.query('BEGIN'); await lockGitKeyRegistry(client); await requireGitPermission(client,id.grant,id.installationId,permission)
      const value=await run(client);await assertGitGrantClock(client,id.grant);await client.query('COMMIT');return value
    } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
  }
  async function read(client:pg.PoolClient,id:GitIdentity,project:string) {
    const row=(await client.query(`SELECT c.connection_id,c.repository_id,c.generation::text,c.state,c.target_branch,
      p.consent_until,(p.token_cipher IS NOT NULL AND EXISTS(SELECT 1 FROM memory_scope_memberships m JOIN memory_owner_scopes s USING(installation_id)
        WHERE m.installation_id=p.installation_id AND m.membership_id=p.authorized_membership_id AND m.state='active'
        AND m.roles @> ARRAY['scope_administrator']::text[] AND m.membership_revision::text=p.target->>'membershipRevision'
        AND s.state='active' AND s.authorization_epoch::text=p.target->>'authorizationEpoch'
        AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_until IS NULL OR m.valid_until>clock_timestamp()))) AS authorized,p.target->>'repositoryUrl' AS repository_url,
      clock_timestamp()<p.consent_until AS consent_active
      FROM memory_git_project_targets p JOIN memory_git_connections c USING(installation_id,connection_id)
      WHERE p.installation_id=$1 AND p.project_id=$2`,[id.installationId,project])).rows[0]
    return row ? {...row,authorized:row.authorized&&row.consent_active&&row.state==='active'} : null
  }
  return {
    get:(id:GitIdentity,project:string)=>transaction(id,'read',client=>read(client,id,project)),
    async connect(id:GitIdentity,raw:unknown,key:string) {
      const input=ProjectSetupInput.parse(raw),repo=parseProjectRepository(input.repository_url)
      const principal=id.grant.scopeBindings.find(b=>b.installation_id===id.installationId)?.membership_id
      const requestKey=createHash('sha256').update(`${principal}:${key}`).digest('hex')
      const requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex')
      async function replay(client:pg.PoolClient) {
        const prior=(await client.query(`SELECT request_hash FROM memory_git_project_setup_requests WHERE installation_id=$1 AND project_id=$2 AND request_key=$3`,[id.installationId,input.project_id,requestKey])).rows[0]
        if(prior&&prior.request_hash!==requestHash)throw new GitApiError('conflict')
        return !!prior
      }
      // Authorization happens before any outbound request and again before saving.
      const known=await transaction(id,'scope_admin',async client=>await replay(client)?read(client,id,input.project_id):null)
      if(known)return known
      const transport=createGitTransport({provider:repo.provider,token:input.access_token,maxResponseBytes:1_048_576,fetch:deps.fetch})
      const signal=AbortSignal.timeout(deps.timeoutMs??15_000)
      async function request(segments:string[]) {
        const r=await transport({segments},signal)
        if(r.status!==200)throw new GitApiError(r.status===401||r.status===403?'repository_authorization_failed':r.status===404?'repository_not_found':'provider_unavailable')
        return r.body
      }
      const base=['repos',repo.owner,repo.repository]
      const repository=z.object({id:numericId,full_name:z.string(),private:z.boolean()}).parse(await request(base))
      if(repository.full_name.toLowerCase()!==`${repo.owner}/${repo.repository}`.toLowerCase())throw new GitApiError('source_invalid')
      const [owner,name]=repository.full_name.split('/')
      const target=FixedGitTarget.parse({providerRepositoryId:String(repository.id),owner,repository:name,branch:input.branch,private:repository.private})
      const branch=z.object({name:z.string(),commit:z.object({sha})}).parse(await request([...base,'branches',input.branch]))
      if(branch.name!==input.branch)throw new GitApiError('source_invalid')
      // Prove the credential's own provider identity; arbitrary client actor mappings are not accepted.
      const actor=z.object({id:numericId}).parse(await request(['user']))
      try{await keys.ensureSigner()}catch{throw new GitApiError('credential_store_unavailable')}
      return transaction(id,'scope_admin',async client=>{
        const stamp=await requireGitPermission(client,id.grant,id.installationId,'scope_admin')
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('git-project-target:'||$1||':'||$2,0))`,[id.installationId,repo.url])
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('git-project:'||$1||':'||$2,0))`,[id.installationId,input.project_id])
        if(await replay(client))return read(client,id,input.project_id)
        const prior=(await client.query(`SELECT p.*,c.generation::text,c.repository_id,c.provider_repository_id FROM memory_git_project_targets p
          JOIN memory_git_connections c USING(installation_id,connection_id) WHERE p.installation_id=$1 AND p.project_id=$2`,[id.installationId,input.project_id])).rows[0]
        if((prior?.generation??null)!==input.expected_generation)throw new GitApiError('conflict')
        if(prior&&(prior.target.repositoryUrl!==repo.url||prior.target.branch!==input.branch||prior.provider_repository_id!==target.providerRepositoryId))throw new GitApiError('conflict')
        const matches=(await client.query(`SELECT repository_id FROM repositories WHERE installation_id=$1
          AND rtrim(regexp_replace(regexp_replace(canonical_remote,'^git@(github.com|gitee.com):','https://\\1/'),'[.]git$',''),'/')=$2
          AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=repositories.installation_id AND t.repository_id=repositories.repository_id)
          ORDER BY repository_id LIMIT 2`,[id.installationId,repo.url])).rows
        if(!prior&&matches.length>1)throw new GitApiError('conflict')
        const repositoryId=prior?.repository_id??matches[0]?.repository_id??randomUUID(),targetId=`project:${input.project_id}`
        if(!prior&&(await client.query(`SELECT 1 FROM memory_git_connections WHERE installation_id=$1 AND repository_id=$2 AND state='active'`,[id.installationId,repositoryId])).rowCount)throw new GitApiError('conflict')
        const registered={...target,provider:repo.provider,repositoryUrl:repo.url,targetId,credentialRef:targetId,scopeMode:'enabled',authorizationRevision:randomUUID(),membershipRevision:stamp.membershipRevision,authorizationEpoch:stamp.authorizationEpoch,verifiedHead:branch.commit.sha}
        await client.query(`INSERT INTO repositories(repository_id,installation_id,repository_key,canonical_remote,first_observed_at,last_observed_at)
          VALUES($1,$2,$3,$4,NOW(),NOW()) ON CONFLICT(repository_id) DO UPDATE SET last_observed_at=NOW()`,[repositoryId,id.installationId,`git-project:${input.project_id}`,repo.url])
        const bound=createTransactionBoundPool(client)
        const service=createGitRepository({pool:bound,targets:{resolve:async()=>({provider:repo.provider,providerRepositoryId:target.providerRepositoryId,branch:input.branch,credentialRef:targetId})}})
        let connection=prior
          ?await service.updateConnection(id.grant,{installationId:id.installationId,connectionId:prior.connection_id,expectedGeneration:prior.generation,syncMode:'enabled',writeMode:'off',state:'active'})
          :await service.createConnection(id.grant,{installationId:id.installationId,repositoryId,targetId,syncMode:'enabled',writeMode:'off'})
        // Existing mapping cannot be stolen by another PocketCtl membership.
        const mapped=(await client.query(`SELECT membership_id FROM memory_git_actor_mappings WHERE installation_id=$1 AND connection_id=$2 AND provider_actor_id=$3`,[id.installationId,connection.connectionId,String(actor.id)])).rows[0]
        if(mapped&&mapped.membership_id!==stamp.membershipId)throw new GitApiError('conflict')
        connection=await service.mapActor(id.grant,{installationId:id.installationId,connectionId:connection.connectionId,expectedGeneration:connection.generation,providerActorId:String(actor.id),membershipId:stamp.membershipId})
        await client.query(`INSERT INTO memory_git_project_targets(installation_id,project_id,connection_id,target,token_cipher,consent_until,authorized_membership_id)
          VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '30 days',$6)
          ON CONFLICT(installation_id,project_id) DO UPDATE SET target=EXCLUDED.target,token_cipher=EXCLUDED.token_cipher,
            consent_until=EXCLUDED.consent_until,authorized_membership_id=EXCLUDED.authorized_membership_id`,
        [id.installationId,input.project_id,connection.connectionId,registered,vault.seal(input.access_token,`${id.installationId}:${input.project_id}`),stamp.membershipId])
        await client.query(`INSERT INTO repo_snapshots(repo_snapshot_id,installation_id,repository_id,commit_sha,branch,dirty,observed_at)
          VALUES($1,$2,$3,$4,$5,false,NOW()) ON CONFLICT DO NOTHING`,[randomUUID(),id.installationId,repositoryId,branch.commit.sha,input.branch])
        await client.query(`INSERT INTO memory_git_project_setup_requests(installation_id,project_id,request_key,request_hash) VALUES($1,$2,$3,$4)`,[id.installationId,input.project_id,requestKey,requestHash])
        return read(client,id,input.project_id)
      })
    },
    async disconnect(id:GitIdentity,project:string,generation:string) {
      return transaction(id,'scope_admin',async client=>{
        const current=await read(client,id,project);if(!current)throw new GitApiError('not_found')
        await createGitRepository({pool:createTransactionBoundPool(client),targets:{resolve:async()=>null}}).updateConnection(id.grant,
          {installationId:id.installationId,connectionId:current.connection_id,expectedGeneration:generation,syncMode:'off',writeMode:'off',state:'disabled'})
        await client.query(`UPDATE memory_git_project_targets SET token_cipher=NULL,consent_until=clock_timestamp() WHERE installation_id=$1 AND project_id=$2`,[id.installationId,project])
        return read(client,id,project)
      })
    },
    async linkIdentity(id:GitIdentity,project:string,raw:unknown,key:string) {
      const input=z.object({access_token:ProjectSetupInput.shape.access_token,expected_generation:z.string().regex(/^[1-9][0-9]{0,18}$/)}).strict().parse(raw)
      const membership=id.grant.scopeBindings.find(b=>b.installation_id===id.installationId)?.membership_id
      const requestKey=createHash('sha256').update(`identity:${membership}:${key}`).digest('hex'),requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex')
      const provider=await transaction(id,'contribute',async client=>{
        const row=(await client.query(`SELECT target->>'provider' AS provider FROM memory_git_project_targets WHERE installation_id=$1 AND project_id=$2`,[id.installationId,project])).rows[0]
        if(!row||!['github','gitee'].includes(row.provider))throw new GitApiError('not_found');return row.provider as 'github'|'gitee'
      })
      const response=await createGitTransport({provider,token:input.access_token,maxResponseBytes:65_536,fetch:deps.fetch})({segments:['user']},AbortSignal.timeout(deps.timeoutMs??15_000))
      if(response.status!==200)throw new GitApiError('repository_authorization_failed')
      const actor=z.object({id:numericId}).parse(response.body)
      return transaction(id,'contribute',async client=>{
        const stamp=await requireGitPermission(client,id.grant,id.installationId,'contribute')
        const prior=(await client.query(`SELECT request_hash FROM memory_git_project_setup_requests WHERE installation_id=$1 AND project_id=$2 AND request_key=$3`,[id.installationId,project,requestKey])).rows[0]
        if(prior){if(prior.request_hash!==requestHash)throw new GitApiError('conflict');return read(client,id,project)}
        const target=(await client.query(`SELECT connection_id FROM memory_git_project_targets WHERE installation_id=$1 AND project_id=$2`,[id.installationId,project])).rows[0]
        if(!target)throw new GitApiError('not_found')
        const c=(await client.query(`SELECT generation::text,state FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2 FOR UPDATE`,[id.installationId,target.connection_id])).rows[0]
        const raced=(await client.query(`SELECT request_hash FROM memory_git_project_setup_requests WHERE installation_id=$1 AND project_id=$2 AND request_key=$3`,[id.installationId,project,requestKey])).rows[0]
        if(raced){if(raced.request_hash!==requestHash)throw new GitApiError('conflict');return read(client,id,project)}
        if(c.generation!==input.expected_generation||c.state!=='active')throw new GitApiError('conflict')
        const mapped=(await client.query(`SELECT membership_id FROM memory_git_actor_mappings WHERE installation_id=$1 AND connection_id=$2 AND provider_actor_id=$3`,[id.installationId,target.connection_id,String(actor.id)])).rows[0]
        if(mapped&&mapped.membership_id!==stamp.membershipId)throw new GitApiError('conflict')
        await client.query(`INSERT INTO memory_git_actor_mappings(installation_id,connection_id,provider_actor_id,membership_id,membership_revision,authorization_epoch)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(installation_id,connection_id,provider_actor_id) DO UPDATE SET
            membership_revision=EXCLUDED.membership_revision,authorization_epoch=EXCLUDED.authorization_epoch,updated_at=NOW()`,[id.installationId,target.connection_id,String(actor.id),stamp.membershipId,stamp.membershipRevision,stamp.authorizationEpoch])
        await client.query(`UPDATE memory_git_connections SET generation=generation+1,updated_at=NOW() WHERE installation_id=$1 AND connection_id=$2`,[id.installationId,target.connection_id])
        await client.query(`INSERT INTO memory_git_project_setup_requests(installation_id,project_id,request_key,request_hash) VALUES($1,$2,$3,$4)`,[id.installationId,project,requestKey,requestHash])
        await client.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,membership_id,membership_revision,authorization_epoch,action,outcome,reason_code)
          VALUES($1,$2,$3,$4,$5,$6,'mapping','allowed','ok')`,[randomUUID(),id.installationId,target.connection_id,stamp.membershipId,stamp.membershipRevision,stamp.authorizationEpoch])
        return read(client,id,project)
      })
    },
  }
}
