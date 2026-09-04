import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type pg from 'pg'
import type { GrantGuard } from '../auth/grant-guard.js'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { createGitReadService, GitApiError, gitApiError, type GitReadDeps, type GitIdentity } from '../git-sync/read-service.js'
import { createGitRepository } from '../git-sync/repository.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createGitImportService } from '../git-sync/import-service.js'
import { createGitProposalService } from '../git-sync/proposal-service.js'
import { createGitInboxService } from '../git-sync/inbox-service.js'
import { createGitRecoveryService, type GitRecoveryReadRegistry } from '../git-sync/recovery-service.js'
import { verifyGitWebhook } from '../git-sync/provider.js'
import { parseStrictJson } from '../git-sync/strict-json.js'
import type { GitPermission } from '../git-sync/authorization.js'
import { registerMemoryCors } from './cors.js'
import { createIdempotencyStore } from './idempotency.js'
import { createTransactionBoundPool } from './transaction-bound-pool.js'

export interface GitWebhookRegistration { installationId:string; provider:'github'|'gitee'; providerRepositoryId:string; targetBranch:string; secret:string; eventType:string }
export interface GitRouteDeps extends GitReadDeps {
  guard:GrantGuard;policy:CorsHostPolicy;recoveryReads?:GitRecoveryReadRegistry
  webhookRegistration?:(connectionId:string)=>Promise<GitWebhookRegistration|null>
}
const Empty=z.object({}).strict(),Params=z.object({id:z.uuid()}).strict()
const revision=z.string().regex(/^[1-9][0-9]{0,18}$/),digest=z.string().regex(/^[a-f0-9]{64}$/)
const Expected=z.object({expected_generation:revision}).strict()
const modes={sync_mode:z.enum(['off','shadow','enabled']),write_mode:z.enum(['off','shadow'])}
const Create=z.object({repository_id:z.uuid(),target_id:z.string().min(1).max(256),...modes}).strict()
const Update=Expected.extend({...modes,state:z.enum(['active','disabled'])}).strict()
const Preview=Expected.extend({assets:z.array(z.object({kind:z.enum(['claim','rule','wiki','skill']),id:z.uuid()}).strict()).min(1).max(254),reason_code:z.enum(['manual_preview','review_change'])}).strict()
const Sync=Expected.extend({export_id:z.uuid(),action:z.enum(['enroll','poll','recover'])}).strict()
const ProposalExpected=Expected.extend({expected_revision:revision,expected_policy_hash:digest,expected_proposed_hash:digest,expected_asset_revision:revision}).strict()
const Review=ProposalExpected.extend({decision:z.enum(['approve','request_changes','reject'])}).strict()
const Resolution=ProposalExpected.extend({expected_inputs:z.object({base:digest,memory:digest,git:digest}).strict(),resolution:z.object({path:z.string().min(1).max(1024),deleted:z.boolean(),editable:z.unknown()}).strict()}).strict()
const keySchema=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)
type Action='connection'|'snapshot'|'reconcile'|'import'|'review'|'apply'|'dispatch'
export function registerGitRoutes(app:FastifyInstance,deps:GitRouteDeps) {
  registerMemoryCors(app,deps.policy)
  const reads=createGitReadService(deps),store=createIdempotencyStore(deps.pool)
  const recordedDenials=new WeakSet<Error>()
  async function audit(id:GitIdentity,action:Action,code:string,client:Pick<pg.Pool,'query'>=deps.pool,outcome='denied') {
    const b=id.grant.scopeBindings.find(v=>v.installation_id===id.installationId)
    const reason=code==='conflict'?'revision_conflict':['external_write_disabled','budget_limit'].includes(code)?'feature_disabled':
      ['ok','forbidden','invalid_request','not_found','authorization_stale','source_invalid','policy_changed','feature_disabled'].includes(code)?code:'source_invalid'
    await client.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,membership_id,membership_revision,authorization_epoch,action,outcome,reason_code)
      SELECT $1,installation_id,$3,$4,$5,$6,$7,$8 FROM memory_installations WHERE installation_id=$2`,
    [randomUUID(),id.installationId,b?.membership_id??null,b?.membership_revision??null,b?.authorization_epoch??null,action,outcome,reason])
  }
  async function identity(request:FastifyRequest,mutation:boolean):Promise<GitIdentity> {
    const grant=await deps.guard.guardMcp({authorization:request.headers.authorization,requiredService:mutation?'memory.manage':'memory.search'})
    if(!('version' in grant)||grant.version!=='v2')throw new GitApiError('forbidden')
    return {installationId:grant.installationId,grant}
  }
  type RequestContext={id:GitIdentity;r:FastifyRequest;resourceId:string;action:Action}
  const parserError:import('fastify').RouteOptions['errorHandler']=async(error,request,reply)=>{
    const safe=error.code==='FST_ERR_CTP_BODY_TOO_LARGE'?new GitApiError('size_limit'):error.statusCode===400||error.statusCode===415?new GitApiError('invalid_request'):gitApiError(error)
    if(request.method!=='GET'&&!request.url.endsWith('/webhook'))try{const id=await identity(request,true);await audit(id,'import',safe.code)}catch{/* No verified tenant available for this parser rejection. */}
    return reply.code(safe.statusCode).send({error:{code:safe.code,message:safe.code}})
  }
  function route(method:'GET'|'POST'|'PUT',path:string,action:Action,permission:GitPermission,handler:(c:RequestContext)=>Promise<unknown>) {
    app.route({method,url:`/api/v1/memory/git${path}`,bodyLimit:128*1024,errorHandler:parserError,handler:async(r,reply)=>{
      let id:GitIdentity|undefined
      try {
        id=await identity(r,method!=='GET');await reads.authorize(id,permission)
        const resourceId=path.includes(':id')?Params.parse(r.params).id:(Empty.parse(r.params),'')
        if(method!=='GET'||!['/connections','/connections/:id/proposals','/connections/:id/cleanup'].includes(path))Empty.parse(r.query)
        return await handler({id,r,resourceId,action})
      }catch(error){const safe=gitApiError(error)
        if(id&&method!=='GET'&&!(error instanceof Error&&recordedDenials.has(error)))await audit(id,action,safe.code)
        return reply.code(safe.statusCode).send({error:{code:safe.code,message:safe.code}})
      }
    }})
  }
  async function mutate(c:RequestContext,body:unknown,run:(bound:GitRouteDeps)=>Promise<Record<string,unknown>>,hydrate?:(metadata:Record<string,unknown>)=>Promise<unknown>) {
    const key=keySchema.parse(c.r.headers['idempotency-key'])
    // Token issuance/expiry is not authority identity; membership and revision are.
    const principal=c.id.grant.scopeBindings.find(b=>b.installation_id===c.id.installationId)
    const result=await store.execute({installationId:c.id.installationId,operation:`git:${c.r.method}:${c.r.routeOptions.url}`,key,isolation:'read_committed',
      requestCanonical:canonicalJsonString({principal,primary:c.id.grant.primaryInstallationId,config:c.id.grant.configVersion,resourceId:c.resourceId,body}),
      run:async client=>{try {const bound={...deps,pool:createTransactionBoundPool(client)}
        const metadata=await run(bound);return {ok:true,metadata}}catch(error){return {ok:false,error}}},
    })
    if(result.kind==='conflict')throw new GitApiError('conflict')
    if(result.kind==='failed')throw result.error
    await reads.authorize(c.id,c.action==='connection'?'scope_admin':c.action==='review'?'review':c.action==='apply'||c.action==='dispatch'?'publish':'contribute')
    return hydrate?hydrate(result.metadata):result.metadata
  }
  const live=async(id:GitIdentity,connectionId:string,expected?:string)=>{
    const connection=await reads.connection(id,connectionId)
    if(expected&&connection.generation!==expected)throw new GitApiError('conflict')
    if(await reads.mode(connection)==='off')throw new GitApiError('feature_disabled')
    return connection
  }
  route('GET','/connections','connection','read',c=>reads.connections(c.id,c.r.query))
  route('GET','/connections/:id/proposals','import','read',c=>reads.children(c.id,c.resourceId,'proposals',c.r.query))
  route('GET','/connections/:id/cleanup','reconcile','read',c=>reads.children(c.id,c.resourceId,'cleanup',c.r.query))
  route('POST','/connections','connection','scope_admin',async c=>{
    const b=Create.parse(c.r.body)
    if(deps.config.mode==='off')throw new GitApiError('feature_disabled')
    return mutate(c,b,async bound=>{const created=await createGitRepository(bound).createConnection(c.id.grant,{installationId:c.id.installationId,repositoryId:b.repository_id,targetId:b.target_id,syncMode:b.sync_mode,writeMode:b.write_mode});return {connectionId:created.connectionId}},m=>reads.connection(c.id,String(m.connectionId)))
  })
  route('PUT','/connections/:id','connection','scope_admin',async c=>{
    const b=Update.parse(c.r.body)
    if(deps.config.mode==='off')throw new GitApiError('feature_disabled')
    return mutate(c,b,async bound=>{const updated=await createGitRepository(bound).updateConnection(c.id.grant,{installationId:c.id.installationId,connectionId:c.resourceId,expectedGeneration:b.expected_generation,syncMode:b.sync_mode,writeMode:b.write_mode,state:b.state});return {connectionId:updated.connectionId}},m=>reads.connection(c.id,String(m.connectionId)))
  })
  route('POST','/connections/:id/previews','snapshot','contribute',async c=>{
    const b=Preview.parse(c.r.body)
    await live(c.id,c.resourceId,b.expected_generation)
    return mutate(c,b,async bound=>{
      if(!bound.keys)throw new GitApiError('feature_disabled')
      const connection=await createGitReadService(bound).connection(c.id,c.resourceId)
      // Local preview is anchored to the retained source commit, never claimed as
      // a verified remote branch head or an externally publishable export.
      const row=(await bound.pool.query(`SELECT commit_sha FROM repo_snapshots WHERE installation_id=$1 AND repository_id=$2 ORDER BY observed_at DESC,repo_snapshot_id DESC LIMIT 1`,[c.id.installationId,connection.repositoryId])).rows[0]
      if(!row)throw new GitApiError('source_invalid')
      const bundle=await createGitExportService({...bound,keys:bound.keys}).export(c.id.grant,{installationId:c.id.installationId,connectionId:c.resourceId,expectedGeneration:b.expected_generation,assets:b.assets,baseCommit:row.commit_sha,purpose:'local_preview'})
      await audit(c.id,'snapshot','ok',bound.pool,'allowed')
      return {connectionId:c.resourceId,exportId:bundle.exportId,generation:bundle.generation}
    },m=>reads.preview(c.id,String(m.connectionId),String(m.exportId)))
  })
  route('POST','/connections/:id/sync','reconcile','contribute',async c=>{
    const b=Sync.parse(c.r.body);await live(c.id,c.resourceId,b.expected_generation)
    return mutate(c,b,async bound=>{
      const subject={installationId:c.id.installationId,connectionId:c.resourceId,exportId:b.export_id,expectedGeneration:b.expected_generation}
      let result:Record<string,unknown>
      if(b.action==='recover')result=await createGitRecoveryService(bound).admit(c.id.grant,{...subject,idempotencyKey:keySchema.parse(c.r.headers['idempotency-key'])})
      else if(b.action==='enroll'){await createGitInboxService(bound).enroll(c.id.grant,subject);result={enrolled:true,exportId:b.export_id}}
      else result=await createGitInboxService(bound).poll(subject)
      await audit(c.id,'reconcile','ok',bound.pool,'allowed');return result
    })
  })
  route('GET','/runs/:id','reconcile','read',c=>reads.run(c.id,c.resourceId))
  route('GET','/proposals/:id','import','read',c=>reads.proposal(c.id,c.resourceId))
  route('POST','/exports/:id/pull-request','dispatch','publish',async c=>{
    Expected.parse(c.r.body);keySchema.parse(c.r.headers['idempotency-key'])
    throw new GitApiError('external_write_disabled')
  })
  for(const action of ['review','apply'] as const)route('POST',`/proposals/:id/${action==='review'?'reviews':'apply'}`,action,action==='review'?'review':'publish',async c=>{
    const b=action==='review'?Review.parse(c.r.body):ProposalExpected.parse(c.r.body)
    const pointer=await reads.proposalIdentity(c.id,c.resourceId),connection=await live(c.id,pointer.connection_id,b.expected_generation)
    if(action==='apply'&&await reads.mode(connection)!=='enabled')throw new GitApiError('feature_disabled')
    const input={installationId:c.id.installationId,connectionId:pointer.connection_id,exportId:pointer.export_id,proposalId:c.resourceId,expectedGeneration:b.expected_generation,
      expectedRevision:b.expected_revision,expectedPolicyHash:b.expected_policy_hash,expectedProposedHash:b.expected_proposed_hash,expectedAssetRevision:b.expected_asset_revision,
      ...('decision' in b?{decision:b.decision}:{})}
    try {return await mutate(c,b,async bound=>{
      if(!bound.keys)throw new GitApiError('feature_disabled')
      const service=createGitImportService({...bound,keys:bound.keys,applicationMode:connection=>createGitReadService(bound).mode(connection),deferDenied:true})
      return {...await (action==='review'?service.review(c.id.grant,input):service.apply(c.id.grant,input))}
    })}catch(error){if(deps.keys){await createGitImportService({...deps,keys:deps.keys}).recordDenied(input,c.id.grant,action,error);if(error instanceof Error)recordedDenials.add(error)}throw error}
  })
  route('PUT','/proposals/:id/resolution','import','contribute',async c=>{
    const b=Resolution.parse(c.r.body),pointer=await reads.proposalIdentity(c.id,c.resourceId);await live(c.id,pointer.connection_id,b.expected_generation)
    return mutate(c,b,async bound=>{
      if(!bound.keys)throw new GitApiError('feature_disabled')
      const result=await createGitProposalService({...bound,keys:bound.keys}).resolveRegistered(c.id.grant,{installationId:c.id.installationId,connectionId:pointer.connection_id,exportId:pointer.export_id,proposalId:c.resourceId,
        expectedGeneration:b.expected_generation,expectedRevision:b.expected_revision,expectedInputs:b.expected_inputs,expectedPolicyHash:b.expected_policy_hash,expectedProposedHash:b.expected_proposed_hash,expectedAssetRevision:b.expected_asset_revision,resolution:b.resolution})
      return {proposalId:result.proposalId}
    },m=>reads.proposal(c.id,String(m.proposalId)))
  })
  // Encapsulation preserves the exact signed bytes without changing JSON parsers
  // for management routes or retaining raw webhook data in the ledger.
  app.register(async webhook=>{
    webhook.removeContentTypeParser('application/json')
    webhook.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:1_048_576},(_r,body,done)=>done(null,body))
    webhook.post('/api/v1/memory/git/connections/:id/webhook',{bodyLimit:1_048_576,errorHandler:parserError},async(r,reply)=>{
      try {
        const connectionId=Params.parse(r.params).id;Empty.parse(r.query)
        const registered=await deps.webhookRegistration?.(connectionId)
        if(!registered||!Buffer.isBuffer(r.body))throw new GitApiError('signature_invalid')
        const header=(name:string)=>typeof r.headers[name]==='string'?r.headers[name] as string:''
        const trigger=verifyGitWebhook({rawBody:r.body,signature:header(registered.provider==='github'?'x-hub-signature-256':'x-gitee-token'),eventType:header(registered.provider==='github'?'x-github-event':'x-gitee-event'),eventId:header(registered.provider==='github'?'x-github-delivery':'x-gitee-event-id'),timestamp:header('x-gitee-timestamp')},registered)
        const body=z.object({pull_request:z.object({head:z.object({ref:z.string()}),base:z.object({ref:z.string(),repo:z.object({id:z.union([z.string(),z.number().int().safe()])})})})}).parse(parseStrictJson(r.body))
        if(body.pull_request.base.ref!==registered.targetBranch||String(body.pull_request.base.repo.id)!==registered.providerRepositoryId)throw new GitApiError('signature_invalid')
        const exportId=z.uuid().parse(body.pull_request.head.ref.match(/^pocketctl\/export\/([a-f0-9-]{36})$/)?.[1])
        const row=(await deps.pool.query(`SELECT c.generation::text FROM memory_git_connections c JOIN memory_git_sync_principals p USING(installation_id,connection_id)
          WHERE c.installation_id=$1 AND c.connection_id=$2 AND p.export_id=$3 AND p.generation=c.generation AND c.provider=$4 AND c.provider_repository_id=$5 AND c.target_branch=$6`,
          [registered.installationId,connectionId,exportId,registered.provider,registered.providerRepositoryId,registered.targetBranch])).rows[0]
        if(!row)throw new GitApiError('signature_invalid')
        await createGitInboxService(deps).receive({installationId:registered.installationId,connectionId,exportId,expectedGeneration:row.generation},trigger)
        return reply.code(202).send({accepted:true})
      }catch(error){const safe=gitApiError(error);return reply.code(safe.statusCode).send({error:{code:safe.code,message:safe.code}})}
    })
  })
}
