import { createHash } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import type { SkillSourceContext } from './source-resolver.js'
import { authorizeSkillExecution, requireSkillExecutionFixture, SkillExecutionError, withSkillTransaction, type SkillIdentity } from './execution-context.js'

const Request = z.object({ skillId: z.uuid(), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),
  basisPoints: z.number().int().min(0).max(10000), state: z.enum(['shadow','canary','disabled']) }).strict()
/** Stable actor/scope/repository assignment; membership and publication checks remain separate. */
export function skillAssignmentBucket(installationId: string, ownerId: string, actorId: string, repositoryId: string, skillId: string): number {
  return createHash('sha256').update(JSON.stringify([installationId,ownerId,actorId,repositoryId,skillId])).digest().readUInt32BE(0) % 10000
}
export function createSkillRolloutService(deps: { pool: pg.Pool; context: SkillSourceContext; fixtureCapability?: object }) {
  return {
    async configure(identity: SkillIdentity, raw: unknown) {
      const parsed = Request.safeParse(raw)
      if (!parsed.success) throw new SkillExecutionError('invalid_request')
      const request = parsed.data
      return withSkillTransaction(deps.pool, async client => {
        await authorizeSkillExecution(client,identity,deps.context,'publish')
        // Anyone currently authorized to publish may close a fixture rollout; enabling stays construction-gated.
        if (request.state !== 'disabled') requireSkillExecutionFixture(deps.fixtureCapability)
        const skill = await client.query(`SELECT 1 FROM memory_skills WHERE installation_id=$1 AND skill_id=$2 FOR UPDATE`, [identity.installationId,request.skillId])
        if (!skill.rowCount) throw new SkillExecutionError('not_found')
        const previous = (await client.query<{revision: string}>(`SELECT revision::text FROM memory_skill_rollouts WHERE installation_id=$1 AND skill_id=$2 FOR UPDATE`, [identity.installationId,request.skillId])).rows[0]
        if (Number(previous?.revision ?? 0) !== request.expectedRevision) throw new SkillExecutionError('revision_conflict')
        const revision = request.expectedRevision + 1
        await client.query(`INSERT INTO memory_skill_rollouts(installation_id,skill_id,revision,state,basis_points)VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(installation_id,skill_id) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,basis_points=EXCLUDED.basis_points,updated_at=NOW()`,
        [identity.installationId,request.skillId,revision,request.state,request.basisPoints])
        if (request.state === 'disabled') await client.query(`UPDATE memory_skill_executions SET state='cancelled',revision=revision+1,completed_at=NOW()
          WHERE installation_id=$1 AND skill_id=$2 AND state='started'`, [identity.installationId,request.skillId])
        return { skillId: request.skillId, revision, state: request.state, basisPoints: request.basisPoints }
      })
    },
  }
}
