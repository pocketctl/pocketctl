import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import type { V2GrantFacts } from '../governance/authorization.js'
import { createScopeAuthorization } from '../governance/authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { loadSkillReviewPolicySnapshot as policySnapshot } from './review-policy-binding.js'
import { currentReviewDecisions, evaluateQuorum } from '../governance/authority.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { SkillCandidateDocumentSchema, skillDocumentHash } from './types.js'
import { assessSkillRisk } from './risk-policy.js'
import { resolveSkillSource, SkillWorkError, type SkillSourceContext } from './source-resolver.js'
import { appendSkillAudit, SKILL_AUDIT_ACTIONS, type SkillAuditInput } from './audit-repository.js'
import { appendSkillVersion, archiveSourceRequest, findSkillArchive, findSkillVersion, type SkillVersionRow } from './version-repository.js'

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
const subject = { skillId: z.uuid(), expectedRevision: revision }
const Request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('draft'), candidateId: z.uuid(), expectedRevision: revision }).strict(),
  z.object({ action: z.literal('edit'), ...subject, document: SkillCandidateDocumentSchema }).strict(),
  z.object({action:z.literal('approve'),...subject,reviewOutcome:z.enum(['accepted_as_is','light_edit','major_edit']).optional()}).strict(),
  ...(['request_changes','reject','revoke'] as const).map(action => z.object({ action: z.literal(action), ...subject }).strict()),
])
type RequestBody = z.infer<typeof Request>
type ErrorCode = Exclude<SkillAuditInput['code'], 'ok'>
export class SkillReviewError extends Error {
  readonly statusCode: number
  constructor(readonly code: ErrorCode) {
    super(code)
    this.name = 'SkillReviewError'
    this.statusCode = code === 'not_found' ? 404 : ['forbidden','self_review_denied'].includes(code) ? 403
      : ['invalid_request','secret_detected','size_exceeded','source_tokens_invalid'].includes(code) ? 400
        : code === 'feature_disabled' ? 503 : 409
  }
}
export interface SkillReviewResult {
  skillId: string; versionId: string; revision: number
  state: SkillVersionRow['state']; decisionId?: string
}
interface Actor { actorKind: 'personal' | 'membership'; actorId: string }
function fail(code: ErrorCode): never { throw new SkillReviewError(code) }

