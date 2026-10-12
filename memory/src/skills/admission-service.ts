import type pg from 'pg'
import { z } from 'zod'
import {assertCurrentGrantClock,TargetBindingError,type V2GrantFacts} from '../governance/authorization.js'
import { persistSkillTask, type ScheduledSkillTask } from './repository.js'
import { assertCurrentSkillSourceClock, resolveSkillSource, SkillWorkError, SkillSourceRequestSchema, type SkillSourceContext } from './source-resolver.js'

const Request = z.object({ candidateKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/),
  source: SkillSourceRequestSchema }).strict()
export function createSkillAdmissionService(deps: { pool: pg.Pool; context: SkillSourceContext;onOutcome?:(outcome:'admitted'|'deduplicated'|'rejected')=>void }) {
  return { async schedule(input: { installationId: string; grant: V2GrantFacts; candidateKey: string; source: unknown }): Promise<ScheduledSkillTask> {
    const parsed = Request.safeParse({ candidateKey: input.candidateKey, source: input.source })
    if (!parsed.success) throw new Error('skill_admission_invalid')
    const client = await deps.pool.connect()
    try {
      await client.query('BEGIN')
      const resolved = await resolveSkillSource(client, { installationId: input.installationId,
        grant: input.grant, source: parsed.data.source }, deps.context)
      const result = await persistSkillTask(client, { resolved, candidateKey: parsed.data.candidateKey,
        grant: input.grant, source: parsed.data.source })
      try { await assertCurrentGrantClock(client,input.grant,[input.installationId]) }
      catch(error) { if(error instanceof TargetBindingError)throw new SkillWorkError('skill_forbidden');throw error }
      await assertCurrentSkillSourceClock(client,resolved)
      await client.query('COMMIT')
      try {deps.onOutcome?.(result.deduplicated?'deduplicated':'admitted')} catch { /* telemetry cannot change admission */ }
      return result
    } catch (error) { await client.query('ROLLBACK').catch(()=>undefined);try {deps.onOutcome?.('rejected')}catch { /* telemetry only */ };throw error } finally { client.release() }
  }}
}
