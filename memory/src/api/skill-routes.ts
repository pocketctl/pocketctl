import type { Phase5Metrics } from '../metrics.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import type { GrantGuard } from '../auth/grant-guard.js'
import { MemoryApiError } from './errors.js'
import { createSkillReadService, SkillReadError, skillJson, SkillListQuerySchema, type SkillIdentity } from '../skills/read-service.js'
import { createSkillReviewService } from '../skills/review-service.js'
import { createSkillReplayService } from '../skills/replay-service.js'
import { createSkillAdmissionService } from '../skills/admission-service.js'
import { createSkillPublicationService } from '../skills/publication-service.js'
import { createSkillRollbackService } from '../skills/rollback-service.js'
import { createSkillPolicyService } from '../skills/policy-service.js'
import { createSkillExecutionService } from '../skills/execution-service.js'
import { createFileSkillCaseRegistry, type TrustedSkillCaseRegistry } from '../skills/case-registry.js'
import { SkillWorkError, type SkillSourceContext } from '../skills/source-resolver.js'
import { SkillCandidateDocumentSchema } from '../skills/types.js'
import type { CorsHostPolicy } from '../auth/cors-host-policy.js'
import { registerMemoryCors } from './cors.js'

export interface SkillRouteDeps {metrics?:Phase5Metrics;pool:pg.Pool;guard:GrantGuard;policy:CorsHostPolicy;context:SkillSourceContext;cursorSigningKey:string;cases?:TrustedSkillCaseRegistry}
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1)
const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const Expected=z.object({expected_revision:revision}).strict()
const Params=z.object({skillId:z.uuid()}).strict()
const Empty=z.object({}).strict()
const Edit=Expected.extend({document:SkillCandidateDocumentSchema}).strict()
const Review=Expected.extend({decision:z.enum(['approve','request_changes','reject']),review_outcome:z.enum(['accepted_as_is','light_edit','major_edit']).optional()}).strict()
  .refine(b=>b.decision==='approve'||b.review_outcome===undefined)
const Replay=Expected.extend({version_id:z.uuid(),case_ids:z.array(identifier).min(1).max(32).refine(x=>new Set(x).size===x.length),idempotency_key:identifier}).strict()
const Publish=Expected.extend({version_id:z.uuid(),expected_publication_revision:revision,mode:z.enum(['manual','auto'])}).strict()
const Rollback=Expected.extend({target_version_id:z.uuid(),expected_publication_revision:revision}).strict()
const Policy=Expected.extend({policy:z.object({minimum_independent_successes:z.number().int().min(2).max(100),auto_mode:z.enum(['off','shadow']),canary_mode:z.enum(['off','shadow'])}).strict()}).strict()
const Admission=z.object({candidate_key:identifier,source:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('episode'),episode_id:z.uuid()}).strict(),
  z.object({kind:z.literal('claim_version'),version_id:z.uuid(),repository_id:z.uuid(),repo_snapshot_id:z.uuid()}).strict(),
])}).strict()
const Start= z.object({version_id:z.uuid(),expected_publication_revision:revision,session_id:z.string().min(1).max(200),idempotency_key:identifier}).strict()
const Complete=z.object({expected_revision:revision,outcome:z.enum(['succeeded','failed','taken_over','cancelled']),idempotency_key:identifier}).strict()
function parse<T>(schema:z.ZodType<T>,raw:unknown):T {const result=schema.safeParse(raw);if(!result.success)throw new SkillReadError('invalid_request');return result.data}