/** Internal governance boundary. Verified identity context is separate from strict request JSON. */
export function createSkillReviewService(deps: { pool: pg.Pool; context: SkillSourceContext }) {
  return {
    async execute(identity: { installationId: string; grant: V2GrantFacts }, rawRequest: unknown): Promise<SkillReviewResult> {
      const client = await deps.pool.connect()
      let actor: Actor | null = null
      let result: SkillReviewResult | undefined
      const requestedAction = rawRequest && typeof rawRequest === 'object' ? (rawRequest as { action?: unknown }).action : null
      const action = SKILL_AUDIT_ACTIONS.includes(requestedAction as SkillAuditInput['action'])
        ? requestedAction as SkillAuditInput['action'] : 'draft'
      let request: RequestBody | undefined
      try {
        await client.query('BEGIN')
        const parsed = Request.safeParse(rawRequest)
        if (!parsed.success) fail('invalid_request')
        request = parsed.data
        const requiredPermission = request.action === 'draft' || request.action === 'edit' ? 'contribute'
          : request.action === 'revoke' ? 'publish' : 'review'
        // Early check avoids disclosing resource existence. Revalidated under source/scope locks below.
        const auth = createScopeAuthorization(createTransactionBoundPool(client))
        const early = await auth.validateV2Grant(identity.grant)
        if (!early || !auth.hasPermission(early, identity.installationId, requiredPermission)) fail('forbidden')
        const observedVersion = request.action === 'draft' ? null : await findSkillVersion(client, identity.installationId, request.skillId)
        if (request.action !== 'draft' && !observedVersion) fail('not_found')
        const archive = await findSkillArchive(client, identity.installationId,
          request.action === 'draft' ? request.candidateId : observedVersion!.candidate_id)
        if (!archive) fail('not_found')
        const source = await resolveSkillSource(client, { ...identity, source: archiveSourceRequest(archive), requiredPermission }, deps.context)
        if (source.sourceDigest !== archive.source_digest || source.inputDigest !== archive.input_digest) fail('source_invalid')
        const currentGrant = await auth.validateV2Grant(identity.grant)
        const binding = currentGrant?.scopeBindings.find(b => b.installation_id === identity.installationId)
        if (!binding || !binding.permissions.includes(requiredPermission)) fail('forbidden')
        actor = binding.owner_scope_kind === 'personal' ? { actorKind: 'personal', actorId: binding.owner_scope_id }
          : { actorKind: 'membership', actorId: binding.membership_id! }
        // Preserve Task4/5 ordering; source invalidation and candidate replacement also lock this task.
        const task = await client.query<{ current_generation: string }>(`SELECT current_generation::text FROM memory_skill_tasks
          WHERE installation_id=$1 AND task_id=$2 FOR UPDATE`, [identity.installationId,archive.task_id])
        if (!task.rowCount) fail('not_found')
        if (request.action === 'draft') {
          const candidate = await findSkillArchive(client, identity.installationId, request.candidateId)
          if (!candidate || candidate.candidate_state !== 'candidate' || candidate.generation !== task.rows[0].current_generation) fail('source_invalid')
        }
        let skillId = observedVersion?.skill_id
        if (!skillId) {
          await client.query(`INSERT INTO memory_skills(skill_id,installation_id,task_id)VALUES($1,$2,$3)
            ON CONFLICT(installation_id,task_id) DO NOTHING`, [randomUUID(),identity.installationId,archive.task_id])
          skillId = (await client.query<{ skill_id: string }>(`SELECT skill_id FROM memory_skills WHERE installation_id=$1 AND task_id=$2 FOR UPDATE`,
            [identity.installationId,archive.task_id])).rows[0].skill_id
        }
        const current = await findSkillVersion(client, identity.installationId, skillId, true)
        if (Number(current?.revision ?? 0) !== request.expectedRevision) fail('revision_conflict')
        if (current && ['rejected','revoked'].includes(current.state)) fail('state_conflict')
        if (request.action !== 'draft' && (!current || current.version_id !== observedVersion!.version_id)) fail('revision_conflict')
        if (request.action === 'draft' && current?.candidate_id === archive.candidate_id) fail('state_conflict')
        const nextRevision = request.expectedRevision + 1
        if (request.action === 'draft' || request.action === 'edit') {
          const doc = SkillCandidateDocumentSchema.parse(request.action === 'edit' ? request.document : archive.document)
          if (canonicalJsonString(doc).length > deps.context.config.maxCandidateChars) fail('size_exceeded')
          if (JSON.stringify([...doc.source_tokens].sort()) !== JSON.stringify(source.sources.map(s => s.token).sort())) fail('source_tokens_invalid')
          const risk = assessSkillRisk(doc)
          if (risk.secretDetected) fail('secret_detected')
          const policy = await policySnapshot(client, identity.installationId, binding)
          const versionId = await appendSkillVersion(client, { installationId: identity.installationId, skillId, source: archive,
            document: doc, documentHash: skillDocumentHash(doc), policySnapshot: policy.snapshot, policyHash: policy.hash,
            risk: risk.risk, ...actor, authorizationEpoch: binding.authorization_epoch })
          if (current) {
            const changed = await client.query(`UPDATE memory_skill_heads SET current_version_id=$3,state='draft',revision=$4,updated_at=NOW()
              WHERE installation_id=$1 AND skill_id=$2 AND revision=$5`, [identity.installationId,skillId,versionId,nextRevision,request.expectedRevision])
            if (changed.rowCount !== 1) fail('revision_conflict')
          } else {
            await client.query(`INSERT INTO memory_skill_heads(installation_id,skill_id,current_version_id,revision,state)VALUES($1,$2,$3,$4,'draft')`,
              [identity.installationId,skillId,versionId,nextRevision])
          }
          result = { skillId, versionId, revision: nextRevision, state: 'draft' }
        } else if (request.action === 'revoke') {
          await client.query(`UPDATE memory_skill_heads SET state='revoked',revision=$3,updated_at=NOW()
            WHERE installation_id=$1 AND skill_id=$2 AND revision=$4`, [identity.installationId,skillId,nextRevision,request.expectedRevision])
          result = { skillId, versionId: current!.version_id, revision: nextRevision, state: 'revoked' }
        } else {
          const version = current!
          const policy = await policySnapshot(client, identity.installationId, binding)
          if (policy.hash !== version.policy_hash) fail('policy_changed')
          if (request.action === 'approve' && actor.actorKind === version.author_kind && actor.actorId === version.author_id
            && (version.risk !== 'low' || policy.snapshot.policy.require_independent_reviewer)) fail('self_review_denied')
          const duplicate = await client.query(`SELECT 1 FROM memory_skill_review_decisions
            WHERE installation_id=$1 AND version_id=$2 AND actor_kind=$3 AND actor_id=$4`, [identity.installationId,version.version_id,actor.actorKind,actor.actorId])
          if (duplicate.rowCount) fail('duplicate_decision')
          const decisionId = randomUUID()
          await client.query(`INSERT INTO memory_skill_review_decisions(decision_id,installation_id,skill_id,version_id,
            document_hash,source_digest,policy_hash,actor_kind,actor_id,membership_revision,authorization_epoch,decision,review_outcome)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [decisionId,identity.installationId,skillId,version.version_id,
            version.document_hash,version.source_digest,version.policy_hash,actor.actorKind,actor.actorId,
            actor.actorKind === 'membership' ? binding.membership_revision : null,binding.authorization_epoch,request.action,request.action==='approve'?request.reviewOutcome??null:null])
          const decisions = await client.query<{
            decision_id: string; actor_kind: string; actor_id: string; membership_revision: string | null
            decision: 'approve' | 'request_changes' | 'reject'
          }>(`SELECT decision_id,actor_kind,actor_id,membership_revision::text,decision FROM memory_skill_review_decisions
            WHERE installation_id=$1 AND version_id=$2 AND authorization_epoch=$3`, [identity.installationId,version.version_id,binding.authorization_epoch])
          let counted: Array<{ membershipId: string; decision: 'approve' | 'request_changes' | 'reject' }>
          if (binding.owner_scope_kind === 'personal') {
            counted = decisions.rows.filter(d => d.actor_kind === 'personal' && d.actor_id === binding.owner_scope_id)
              .map(d => ({ membershipId: d.actor_id, decision: d.decision }))
          } else {
            const memberships = await client.query<{ membership_id: string; membership_revision: string; state: string; roles: string[] }>(`
              SELECT membership_id,membership_revision::text,state,roles FROM memory_scope_memberships
              WHERE installation_id=$1 AND membership_id=ANY($2::uuid[]) ORDER BY membership_id FOR SHARE`,
            [identity.installationId,decisions.rows.filter(d => d.actor_kind === 'membership').map(d => d.actor_id)])
            counted = currentReviewDecisions(decisions.rows.filter(d => d.actor_kind === 'membership').map(d => ({
              decisionId: d.decision_id, membershipId: d.actor_id, membershipRevision: d.membership_revision!, decision: d.decision,
            })), memberships.rows.filter(m => policy.snapshot.policy.publisher_may_count_as_reviewer || !m.roles.includes('publisher'))
              .map(m => ({ membershipId: m.membership_id, membershipRevision: m.membership_revision, state: m.state, roles: m.roles })))
          }
          // At review time this actor is not publishing. The existing quorum helper also enforces
          // self-publication; personal low-risk review explicitly permits its owner at this stage.
          const quorum = evaluateQuorum({ decisions: counted,
            policy: binding.owner_scope_kind === 'personal' ? { ...policy.snapshot.policy, allow_self_publish: true } : policy.snapshot.policy,
            proposerMembershipId: version.author_id, publisherMembershipId: actor.actorId })
          const state = request.action === 'reject' ? 'rejected' : quorum.ok ? 'reviewed' : 'draft'
          await client.query(`UPDATE memory_skill_heads SET state=$3,revision=$4,updated_at=NOW()
            WHERE installation_id=$1 AND skill_id=$2 AND revision=$5`, [identity.installationId,skillId,state,nextRevision,request.expectedRevision])
          result = { skillId, versionId: version.version_id, revision: nextRevision, state, decisionId }
        }
        await appendSkillAudit(client, { installationId: identity.installationId, ...actor, action, outcome: 'allowed',
          skillId: result.skillId, versionId: result.versionId, revision: result.revision, code: 'ok' })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        const domain = error instanceof SkillReviewError ? error : error instanceof SkillWorkError
          ? new SkillReviewError(error.code === 'skill_forbidden' ? 'forbidden' : error.code === 'skill_disabled' ? 'feature_disabled' : 'source_invalid') : null
        if (domain) {
          // Separate transaction after rollback makes denials durable without keeping partial versions.
          await client.query('BEGIN')
          try {
            await appendSkillAudit(client, { installationId: identity.installationId, actorKind: actor?.actorKind ?? null, actorId: actor?.actorId ?? null,
              action, outcome: 'denied', skillId: request && 'skillId' in request ? request.skillId : null,
              versionId: null, revision: null, code: domain.code })
            await client.query('COMMIT')
          } catch (auditError) { await client.query('ROLLBACK'); throw auditError }
          throw domain
        }
        throw error
      } finally { client.release() }
    },
  }
}
