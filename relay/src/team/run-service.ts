import type pg from 'pg'

import { TeamRunRepository, type TeamRunMutation } from './run-repository.js'
import { TeamRepositoryError } from './repository.js'
import type { TeamEvent, TeamRun, TeamRunBudget } from './types.js'

export const DEFAULT_TEAM_RUN_BUDGET: TeamRunBudget = {
  max_calls: 12,
  max_concurrent_calls: 2,
  max_duration_seconds: 1_800,
}

interface RunNotifier {
  event?(sessionId: string, participantUserIds: number[], event: TeamEvent): void
}

function positiveInteger(value: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TeamRepositoryError('budget_exhausted', `${field} must be an integer between 1 and ${maximum}`)
  }
  return value
}

export function normalizeTeamRunBudget(value?: Partial<TeamRunBudget>): TeamRunBudget {
  const budget = { ...DEFAULT_TEAM_RUN_BUDGET, ...value }
  const normalized = {
    max_calls: positiveInteger(budget.max_calls, 100, 'max_calls'),
    max_concurrent_calls: positiveInteger(budget.max_concurrent_calls, 8, 'max_concurrent_calls'),
    max_duration_seconds: positiveInteger(budget.max_duration_seconds, 86_400, 'max_duration_seconds'),
  }
  if (normalized.max_concurrent_calls > normalized.max_calls) {
    throw new TeamRepositoryError('budget_exhausted', 'max_concurrent_calls cannot exceed max_calls')
  }
  return normalized
}

export class TeamRunService {
  private readonly repository: TeamRunRepository

  constructor(pool: pg.Pool, private readonly notifier: RunNotifier = {}) {
    this.repository = new TeamRunRepository(pool)
  }

  private publish(mutation: TeamRunMutation): TeamRun {
    this.notifier.event?.(mutation.run.team_session_id, mutation.participantUserIds, mutation.event)
    return mutation.run
  }

  async create(input: {
    sessionId: string
    actorUserId: number
    coordinatorOfferId: string
    contextVersion: number
    budget?: Partial<TeamRunBudget>
    requestId: string
  }): Promise<TeamRun> {
    return this.publish(await this.repository.create({
      sessionId: input.sessionId,
      actorUserId: input.actorUserId,
      coordinatorOfferId: input.coordinatorOfferId,
      contextVersion: input.contextVersion,
      budget: normalizeTeamRunBudget(input.budget),
      requestId: input.requestId,
    }))
  }

  list(sessionId: string, actorUserId: number): Promise<TeamRun[]> {
    return this.repository.list(sessionId, actorUserId)
  }

  get(runId: string, actorUserId: number): Promise<TeamRun> {
    return this.repository.get(runId, actorUserId)
  }

  async control(input: {
    runId: string
    actorUserId: number
    action: 'pause' | 'resume' | 'cancel'
    expectedRevision: number
    requestId: string
  }): Promise<TeamRun> {
    return this.publish(await this.repository.control(input))
  }

  async supplement(input: {
    runId: string
    actorUserId: number
    content: string
    expectedRevision: number
    requestId: string
  }): Promise<TeamRun> {
    return this.publish(await this.repository.supplement(input))
  }
}
