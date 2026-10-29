import { TeamRepositoryError } from './repository.js'

export interface TaskBudgetPolicy {
  max_concurrent_calls?: number
  max_duration_seconds?: number
  token_warning_limit?: number
}

export function validateTaskBudget(value: unknown): asserts value is TaskBudgetPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['max_concurrent_calls','max_duration_seconds','token_warning_limit'].includes(k))) throw new TeamRepositoryError('invalid_request', 'invalid task budget policy')
  const policy = value as TaskBudgetPolicy
  for (const [key, limit] of [['max_concurrent_calls',32],['max_duration_seconds',604800],['token_warning_limit',1_000_000_000_000]] as const) {
    if (policy[key] !== undefined && (!Number.isSafeInteger(policy[key]) || policy[key]! < 1 || policy[key]! > limit)) throw new TeamRepositoryError('invalid_request', 'invalid task budget limit')
  }
}

export function requireTaskBudgetCapacity(snapshot: { invocation_count: number; invocation_limit: number; in_flight: number; policy: TaskBudgetPolicy; duration_exhausted: boolean }): void {
  if (snapshot.invocation_count >= snapshot.invocation_limit) throw new TeamRepositoryError('budget_exhausted', 'plan invocation limit exhausted')
  if (snapshot.policy.max_concurrent_calls && snapshot.in_flight >= snapshot.policy.max_concurrent_calls) throw new TeamRepositoryError('budget_exhausted', 'plan concurrent reservation limit reached')
  if (snapshot.duration_exhausted) throw new TeamRepositoryError('budget_exhausted', 'plan duration limit reached; issued Calls are not stopped')
}
