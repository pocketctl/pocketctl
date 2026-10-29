import {createPublicationDelegation} from '../governance/publication-delegation.js'
import {createExecutorPrincipals} from '../governance/executor-principals.js'
import {createAutomationRepository} from '../governance/automation-repository.js'
import {automationPolicySchema} from '../governance/automation-policy.js'
import {z} from 'zod'
import { createHash } from 'crypto'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'

import type { GrantGuard } from '../auth/grant-guard.js'
import { assertCurrentGrantClock, requireCurrentScopePermission, TargetBindingError, type RouteV2Grant } from '../governance/authorization.js'
import { MemoryApiError } from './errors.js'
import { createAuditRepository } from '../governance/audit-repository.js'
import { createPromotionRepository } from '../governance/promotion-repository.js'
import { createPromotionService, PromotionError } from '../governance/promotion-service.js'
import { createPublicationService, createSharedClaimLifecycle, PublicationError } from '../governance/publication-service.js'
import { createReviewPolicyRepository, ReviewPolicyRevisionConflictError, ReviewPolicyScopeStaleError } from '../governance/review-policy.js'
import { createTransferService, TransferError } from '../governance/transfer-service.js'
import { createIdempotencyStore } from './idempotency.js'
import { createTransactionBoundPool } from './transaction-bound-pool.js'
import {parseRevisionMetadataPatch,type RevisionMetadataPatch} from '../governance/revision-metadata.js'
import type {TombstoneHmacKey} from '../config.js'

/**
 * ADR-0005 §8.2 governance routes. Every mutation requires an
 * Idempotency-Key, an expected_revision, and a target installation that
 * exactly matches a validated v2 grant binding; no route executes raw
 * governance SQL outside the services. The scope selection surface for
 * federated retrieval also lives here (§6.4).
 */