export function registerSkillRoutes(app:FastifyInstance,deps:SkillRouteDeps) {
  registerMemoryCors(app,deps.policy)
  const cases=deps.cases??createFileSkillCaseRegistry()
  const reads=createSkillReadService({...deps,cases}),review=createSkillReviewService(deps),replay=createSkillReplayService({...deps,cases})
  const admission=createSkillAdmissionService({...deps,onOutcome:deps.metrics?.recordAdmission}),publication=createSkillPublicationService({...deps,cases}),rollback=createSkillRollbackService({...deps,cases})
  const policy=createSkillPolicyService(deps),execution=createSkillExecutionService({...deps,cases})
  async function identity(request:FastifyRequest,mutation:boolean):Promise<SkillIdentity> {
    const grant=await deps.guard.guardMcp({authorization:request.headers.authorization,requiredService:mutation?'memory.manage':'memory.search'})
    if(!('version' in grant)||grant.version!=='v2')throw new SkillReadError('forbidden')
    const result={installationId:grant.installationId,grant}
    await reads.authorize(result)
    return result
  }
  const mutationAction=(url:string):Parameters<Phase5Metrics['recordAction']>[0]=>url==='/admissions'?'admission':url.includes('executions')?'execution':url==='/policy'?'policy':url.endsWith('/replay')?'replay':url.endsWith('/publish')?'publish':url.endsWith('/revoke')?'revoke':url.endsWith('/rollback')?'rollback':'review'
  const route=(method:'GET'|'POST'|'PUT',url:string,handler:(id:SkillIdentity,r:FastifyRequest)=>Promise<unknown>)=>app.route({
    method,url:`/api/v1/memory/skills${url}`,bodyLimit:128*1024,
    handler:async(request,reply)=>{try {const result=skillJson(await handler(await identity(request,method!=='GET'),request));if(method!=='GET')deps.metrics?.recordAction(mutationAction(url),'allowed');return result}
      catch(error){
        if(method!=='GET')deps.metrics?.recordAction(mutationAction(url),'denied')
        if(error instanceof MemoryApiError)return reply.code(error.httpStatus).send({error:{code:error.code,message:error.message}})
        if(error instanceof SkillWorkError){const code=error.code==='skill_forbidden'?'forbidden':error.code==='skill_disabled'?'feature_disabled':'source_invalid';return reply.code(code==='forbidden'?403:code==='feature_disabled'?503:409).send({error:{code,message:code}})}
        if(error instanceof Error && 'statusCode' in error && 'code' in error)return reply.code(Number(error.statusCode)).send({error:{code:error.code,message:error.code}})
        // Never emit registry paths, recording bodies or raw database errors.
        return reply.code(500).send({error:{code:'internal_error',message:'Skill request failed'}})
      }},
  })
  const skill=(r:FastifyRequest)=>parse(Params,r.params).skillId
  const noQuery=(r:FastifyRequest)=>parse(Empty,r.query)
  route('GET','',async(id,r)=>reads.list(id,r.query))
  route('GET','/candidates',async(id,r)=>reads.list(id,parse(SkillListQuerySchema.omit({state:true}),r.query),true))
  route('POST','/admissions',async(id,r)=>{noQuery(r);const p=parse(Admission,r.body);const s=p.source;return admission.schedule({...id,candidateKey:p.candidate_key,source:s.kind==='episode'?{kind:s.kind,episodeId:s.episode_id}:{kind:s.kind,versionId:s.version_id,repositoryId:s.repository_id,repoSnapshotId:s.repo_snapshot_id}})})
  route('POST','/candidates/:candidateId/draft',async(id,r)=>{noQuery(r);const p=parse(z.object({candidateId:z.uuid()}).strict(),r.params),b=parse(Expected,r.body);return review.execute(id,{action:'draft',candidateId:p.candidateId,expectedRevision:b.expected_revision})})
  route('GET','/policy',async(id,r)=>{noQuery(r);const a=await reads.authorize(id);return {...await policy.getPolicy(id),can_manage_policy:a.binding.permissions.includes('policy_admin')}})
  route('PUT','/policy',async(id,r)=>{noQuery(r);const b=parse(Policy,r.body);return {...await policy.execute(id,{expectedRevision:b.expected_revision,policy:{minimumIndependentSuccesses:b.policy.minimum_independent_successes,autoMode:b.policy.auto_mode,canaryMode:b.policy.canary_mode}}),can_manage_policy:(await reads.authorize(id)).binding.permissions.includes('policy_admin')}})
  route('GET','/:skillId',async(id,r)=>{noQuery(r);const s=skill(r),d=await reads.get(id,s)
    const p=await deps.pool.query(`SELECT current_version_id,previous_version_id,revision::text,state FROM memory_skill_publication_heads WHERE installation_id=$1 AND skill_id=$2`,[id.installationId,s])
    const eligibility=(await reads.authorize(id)).binding.permissions.includes('publish') ? await publication.getEligibility(id,{skillId:s,versionId:d.version_id,expectedRevision:d.revision}) : null
    return {...d,replay:await reads.replay(id,s),publication:p.rows[0]??null,executions:(await execution.list(id,{skillId:s})).items,eligibility}
  })
  route('GET','/:skillId/archive',async(id,r)=>{noQuery(r);return reads.archive(id,skill(r))})
  route('GET','/:skillId/diff',async(id,r)=>{const b=parse(z.object({from_version_id:z.uuid(),to_version_id:z.uuid()}).strict(),r.query);return reads.diff(id,skill(r),b.from_version_id,b.to_version_id)})
  route('GET','/:skillId/replay',async(id,r)=>{noQuery(r);return reads.replay(id,skill(r))})
  route('GET','/:skillId/replay-cases',async(id,r)=>{noQuery(r);const d=await reads.get(id,skill(r));if(!d.permissions.can_replay)throw new SkillReadError('forbidden')
    const recorded=await cases.listCases({installationId:id.installationId,repositoryId:d.repository_id,repoSnapshotId:d.repo_snapshot_id,versionId:d.version_id,documentHash:d.document_hash,policyHash:d.policy_hash})
    const available=[]
    for(const c of recorded){if(c.kind==='historical_session'){const alive=await deps.pool.query(`SELECT 1 FROM source_sessions s WHERE installation_id=$1 AND session_id=$2 AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=s.installation_id AND t.session_id=s.session_id)`,[id.installationId,c.reference_id]);if(!alive.rowCount)continue}available.push({case_id:c.case_id,kind:c.kind,provenance:c.provenance})}
    return {items:available}
  })
  route('POST','/:skillId/edit',async(id,r)=>{noQuery(r);const b=parse(Edit,r.body);return review.execute(id,{action:'edit',skillId:skill(r),expectedRevision:b.expected_revision,document:b.document})})
  route('POST','/:skillId/review',async(id,r)=>{noQuery(r);const b=parse(Review,r.body);return review.execute(id,{action:b.decision,skillId:skill(r),expectedRevision:b.expected_revision,...(b.review_outcome?{reviewOutcome:b.review_outcome}:{})})})
  route('POST','/:skillId/revoke',async(id,r)=>{noQuery(r);const b=parse(Expected,r.body);return review.execute(id,{action:'revoke',skillId:skill(r),expectedRevision:b.expected_revision})})
  route('POST','/:skillId/replay',async(id,r)=>{noQuery(r);const b=parse(Replay,r.body);return replay.execute(id,{skillId:skill(r),versionId:b.version_id,expectedRevision:b.expected_revision,caseIds:b.case_ids,idempotencyKey:b.idempotency_key})})
  route('POST','/:skillId/publish',async(id,r)=>{noQuery(r);const b=parse(Publish,r.body);return publication.execute(id,{skillId:skill(r),versionId:b.version_id,expectedRevision:b.expected_revision,expectedPublicationRevision:b.expected_publication_revision,mode:b.mode})})
  route('POST','/:skillId/rollback',async(id,r)=>{noQuery(r);const b=parse(Rollback,r.body);return rollback.execute(id,{skillId:skill(r),targetVersionId:b.target_version_id,expectedRevision:b.expected_revision,expectedPublicationRevision:b.expected_publication_revision})})
  route('GET','/:skillId/executions',async(id,r)=>{const b=parse(z.object({limit:z.coerce.number().int().min(1).max(50).optional()}).strict(),r.query);const s=skill(r);await reads.get(id,s);const result=await execution.list(id,{skillId:s});return {...result,items:result.items.slice(0,b.limit??20)}})
  route('POST','/:skillId/executions',async(id,r)=>{noQuery(r);const b=parse(Start,r.body);return execution.start(id,{skillId:skill(r),versionId:b.version_id,expectedPublicationRevision:b.expected_publication_revision,sessionId:b.session_id,idempotencyKey:b.idempotency_key})})
  route('POST','/executions/:executionId/result',async(id,r)=>{noQuery(r);const p=parse(z.object({executionId:z.uuid()}).strict(),r.params),b=parse(Complete,r.body);return execution.complete(id,{executionId:p.executionId,expectedRevision:b.expected_revision,outcome:b.outcome,idempotencyKey:b.idempotency_key})})
}
