import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import type { SkillSourceContext } from './source-resolver.js'
import type { SkillReplayCaseRegistry } from './replay-service.js'
import { replayTextHash } from './replay-runner.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { validateSkillPublicationTarget } from './publication-validation.js'
import { authorizeSkillExecution, requireSkillExecutionFixture, SkillExecutionError, withSkillTransaction, type SkillIdentity } from './execution-context.js'
import { skillAssignmentBucket } from './rollout-service.js'

const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1)
const Start = z.object({ skillId:z.uuid(),versionId:z.uuid(),expectedPublicationRevision:revision,sessionId:z.string().min(1).max(200),idempotencyKey:key }).strict()
const Complete = z.object({ executionId:z.uuid(),expectedRevision:revision,outcome:z.enum(['succeeded','failed','taken_over','cancelled']),idempotencyKey:key }).strict()
interface ExecutionRow {
  execution_id:string;skill_id:string;version_id:string;session_id:string;state:'started'|'succeeded'|'failed'|'taken_over'|'cancelled';revision:string;
  actor_kind:'personal'|'membership';actor_id:string;membership_revision:string;authorization_epoch:string;
  publication_revision:string;rollout_revision:string;receipt_key:string|null;input_hash:string;started_at:Date;completed_at:Date|null
}
function response(row: ExecutionRow) {
  return {executionId:row.execution_id,skillId:row.skill_id,versionId:row.version_id,state:row.state,revision:Number(row.revision),
    provenance:'fixture' as const,startedAt:row.started_at,completedAt:row.completed_at,naturalExecutionCount:0}
}
export function createSkillExecutionService(deps:{pool:pg.Pool;context:SkillSourceContext;cases:SkillReplayCaseRegistry;fixtureCapability?:object}) {
  async function validate(client:pg.PoolClient,identity:SkillIdentity,input:{skillId:string;versionId:string;sessionId:string}) {
    const head = (await client.query<{revision:string}>(`SELECT revision::text FROM memory_skill_heads WHERE installation_id=$1 AND skill_id=$2`,[identity.installationId,input.skillId])).rows[0]
    if (!head) throw new SkillExecutionError('not_found')
    return validateSkillPublicationTarget(client,identity,{skillId:input.skillId,versionId:input.versionId,expectedRevision:Number(head.revision),mode:'execution',allowHistoricalVersion:true,additionalSessionIds:[input.sessionId]},deps)
  }
  async function active(client:pg.PoolClient,identity:SkillIdentity,input:{skillId:string;versionId:string;expectedPublicationRevision:number}) {
    const head=(await client.query<{current_version_id:string;revision:string;state:string}>(`SELECT current_version_id,revision::text,state FROM memory_skill_publication_heads
      WHERE installation_id=$1 AND skill_id=$2 FOR SHARE`,[identity.installationId,input.skillId])).rows[0]
    if (!head || head.state!=='active' || head.current_version_id!==input.versionId || Number(head.revision)!==input.expectedPublicationRevision) throw new SkillExecutionError('revision_conflict')
    const rollout=(await client.query<{revision:string;state:string;basis_points:number}>(`SELECT revision::text,state,basis_points FROM memory_skill_rollouts WHERE installation_id=$1 AND skill_id=$2 FOR SHARE`,[identity.installationId,input.skillId])).rows[0]
    if (!rollout || rollout.state!=='canary') throw new SkillExecutionError('rollout_disabled')
    return rollout
  }
  return {
    async start(identity:SkillIdentity,raw:unknown) {
      const parsed=Start.safeParse(raw)
      if (!parsed.success) throw new SkillExecutionError('invalid_request')
      const request=parsed.data
      return withSkillTransaction(deps.pool,async client=>{
        const binding=await authorizeSkillExecution(client,identity,deps.context,'read',false)
        requireSkillExecutionFixture(deps.fixtureCapability)
        const validated=await validate(client,identity,request)
        const rollout=await active(client,identity,request)
        const actorKind=binding.owner_scope_kind==='personal'?'personal':'membership',actorId=actorKind==='personal'?binding.owner_scope_id:binding.membership_id!
        const bucket=skillAssignmentBucket(identity.installationId,binding.owner_scope_id,actorId,validated.archive.repository_id,request.skillId)
        if (bucket>=rollout.basis_points) throw new SkillExecutionError('not_assigned')
        const session=await client.query(`SELECT 1 FROM source_sessions s JOIN work_episodes e USING(installation_id,session_id)
          WHERE s.installation_id=$1 AND s.session_id=$2 AND s.deleted_at IS NULL AND e.repository_id=$3 AND e.repo_snapshot_id=$4
            AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=s.installation_id AND t.session_id=s.session_id)
          FOR SHARE OF s,e`,[identity.installationId,request.sessionId,validated.archive.repository_id,validated.archive.repo_snapshot_id])
        if (!session.rowCount) throw new SkillExecutionError('source_invalid')
        const hash=replayTextHash(canonicalJsonString(request))
        // The validated Skill task lock serializes idempotency for this version; cross-Skill key reuse is fenced by a scoped actor lock.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('skill:execution:'||$1||':'||$2||':'||$3,0))`,[identity.installationId,actorId,request.idempotencyKey])
        const old=(await client.query<ExecutionRow>(`SELECT * FROM memory_skill_executions WHERE installation_id=$1 AND actor_kind=$2 AND actor_id=$3 AND idempotency_key=$4 FOR UPDATE`,[identity.installationId,actorKind,actorId,request.idempotencyKey])).rows[0]
        if (old) {
          if (old.input_hash!==hash) throw new SkillExecutionError('receipt_conflict')
          return {...response(old),document:old.state==='started'?validated.version.document:undefined}
        }
        const executionId=randomUUID()
        const inserted=await client.query<ExecutionRow>(`INSERT INTO memory_skill_executions(execution_id,installation_id,skill_id,version_id,repository_id,repo_snapshot_id,
          session_id,document_hash,source_digest,policy_hash,publication_revision,rollout_revision,actor_kind,actor_id,membership_revision,authorization_epoch,
          assignment_bucket,idempotency_key,input_hash)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)RETURNING *`,
        [executionId,identity.installationId,request.skillId,request.versionId,validated.archive.repository_id,validated.archive.repo_snapshot_id,request.sessionId,
          validated.version.document_hash,validated.version.source_digest,validated.version.policy_hash,request.expectedPublicationRevision,Number(rollout.revision),
          actorKind,actorId,binding.membership_revision,binding.authorization_epoch,bucket,request.idempotencyKey,hash])
        return {...response(inserted.rows[0]),document:validated.version.document}
      })
    },
    async complete(identity:SkillIdentity,raw:unknown) {
      const parsed=Complete.safeParse(raw)
      if (!parsed.success) throw new SkillExecutionError('invalid_request')
      const request=parsed.data
      return withSkillTransaction(deps.pool,async client=>{
        const binding=await authorizeSkillExecution(client,identity,deps.context,'read',false)
        requireSkillExecutionFixture(deps.fixtureCapability)
        const observed=(await client.query<ExecutionRow>(`SELECT * FROM memory_skill_executions WHERE installation_id=$1 AND execution_id=$2`,[identity.installationId,request.executionId])).rows[0]
        const actorKind=binding.owner_scope_kind==='personal'?'personal':'membership',actorId=actorKind==='personal'?binding.owner_scope_id:binding.membership_id!
        if (!observed || observed.actor_kind!==actorKind || observed.actor_id!==actorId) throw new SkillExecutionError('not_found')
        await validate(client,identity,{skillId:observed.skill_id,versionId:observed.version_id,sessionId:observed.session_id})
        const rollout=await active(client,identity,{skillId:observed.skill_id,versionId:observed.version_id,expectedPublicationRevision:Number(observed.publication_revision)})
        if (rollout.revision!==observed.rollout_revision || String(binding.membership_revision)!==observed.membership_revision || String(binding.authorization_epoch)!==observed.authorization_epoch) throw new SkillExecutionError('revision_conflict')
        const row=(await client.query<ExecutionRow>(`SELECT * FROM memory_skill_executions WHERE installation_id=$1 AND execution_id=$2 FOR UPDATE`,[identity.installationId,request.executionId])).rows[0]
        if (!row) throw new SkillExecutionError('not_found')
        if (row.state!=='started') {
          if (row.receipt_key===request.idempotencyKey && row.state===request.outcome && Number(row.revision)===request.expectedRevision+1) return response(row)
          throw new SkillExecutionError('receipt_conflict')
        }
        if (Number(row.revision)!==request.expectedRevision) throw new SkillExecutionError('revision_conflict')
        const updated=await client.query<ExecutionRow>(`UPDATE memory_skill_executions SET state=$3,revision=revision+1,receipt_key=$4,completed_at=NOW()
          WHERE installation_id=$1 AND execution_id=$2 AND revision=$5 AND state='started' RETURNING *`,[identity.installationId,request.executionId,request.outcome,request.idempotencyKey,request.expectedRevision])
        if (updated.rowCount!==1) throw new SkillExecutionError('revision_conflict')
        return response(updated.rows[0])
      })
    },
    async list(identity:SkillIdentity,raw:unknown) {
      const parsed=z.object({skillId:z.uuid()}).strict().safeParse(raw)
      if (!parsed.success) throw new SkillExecutionError('invalid_request')
      return withSkillTransaction(deps.pool,async client=>{
        await authorizeSkillExecution(client,identity,deps.context,'read')
        const rows=await client.query<ExecutionRow>(`SELECT * FROM memory_skill_executions WHERE installation_id=$1 AND skill_id=$2 ORDER BY started_at DESC,execution_id LIMIT 100`,[identity.installationId,parsed.data.skillId])
        const counts={started:0,succeeded:0,failed:0,taken_over:0,cancelled:0}
        const totals=await client.query<{state:ExecutionRow['state'];count:string}>(`SELECT state,COUNT(*)::text AS count FROM memory_skill_executions WHERE installation_id=$1 AND skill_id=$2 GROUP BY state`,[identity.installationId,parsed.data.skillId])
        for (const row of totals.rows) counts[row.state]=Number(row.count)
        return {items:rows.rows.map(response),counts,unfinished:counts.started,naturalExecutionCount:0}
      })
    },
  }
}