export interface GovernanceRouteDeps {
  pool: pg.Pool
  delegatedPublishMode?: 'off'|'enabled'
  automationMode?: 'off'|'shadow'|'assist'
  guard: GrantGuard
  sharedScopesEnabled: boolean
  cursorSigningKey: string
  tombstoneHmacKeys?:readonly TombstoneHmacKey[]
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerGovernanceRoutes(app: FastifyInstance, deps: GovernanceRouteDeps): void {
  const automation=createAutomationRepository(deps.pool)
  const promotionRepository = createPromotionRepository(deps.pool)
  const reviewPolicy = createReviewPolicyRepository(deps.pool)
  const audit = createAuditRepository(deps.pool, { cursorSecret: deps.cursorSigningKey })
  const idempotency = createIdempotencyStore(deps.pool)

  const fail = (reply: { code: (status: number) => unknown }, error: MemoryApiError) => {
    reply.code(error.httpStatus)
    return { error: { code: error.code, message: error.message } }
  }

  async function guardV2OrFail(
    request: { headers: { authorization?: string } },
    reply: { code: (status: number) => unknown },
    service: string,
  ): Promise<RouteV2Grant | { failed: never }> {
    try {
      return await deps.guard.guardV2({ authorization: request.headers.authorization, requiredService: service })
    } catch (error) {
      if (error instanceof MemoryApiError) {
        return { failed: fail(reply, error) as never }
      }
      throw error
    }
  }

  const isFailed = (value: unknown): value is { failed: never } =>
    typeof value === 'object' && value !== null && 'failed' in value

  function mapGovernanceError(error: unknown, reply: { code: (status: number) => unknown }): unknown {
    if (error instanceof MemoryApiError) return fail(reply, error)
    if (error instanceof PromotionError || error instanceof PublicationError) {
      const statusByCode: Record<string, number> = {
        not_found: 404,
        forbidden: 403,
        invalid_edge: 400,
        evidence_out_of_bounds: 400,
        evidence_not_owned: 400,
        evidence_empty_after_redaction: 400,
        revision_conflict: 409,
        state_conflict: 409,
        quorum_failed: 409,
        expired: 410,
        invalid_resolution: 400,
        policy_head_changed: 409,
      }
      const status = statusByCode[error.code] ?? 400
      reply.code(status)
      return { error: { code: error.code, message: error.message, ...(('details' in error && (error as PublicationError).details) || {}) } }
    }
    if (error instanceof ReviewPolicyScopeStaleError) {
      return fail(reply, new MemoryApiError('forbidden', 'current review policy scope required'))
    }
    if (error instanceof ReviewPolicyRevisionConflictError) {
      reply.code(409)
      return { error: { code: 'revision_conflict', message: error.message } }
    }
    if (error instanceof TransferError) {
      const status = error.code === 'not_found' ? 404
        : error.code === 'forbidden' ? 403
          : error.code === 'conflict' ? 409 : 400
      reply.code(status)
      return { error: { code: error.code, message: error.message } }
    }
    throw error
  }

  function requireIdempotencyKey(
    request: { headers: { [key: string]: unknown } },
    reply: { code: (status: number) => unknown },
  ): string | null {
    const key = request.headers['idempotency-key']
    if (typeof key !== 'string' || key.length === 0 || key.length > 128) {
      reply.code(400)
      return null
    }
    return key
  }

  function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]))
    }
    return value
  }

  async function idempotentMutation<T>(input: {
    grant: RouteV2Grant
    targetInstallationId: string
    operation: string
    key: string
    request: { body?: unknown; params?: unknown }
    run(pool: pg.Pool): Promise<T>
    metadata(result: T): Record<string, unknown>
    replay(metadata: Record<string, unknown>, pool: pg.Pool): Promise<T>
  }): Promise<T> {
    const binding = input.grant.scopeBindings.find(b => b.installation_id === input.targetInstallationId)
    const permissions: Record<string, 'read'|'contribute'|'review'|'publish'|'policy_admin'|'scope_admin'> = {
      'governance.propose':'contribute', 'governance.decision':'review', 'governance.publish':'publish',
      'governance.executor_principal':'policy_admin','governance.delegate_publish':'publish','governance.delegate_revoke':'publish','governance.automation_policy':'policy_admin', 'governance.revoke':'publish', 'governance.review_policy':'policy_admin', 'governance.transfer':'scope_admin',
      'governance.revise':binding?.permissions.includes('review') ? 'review' : 'contribute',
      'governance.withdraw':'read',
    }
    const checkClock = async (client: pg.PoolClient, freshWrite = false) => {
      try {
        const selected=[input.targetInstallationId]
        const body=input.request.body as {target_installation_id?:unknown;source_installation_id?:unknown;expected_revision?:unknown;
          repair_legacy_bundle?:unknown;refresh_source_metadata?:unknown;metadata_patch?:unknown;evidence_selection?:{new_evidence_ids?:unknown}}|undefined
        const dependency=input.operation==='governance.transfer'?body?.target_installation_id:input.operation==='governance.propose'?body?.source_installation_id:undefined
        if(typeof dependency==='string')selected.push(dependency)
        if(freshWrite&&input.operation==='governance.revise'){
          const added=body?.evidence_selection?.new_evidence_ids
          const needsMetadata=body?.refresh_source_metadata===true||body?.metadata_patch!==undefined
          if(needsMetadata||(Array.isArray(added)&&added.length>0)||body?.repair_legacy_bundle===true){
            // The domain savepoint has returned, but receipt persistence can
            // still block. Resolve the actual dependency from the original
            // immutable revision; never trust a source ID from the request.
            const candidateId=(input.request.params as {candidateId?:unknown}|undefined)?.candidateId
            const row=(await client.query<{source_installation_id:string;legacy:boolean}>(`
              SELECT c.source_installation_id,(v.revision_bundle IS NULL AND v.revision_bundle_hash IS NULL) AS legacy
              FROM memory_promotion_candidates c JOIN memory_promotion_candidate_versions v USING(candidate_id)
              WHERE c.target_installation_id=$1 AND c.candidate_id=$2 AND v.revision_number=$3`,
              [input.targetInstallationId,candidateId,body?.expected_revision])).rows[0]
            if(!row)throw new TargetBindingError('revision authority dependencies missing')
            if(needsMetadata||(Array.isArray(added)&&added.length>0)||row.legacy)selected.push(row.source_installation_id)
          }
        }
        await assertCurrentGrantClock(client,input.grant,selected)
      }
      catch (error) { if (error instanceof TargetBindingError) throw new MemoryApiError('forbidden','current authorization required'); throw error }
    }
    const authorize = async (client: pg.PoolClient) => {
      const permission = permissions[input.operation]
      if (!permission) throw new MemoryApiError('forbidden','current authorization required')
      try {
        await requireCurrentScopePermission({client,grant:input.grant,targetInstallationId:input.targetInstallationId,permission,
          ...(input.operation==='governance.transfer' ? {allowedSharedStates:['active','dissolving']} : {})})
        if(input.operation==='governance.transfer'){
          const target=(input.request.body as {target_installation_id?:unknown})?.target_installation_id
          if(typeof target!=='string')throw new TargetBindingError('target missing')
          await requireCurrentScopePermission({client,grant:input.grant,targetInstallationId:target,permission:'scope_admin',allowedPrimarySharedStates:input.grant.primaryInstallationId===target?['active']:['active','dissolving']})
        }
      } catch (error) { if (error instanceof TargetBindingError) throw new MemoryApiError('forbidden','current authorization required'); throw error }
    }
    let completed: T | undefined
    const outcome = await idempotency.execute({
      authorize,
      beforeCommit: client=>checkClock(client,true),
      installationId: input.targetInstallationId,
      operation: input.operation,
      key: input.key,
      requestCanonical: JSON.stringify(canonicalize({
        params: input.request.params ?? {},
        body: input.request.body ?? {},
      })),
      run: async client => {
        try {
          completed = await input.run(createTransactionBoundPool(client))
          return { ok: true, metadata: input.metadata(completed) }
        } catch (error) {
          return { ok: false, error }
        }
      },
    })
    if (outcome.kind === 'conflict') {
      throw new MemoryApiError('revision_conflict',
        'Idempotency-Key was already used for a different request')
    }
    if (outcome.kind === 'failed') throw outcome.error
    if (outcome.kind === 'replayed') {
      // The permission locks cover body materialization, not only the saved metadata.
      const client=await deps.pool.connect()
      try {
        await client.query('BEGIN')
        await authorize(client)
        const result=await input.replay(outcome.metadata, createTransactionBoundPool(client))
        await checkClock(client)
        await client.query('COMMIT')
        return result
      } catch(error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    return completed as T
  }

  app.get('/api/v1/memory/governance/scopes', async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const mirrored = await deps.pool.query<{
      installation_id: string
      state: string
      parent_organization_id: string | null
    }>(`
      SELECT installation_id::text, state, parent_organization_id::text
      FROM memory_owner_scopes
      WHERE installation_id = ANY($1::uuid[])
    `, [grant.scopeBindings.map(binding => binding.installation_id)])
    const mirrorByInstallation = new Map(mirrored.rows.map(row => [row.installation_id, row]))
    return {
      scopes: grant.scopeBindings.map(binding => {
        const mirror = mirrorByInstallation.get(binding.installation_id)
        return {
          installation_id: binding.installation_id,
          owner_scope_kind: binding.owner_scope_kind,
          owner_scope_id: binding.owner_scope_id,
          authorization_epoch: binding.authorization_epoch,
          permissions: binding.permissions,
          state: mirror?.state,
          parent_organization_id: mirror?.parent_organization_id ?? null,
        }
      }),
    }
  })

  app.get('/api/v1/memory/governance/proposals', async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const query = request.query as { target_installation_id?: string; state?: string }
    if (!UUID_PATTERN.test(query.target_installation_id ?? '')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id required' } }
    }
    if (!grant.scopeBindings.some(binding => binding.installation_id === query.target_installation_id
      && binding.permissions.some(permission => ['read', 'review'].includes(permission)))) {
      return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    }
    const states = typeof query.state === 'string' && query.state
      ? query.state.split(',').filter(Boolean)
      : undefined
    const candidates = await promotionRepository.listQueue(query.target_installation_id!, states)
    const scopeMode=(await deps.pool.query(`SELECT p.document->>'mode' AS mode FROM memory_review_automation_policy_heads h JOIN memory_review_automation_policies p USING(policy_id) WHERE h.installation_id=$1`,[query.target_installation_id])).rows[0]?.mode??'off'
    const effectiveMode=!deps.automationMode||deps.automationMode==='off'||scopeMode==='off'?'off':deps.automationMode==='shadow'||scopeMode==='shadow'?'shadow':'assist'
    const queue = []
    for (const candidate of candidates) {
      const revision = await promotionRepository.getLatestRevision(candidate.candidate_id)
      const decisions = revision
        ? await promotionRepository.listDecisions(revision.candidate_revision_id)
        : []
      const conflictClaims = ['proposed','approved','conflict'].includes(candidate.state)
        ? await promotionRepository.listConflictClaims(query.target_installation_id!, candidate)
        : []
      const evidence=revision?await promotionRepository.listEvidence(revision.candidate_revision_id):[]
      const prior=revision?(await deps.pool.query(`SELECT e.excerpt_hash FROM memory_promotion_candidate_versions v JOIN memory_promotion_evidence e USING(candidate_revision_id) WHERE v.candidate_id=$1 AND v.revision_number=$2 ORDER BY e.ordinal`,[candidate.candidate_id,revision.revision_number-1])).rows:[]
      const nowHashes=new Set(evidence.map(e=>e.excerpt_hash)),oldHashes=new Set(prior.map(e=>e.excerpt_hash))
      queue.push({
        candidate,
        current_revision: revision
          ? { revision_number: revision.revision_number, statement: revision.statement,bundle_hash:revision.revision_bundle_hash,structured_content:revision.structured_content,applicability:revision.revision_bundle?.applicability ?? null }
          : null,
        decisions: decisions.map(decision => ({
          decision: decision.decision,
          membership_id: decision.membership_id,
          created_at: decision.created_at,
        })),
        evidence,
        evidence_changes:{added:[...nowHashes].filter(h=>!oldHashes.has(h)).length,removed:[...oldHashes].filter(h=>!nowHashes.has(h)).length,retained:[...nowHashes].filter(h=>oldHashes.has(h)).length},
        delegated_publish_mode:deps.delegatedPublishMode??'off',
        automation_mode:effectiveMode,
        automation_advice:effectiveMode!=='off'?await automation.currentAdvice({installationId:query.target_installation_id!,candidateId:candidate.candidate_id,subjectKind:'promotion'}):null,
        conflict_claims: conflictClaims,
      })
    }
    return { queue }
  })

  app.post('/api/v1/memory/governance/proposals', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    const sourceInstallationId = body?.source_installation_id
    const sourceClaimId = body?.source_claim_id
    const targetInstallationId = body?.target_installation_id
    const expectedRevision = body?.expected_revision
    const evidenceIds = body?.evidence_ids
    if (typeof sourceInstallationId !== 'string' || typeof sourceClaimId !== 'string'
      || typeof targetInstallationId !== 'string' || typeof expectedRevision !== 'number'
      || !Array.isArray(evidenceIds)
      || !evidenceIds.every(id => typeof id === 'string')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, expected_revision, source_installation_id, source_claim_id and evidence_ids required' } }
    }
    const targetBinding = grant.scopeBindings.find(binding =>
      binding.installation_id === targetInstallationId)
    if (targetInstallationId !== grant.primaryInstallationId || !targetBinding) {
      return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    }
    if (Number(targetBinding.authorization_epoch) !== expectedRevision) {
      return fail(reply, new MemoryApiError('revision_conflict', 'target scope revision mismatch'))
    }
    const digest = createHash('sha256').update(
      `${grant.installationId}|${sourceInstallationId}|${sourceClaimId}|${evidenceIds.join(',')}|${idempotencyKey}`,
    ).digest('hex')
    try {
      const result = await idempotentMutation({
        grant,
        targetInstallationId,
        operation: 'governance.propose',
        key: idempotencyKey,
        request,
        run: pool => createPromotionService(pool).propose({
          grant,
          sourceInstallationId,
          sourceClaimId,
          evidenceIds,
          idempotencyDigest: digest,
        }),
        metadata: proposed => ({
          candidate_id: proposed.candidate.candidate_id,
          candidate_revision_id: proposed.candidateRevision.candidate_revision_id,
          classification: proposed.classification,
        }),
        replay: async (metadata, transactionPool) => {
          const repository = createPromotionRepository(transactionPool)
          const candidateId = String(metadata.candidate_id ?? '')
          const candidate = await repository.getCandidate(targetInstallationId, candidateId)
          const candidateRevision = await repository.getRevision(candidateId, String(metadata.candidate_revision_id))
          if (!candidate || !candidateRevision) {
            throw new PromotionError('not_found', 'idempotent proposal result not found')
          }
          const canReadTarget = grant.scopeBindings.some(binding =>
            binding.installation_id === targetInstallationId && binding.permissions.includes('read'))
          // Legacy receipts may retain a target-derived classification after a
          // new revision clears the candidate's current conflict fields.
          const hasTargetClassification = metadata.classification !== 'new'
            || candidateRevision.revision_bundle?.relationships
            || candidate.conflict_group_id || candidate.duplicate_of_claim_id
          if (!canReadTarget && hasTargetClassification) {
            throw new PromotionError('not_found', 'proposal result unavailable')
          }
          return {
            candidate,
            candidateRevision,
            classification: metadata.classification as 'new' | 'duplicate' | 'related' | 'potential_conflict' | 'conflict',
          }
        },
      })
      reply.code(201)
      return {
        candidate: result.candidate,
        candidate_revision: result.candidateRevision,
        classification: result.classification,
      }
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })

  const bulkSchema=z.object({target_installation_id:z.string().uuid(),items:z.array(z.object({candidate_id:z.string().uuid(),expected_revision:z.number().int().positive(),expected_hash:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['approve','request_changes','reject']),review_duration_ms:z.number().int().min(0).max(86400000).optional()}).strict()).min(1).max(20)}).strict()
  app.post('/api/v1/memory/governance/bulk-decisions',{bodyLimit:32768},async(request,reply)=>{
    const grant=await guardV2OrFail(request,reply,'memory.search');if(isFailed(grant))return grant.failed
    const key=requireIdempotencyKey(request,reply),parsed=bulkSchema.safeParse(request.body)
    if(!key||!parsed.success)return fail(reply,new MemoryApiError('invalid_request','exact item revision/hash required'))
    const results=[]
    for(const [index,item] of parsed.data.items.entries()){
      try{
        const result=await idempotentMutation({grant,targetInstallationId:parsed.data.target_installation_id,operation:'governance.decision',key:createHash('sha256').update(JSON.stringify([key,index])).digest('hex'),request:{body:{...item,target_installation_id:parsed.data.target_installation_id},params:{candidateId:item.candidate_id}},run:pool=>createPublicationService(pool).decide({grant,targetInstallationId:parsed.data.target_installation_id,candidateId:item.candidate_id,expectedCandidateRevision:item.expected_revision,expectedBundleHash:item.expected_hash,decision:item.decision,reviewDurationMs:item.review_duration_ms}),metadata:r=>({decision_id:r.decisionId}),replay:async m=>({decisionId:String(m.decision_id)})})
        results.push({candidate_id:item.candidate_id,status:'success',decision_id:result.decisionId})
      }catch(error){
        if(error instanceof PublicationError||error instanceof MemoryApiError||error instanceof TargetBindingError){
          const code=error instanceof TargetBindingError?'forbidden':error.code
          results.push({candidate_id:item.candidate_id,status:code==='forbidden'?'revoked':code==='not_found'?'unavailable':'conflict',code})
        }else throw error
      }
    }
    return {results}
  })
  app.get('/api/v1/memory/governance/executor-principals',async(request,reply)=>{
    const grant=await guardV2OrFail(request,reply,'memory.search');if(isFailed(grant))return grant.failed
    const id=(request.query as {target_installation_id?:string}).target_installation_id
    if(!id||!UUID_PATTERN.test(id))return fail(reply,new MemoryApiError('invalid_request','target scope required'))
    const c=await deps.pool.connect()
    try{await c.query('BEGIN');await requireCurrentScopePermission({client:c,grant,targetInstallationId:id,permission:'publish'});const rows=(await c.query(`SELECT principal_id,provider_client_id,permission_revision::text,valid_until FROM memory_governance_executor_principals WHERE installation_id=$1 AND state='active' AND 'publish_delegated'=ANY(permissions) AND valid_until>clock_timestamp() ORDER BY created_at LIMIT 50`,[id])).rows;await assertCurrentGrantClock(c,grant,[id]);await c.query('COMMIT');return {principals:rows,mode:deps.delegatedPublishMode??'off'}}catch(e){await c.query('ROLLBACK');if(e instanceof TargetBindingError)return fail(reply,new MemoryApiError('forbidden','current publisher required'));throw e}finally{c.release()}
  })
  app.post('/api/v1/memory/governance/executor-principals',{bodyLimit:8192},async(request,reply)=>{
    const grant=await guardV2OrFail(request,reply,'memory.search');if(isFailed(grant))return grant.failed
    const key=requireIdempotencyKey(request,reply),body=z.object({target_installation_id:z.string().uuid(),provider_client_id:z.string().min(1).max(200),permissions:z.array(z.enum(['auto_accept_personal','publish_delegated'])).min(1).max(2),expires_at:z.string().datetime(),max_accepts_per_day:z.number().int().min(0).max(1000).optional()}).strict().safeParse(request.body)
    if(!key||!body.success)return fail(reply,new MemoryApiError('invalid_request','bounded executor permission and deadline required'))
    try{return await idempotentMutation<{principalId:string}>({grant,targetInstallationId:body.data.target_installation_id,operation:'governance.executor_principal',key,request,run:pool=>createExecutorPrincipals(pool).authorize({grant,installationId:body.data.target_installation_id,providerClientId:body.data.provider_client_id,permissions:body.data.permissions,expiresAt:body.data.expires_at,maxAcceptsPerDay:body.data.max_accepts_per_day}),metadata:r=>r,replay:async m=>({principalId:String(m.principalId)})})}catch(e){return fail(reply,new MemoryApiError('forbidden','current human policy admin required'))}
  })
  app.post('/api/v1/memory/governance/executor-principals/:id/disable',{bodyLimit:4096},async(request,reply)=>{
    const grant=await guardV2OrFail(request,reply,'memory.search');if(isFailed(grant))return grant.failed
    const key=requireIdempotencyKey(request,reply),body=z.object({target_installation_id:z.string().uuid(),expected_revision:z.string().regex(/^[1-9][0-9]*$/)}).strict().safeParse(request.body),id=(request.params as {id:string}).id
    if(!key||!body.success||!UUID_PATTERN.test(id))return fail(reply,new MemoryApiError('invalid_request','executor scope and permission revision required'))
    try{return await idempotentMutation({grant,targetInstallationId:body.data.target_installation_id,operation:'governance.executor_principal',key,request,run:pool=>createExecutorPrincipals(pool).disable({grant,installationId:body.data.target_installation_id,principalId:id,expectedRevision:body.data.expected_revision}),metadata:r=>r,replay:async()=>({disabled:true})})}catch(e){return fail(reply,new MemoryApiError('forbidden','current human policy admin required'))}
  })
  app.post('/api/v1/memory/governance/publication-delegations',{bodyLimit:8192},async(request,reply)=>{
    const grant=await guardV2OrFail(request,reply,'memory.search');if(isFailed(grant))return grant.failed
    const key=requireIdempotencyKey(request,reply),body=z.object({target_installation_id:z.string().uuid(),candidate_id:z.string().uuid(),expected_revision:z.number().int().positive(),expected_hash:z.string().regex(/^[a-f0-9]{64}$/),principal_id:z.string().uuid(),expires_at:z.string().datetime()}).strict().safeParse(request.body)
    if(!key||!body.success)return fail(reply,new MemoryApiError('invalid_request','exact revision, scope and executor required'))
    if(deps.delegatedPublishMode!=='enabled')return fail(reply,new MemoryApiError('revision_conflict','delegated publication is off'))
    try{return await idempotentMutation<{delegationId:string}>({grant,targetInstallationId:body.data.target_installation_id,operation:'governance.delegate_publish',key,request,run:pool=>createPublicationDelegation(pool).create({grant,installationId:body.data.target_installation_id,candidateId:body.data.candidate_id,expectedRevision:body.data.expected_revision,expectedHash:body.data.expected_hash,principalId:body.data.principal_id,expiresAt:body.data.expires_at}),metadata:r=>r,replay:async m=>({delegationId:String(m.delegationId)})})}catch(e){return fail(reply,new MemoryApiError(e instanceof TargetBindingError?'forbidden':'revision_conflict','delegation authorization or revision changed'))}
  })
  app.post('/api/v1/memory/governance/publication-delegations/:id/revoke',{bodyLimit:4096},async(request,reply)=>{
    const grant=await guardV2OrFail(request,reply,'memory.search');if(isFailed(grant))return grant.failed
    const key=requireIdempotencyKey(request,reply),body=z.object({target_installation_id:z.string().uuid()}).strict().safeParse(request.body),id=(request.params as {id:string}).id
    if(!key||!body.success||!UUID_PATTERN.test(id))return fail(reply,new MemoryApiError('invalid_request','exact delegation scope required'))
    try{return await idempotentMutation({grant,targetInstallationId:body.data.target_installation_id,operation:'governance.delegate_revoke',key,request,run:pool=>createPublicationDelegation(pool).revoke({grant,installationId:body.data.target_installation_id,delegationId:id}),metadata:r=>r,replay:async()=>({revoked:true})})}catch(e){return fail(reply,new MemoryApiError('forbidden','current human publisher required'))}
  })

  app.get('/api/v1/memory/governance/automation-policy',async(request,reply)=>{
    const grant=await guardV2OrFail(request,reply,'memory.search');if(isFailed(grant))return grant.failed
    const id=(request.query as {target_installation_id?:string}).target_installation_id
    if(!id||!UUID_PATTERN.test(id))return fail(reply,new MemoryApiError('invalid_request','target scope required'))
    const c=await deps.pool.connect()
    try{await c.query('BEGIN');await requireCurrentScopePermission({client:c,grant,targetInstallationId:id,permission:'read'})
      const row=(await c.query(`SELECT h.revision::int,p.document,p.policy_hash FROM memory_review_automation_policy_heads h JOIN memory_review_automation_policies p USING(policy_id) WHERE h.installation_id=$1`,[id])).rows[0]??{revision:0,document:null}
      await assertCurrentGrantClock(c,grant,[id]);await c.query('COMMIT');return {...row,effective_mode:deps.automationMode??'off'}
    }catch(e){await c.query('ROLLBACK');if(e instanceof TargetBindingError)return fail(reply,new MemoryApiError('forbidden','current read permission required'));throw e}finally{c.release()}
  })
  app.patch('/api/v1/memory/governance/automation-policy',{bodyLimit:8192},async(request,reply)=>{
    const grant=await guardV2OrFail(request,reply,'memory.search');if(isFailed(grant))return grant.failed
    const key=requireIdempotencyKey(request,reply),parsed=z.object({target_installation_id:z.string().uuid(),expected_revision:z.number().int().min(0),document:automationPolicySchema}).strict().safeParse(request.body)
    if(!key||!parsed.success)return fail(reply,new MemoryApiError('invalid_request','off/shadow/assist policy and CAS required'))
    try{return await idempotentMutation<Record<string,unknown>>({grant,targetInstallationId:parsed.data.target_installation_id,operation:'governance.automation_policy',key,request,run:pool=>createAutomationRepository(pool).setPolicy({installationId:parsed.data.target_installation_id,grant,expectedRevision:parsed.data.expected_revision,document:parsed.data.document}),metadata:r=>r,replay:async m=>m})}
    catch(e){if(e instanceof TargetBindingError)return fail(reply,new MemoryApiError('forbidden','current human policy admin required'));if(e instanceof Error&&e.message==='automation_policy_conflict')return fail(reply,new MemoryApiError('revision_conflict','automation policy changed'));return mapGovernanceError(e,reply)}
  })

  app.post('/api/v1/memory/governance/proposals/:candidateId/decisions', { bodyLimit: 8192 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    const targetInstallationId = body?.target_installation_id
    const expectedRevision = body?.expected_revision
    const decision = body?.decision
    if (typeof targetInstallationId !== 'string'
      || typeof expectedRevision !== 'number'
      || (decision !== 'approve' && decision !== 'request_changes' && decision !== 'reject')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, expected_revision and decision required' } }
    }
    try {
      const result = await idempotentMutation({
        grant,
        targetInstallationId,
        operation: 'governance.decision',
        key: idempotencyKey,
        request,
        run: pool => createPublicationService(pool).decide({
          grant,
          targetInstallationId,
          candidateId: (request.params as { candidateId: string }).candidateId,
          expectedCandidateRevision: expectedRevision,
          expectedBundleHash:typeof body?.expected_hash==='string'?body.expected_hash:undefined,
          reviewDurationMs:typeof body?.review_duration_ms==='number'&&Number.isInteger(body.review_duration_ms)&&body.review_duration_ms>=0&&body.review_duration_ms<=86400000?body.review_duration_ms:undefined,
          decision,
          reasonCode: typeof body?.reason_code === 'string' ? body.reason_code : undefined,
        }),
        metadata: decided => ({ decision_id: decided.decisionId }),
        replay: async metadata => ({ decisionId: String(metadata.decision_id) }),
      })
      return { decision_id: result.decisionId }
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })

  app.post('/api/v1/memory/governance/proposals/:candidateId/revise', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.target_installation_id !== 'string'
      || typeof body?.expected_revision !== 'number'
      || typeof body?.statement !== 'string' || body.statement.length < 1 || body.statement.length > 4000
      || body?.structured_content === null || typeof body?.structured_content !== 'object'
      || Array.isArray(body?.structured_content)) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, expected_revision, statement and structured_content required' } }
    }
    const targetInstallationId = body.target_installation_id
    const expectedRevision = body.expected_revision
    const statement = body.statement
    const structuredContent = body.structured_content as Record<string, unknown>
    let metadataPatch:RevisionMetadataPatch|undefined
    try {
      if(body.refresh_source_metadata!==undefined&&typeof body.refresh_source_metadata!=='boolean')throw new Error('invalid metadata refresh')
      if(body.metadata_patch!==undefined)metadataPatch=parseRevisionMetadataPatch(body.metadata_patch)
    } catch {return fail(reply,new MemoryApiError('invalid_request','invalid revision metadata'))}
    const selection=body.evidence_selection as {retained_ordinals?:unknown;removed_ordinals?:unknown;new_evidence_ids?:unknown}|undefined
    if(!selection || !Array.isArray(selection.retained_ordinals)||!Array.isArray(selection.removed_ordinals)||!Array.isArray(selection.new_evidence_ids)){
      return fail(reply,new MemoryApiError('invalid_request','explicit evidence_selection required'))
    }
    const evidenceSelection={retainedOrdinals:selection.retained_ordinals as number[],removedOrdinals:selection.removed_ordinals as number[],newEvidenceIds:selection.new_evidence_ids as string[]}
    const binding = grant.scopeBindings.find(entry => entry.installation_id === targetInstallationId)
    if (!binding || (!binding.permissions.includes('contribute') && !binding.permissions.includes('review'))) {
      return fail(reply, new MemoryApiError('forbidden', 'contribute or review permission required'))
    }
    const candidateId = (request.params as { candidateId: string }).candidateId
    const candidate = await promotionRepository.getCandidate(targetInstallationId, candidateId)
    if (!candidate) return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    if (candidate.created_by_membership_id !== binding.membership_id && !binding.permissions.includes('review')) {
      return fail(reply, new MemoryApiError('forbidden', 'proposal revision forbidden'))
    }
    try {
      const result = await idempotentMutation({
        grant,
        targetInstallationId,
        operation: 'governance.revise',
        key: idempotencyKey,
        request,
        run: pool => createPromotionRepository(pool).appendRevision({
          targetInstallationId,
          candidateId,
          expectedRevision,
          statement,
          structuredContent,
          evidenceSelection,grant,repairLegacyBundle:body.repair_legacy_bundle===true,
          metadataPatch,refreshSourceMetadata:body.refresh_source_metadata===true,
          contentHash: createHash('sha256').update(statement, 'utf8').digest('hex'),
          createdByMembershipId: binding.membership_id,
        }),
        metadata: revised => ({
          candidate_revision_id: revised.candidateRevisionId,
          revision_number: revised.revisionNumber,
          evidence_changes:revised.evidenceChanges,
        }),
        replay: async metadata => ({
          candidateRevisionId: String(metadata.candidate_revision_id),
          revisionNumber: Number(metadata.revision_number),
          evidenceChanges:metadata.evidence_changes as {retained:number;removed:number;added:number},
        }),
      })
      return result
    } catch (error) {
      if (error instanceof TargetBindingError) return fail(reply,new MemoryApiError('forbidden','current authorization required'))
      if (error instanceof MemoryApiError) return fail(reply,error)
      reply.code(error instanceof Error && error.message.includes('revision') ? 409 : 400)
      return { error: { code: error instanceof Error && error.message.includes('revision') ? 'revision_conflict' : 'state_conflict', message: 'proposal revision rejected' } }
    }
  })

  app.post('/api/v1/memory/governance/proposals/:candidateId/withdraw', { bodyLimit: 8192 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.target_installation_id !== 'string' || typeof body?.expected_revision !== 'number') {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id and expected_revision required' } }
    }
    const targetInstallationId = body.target_installation_id
    const expectedRevision = body.expected_revision
    const binding = grant.scopeBindings.find(entry => entry.installation_id === targetInstallationId)
    if (!binding) return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    try {
      return await idempotentMutation({
        grant,
        targetInstallationId,
        operation: 'governance.withdraw',
        key: idempotencyKey,
        request,
        run: pool => createPromotionRepository(pool).withdraw({
          targetInstallationId,
          candidateId: (request.params as { candidateId: string }).candidateId,
          expectedRevision,
          actorMembershipId: binding.membership_id,
          actorIsScopeAdmin: binding.permissions.includes('scope_admin'),
        }),
        metadata: result => result,
        replay: async metadata => ({
          state: 'withdrawn' as const,
          revision: Number(metadata.revision),
        }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const status = message.includes('not found') ? 404 : message.includes('forbidden') ? 403 : 409
      reply.code(status)
      return { error: { code: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'revision_conflict', message: 'proposal withdrawal rejected' } }
    }
  })

  app.post('/api/v1/memory/governance/proposals/:candidateId/publish', { bodyLimit: 8192 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    const targetInstallationId = body?.target_installation_id
    const expectedRevision = body?.expected_revision
    const resolution = body?.resolution
    if (typeof targetInstallationId !== 'string'
      || typeof expectedRevision !== 'number'
      || (resolution !== 'new' && resolution !== 'parallel' && resolution !== 'supersede')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, expected_revision and resolution required' } }
    }
    const supersedeClaimIds = Array.isArray(body?.supersede_claim_ids)
      ? (body.supersede_claim_ids as unknown[]).filter((id): id is string => typeof id === 'string')
      : undefined
    try {
      const result = await idempotentMutation({
        grant,
        targetInstallationId,
        operation: 'governance.publish',
        key: idempotencyKey,
        request,
        run: pool => createPublicationService(pool,{tombstoneHmacKeys:deps.tombstoneHmacKeys}).publish({
          grant,
          targetInstallationId,
          candidateId: (request.params as { candidateId: string }).candidateId,
          expectedCandidateRevision: expectedRevision,
          resolution,
          supersedeClaimIds,
        }),
        metadata: published => ({
          claim_id: published.claimId,
          version_id: published.versionId,
          conflict_group_id: published.conflictGroupId,
          conflict_variant: published.conflictVariant,
          resolution: published.resolution,
        }),
        replay: async metadata => ({
          claimId: String(metadata.claim_id),
          versionId: String(metadata.version_id),
          conflictGroupId: metadata.conflict_group_id === null ? null : String(metadata.conflict_group_id),
          conflictVariant: metadata.conflict_variant === null ? null : Number(metadata.conflict_variant),
          resolution: metadata.resolution as 'new' | 'parallel' | 'supersede',
        }),
      })
      return { claim_id: result.claimId, version_id: result.versionId, resolution: result.resolution }
    } catch (error) {
      if ((error instanceof PublicationError || error instanceof MemoryApiError) && error.code === 'forbidden') {
        const binding = grant.scopeBindings.find(entry =>
          entry.installation_id === targetInstallationId)
        await audit.append({
          installationId: targetInstallationId,
          actorMembershipId: binding?.membership_id ?? null,
          action: 'candidate_publish_denied',
          targetKind: 'promotion_candidate',
          targetId: (request.params as { candidateId: string }).candidateId,
          requestHash: createHash('sha256').update(JSON.stringify(canonicalize({
            params: request.params,
            body: request.body,
          }))).digest('hex'),
          previousState: null,
          nextState: null,
          metadata: { reason_code: error.code },
        }).catch(() => {
          // A target can disappear after guard verification. Audit availability
          // must never turn a correctly denied write into a different response.
          request.log.warn({code:'memory_denial_audit_failed'},'Memory denial audit unavailable')
        })
      }
      return mapGovernanceError(error, reply)
    }
  })

  app.post('/api/v1/memory/governance/claims/:claimId/revoke', { bodyLimit: 8192 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.target_installation_id !== 'string'
      || typeof body?.reason !== 'string' || typeof body?.expected_revision !== 'number') {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id, reason and expected_revision required' } }
    }
    const targetInstallationId = body.target_installation_id
    const reason = body.reason
    const expectedRevision = body.expected_revision
    try {
      const result = await idempotentMutation({
        grant,
        targetInstallationId,
        operation: 'governance.revoke',
        key: idempotencyKey,
        request,
        run: pool => createSharedClaimLifecycle(pool).revokeSharedClaim({
          grant,
          targetInstallationId,
          claimId: (request.params as { claimId: string }).claimId,
          reason,
          expectedRevision,
        }),
        metadata: revoked => revoked,
        replay: async metadata => ({ state: String(metadata.state) }),
      })
      return result
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })

  app.get('/api/v1/memory/governance/review-policy', async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const query = request.query as { target_installation_id?: string }
    if (!UUID_PATTERN.test(query.target_installation_id ?? '')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id required' } }
    }
    if (!grant.scopeBindings.some(binding => binding.installation_id === query.target_installation_id)) {
      return fail(reply, new MemoryApiError('not_found', 'resource not found'))
    }
    const versions = await reviewPolicy.listVersions(query.target_installation_id!)
    const head = await reviewPolicy.getHead(query.target_installation_id!)
    return { versions, head }
  })

  app.patch('/api/v1/memory/governance/review-policy', { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.target_installation_id !== 'string' || typeof body?.expected_revision !== 'number') {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id and expected_revision required' } }
    }
    const target = body.target_installation_id
    const expectedRevision = body.expected_revision
    const binding = grant.scopeBindings.find(entry => entry.installation_id === target)
    if (!binding || !binding.permissions.includes('policy_admin')) {
      return fail(reply, new MemoryApiError('forbidden', 'policy_admin permission required'))
    }
    try {
      const result = await idempotentMutation({
        grant,
        targetInstallationId: target,
        operation: 'governance.review_policy',
        key: idempotencyKey,
        request,
        run: pool => createReviewPolicyRepository(pool).publishVersion({
          installationId: target,
          document: body.document as never,
          createdByMembershipId: binding.membership_id,
          expectedRevision,
        }),
        metadata: published => ({
          policy_version_id: published.policyVersionId,
          version_number: published.versionNumber,
        }),
        replay: async metadata => ({
          policyVersionId: String(metadata.policy_version_id),
          versionNumber: Number(metadata.version_number),
        }),
      })
      return result
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })

  app.get('/api/v1/memory/governance/audit', async (request, reply) => {
    const grant = await guardV2OrFail(request, reply, 'memory.search')
    if (isFailed(grant)) return grant.failed
    const query = request.query as { target_installation_id?: string; cursor?: string; limit?: string }
    if (!UUID_PATTERN.test(query.target_installation_id ?? '')) {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'target_installation_id required' } }
    }
    const target = query.target_installation_id!
    if (!grant.scopeBindings.some(binding => binding.installation_id === target
      && binding.permissions.includes('scope_admin'))) {
      return fail(reply, new MemoryApiError('forbidden', 'scope_admin permission required'))
    }
    try {
      const page = await audit.listPage(target, {
        limit: query.limit ? Number(query.limit) : 50,
        cursor: query.cursor,
      })
      return { events: page.events, next_cursor: page.nextCursor }
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid audit cursor') {
        reply.code(410)
        return { error: { code: 'cursor_expired', message: error.message } }
      }
      throw error
    }
  })

  app.post('/api/v1/memory/governance/transfers', { bodyLimit: 8192 }, async (request, reply) => {
    let grant: Awaited<ReturnType<GrantGuard['guardV2Disposition']>>
    try {
      grant = await deps.guard.guardV2Disposition({
        authorization: request.headers.authorization,
        requiredService: 'memory.manage',
      })
    } catch (error) {
      return fail(reply, error instanceof MemoryApiError
        ? error : new MemoryApiError('unauthorized', 'grant rejected'))
    }
    const idempotencyKey = requireIdempotencyKey(request, reply)
    if (!idempotencyKey) return { error: { code: 'invalid_request', message: 'Idempotency-Key required' } }
    const body = request.body as Record<string, unknown> | null
    if (typeof body?.source_installation_id !== 'string'
      || typeof body?.target_installation_id !== 'string'
      || typeof body?.expected_revision !== 'number') {
      reply.code(400)
      return { error: { code: 'invalid_request', message: 'source_installation_id, target_installation_id and expected_revision required' } }
    }
    const sourceInstallationId = body.source_installation_id
    const targetInstallationId = body.target_installation_id
    const expectedRevision = body.expected_revision
    try {
      return await idempotentMutation({
        grant,
        targetInstallationId: sourceInstallationId,
        operation: 'governance.transfer',
        key: idempotencyKey,
        request,
        run: pool => createTransferService(pool).startTeamTransfer({
          grant,
          sourceInstallationId,
          targetInstallationId,
          expectedAuthorizationEpoch: expectedRevision,
        }),
        metadata: started => ({
          transfer_id: started.transferId,
          candidates: started.candidates,
        }),
        replay: async metadata => ({
          transferId: String(metadata.transfer_id),
          candidates: Number(metadata.candidates),
        }),
      })
    } catch (error) {
      return mapGovernanceError(error, reply)
    }
  })
}
