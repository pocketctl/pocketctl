import { boundedText, positiveRevision, stableDigest, validateReviewPolicy, type TaskReviewPolicy } from './delivery-contract.js'
import { TeamRepositoryError } from './repository.js'

export const PLAN_LIMITS = Object.freeze({ steps: 32, revisions: 100, bytes: 128 * 1024 })
export interface TaskPlanStep {
  step_id: string
  title: string
  instruction: string
  acceptance: string
  required: boolean
  depends_on: string[]
  review_policy: TaskReviewPolicy
}
export interface TaskPlanInput {
  request_id: string
  expected_revision: number // zero creates the first revision
  team_session_id: string
  context_version: number
  spec_revision: number
  steps: TaskPlanStep[]
}

function invalid(message: string): never { throw new TeamRepositoryError('invalid_request', message) }
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('unexpected plan fields')
  return value as Record<string, unknown>
}

/** Returns a deterministic topological order. Edges always require acceptance;
 * optional means excluded from overall completion, not an optional input edge. */
export function validateTaskPlan(value: unknown): string[] {
  const plan = object(value, ['request_id', 'expected_revision', 'team_session_id', 'context_version', 'spec_revision', 'steps'])
  boundedText(plan.request_id, 'request_id', 128)
  boundedText(plan.team_session_id, 'team_session_id', 128)
  for (const name of ['expected_revision', 'context_version']) {
    if (!Number.isSafeInteger(plan[name]) || Number(plan[name]) < 0) invalid(`${name} must be a nonnegative integer`)
  }
  positiveRevision(plan.spec_revision)
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > PLAN_LIMITS.steps) invalid('plan requires 1-32 steps')
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > PLAN_LIMITS.bytes) invalid('plan byte limit exceeded')
  const steps = new Map<string, TaskPlanStep>()
  for (const raw of plan.steps) {
    const s = object(raw, ['step_id', 'title', 'instruction', 'acceptance', 'required', 'depends_on', 'review_policy'])
    if (typeof s.step_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.step_id) || steps.has(s.step_id)) invalid('step IDs must be unique safe identifiers')
    boundedText(s.title, 'step title', 120)
    boundedText(s.instruction, 'step instruction', 16000)
    boundedText(s.acceptance, 'step acceptance', 8000)
    if (typeof s.required !== 'boolean') invalid('required must be boolean')
    validateReviewPolicy(s.review_policy)
    if (!Array.isArray(s.depends_on) || s.depends_on.length > PLAN_LIMITS.steps || s.depends_on.some(id => typeof id !== 'string') || new Set(s.depends_on).size !== s.depends_on.length) invalid('dependencies must be unique step IDs')
    steps.set(s.step_id, raw as TaskPlanStep)
  }
  if (![...steps.values()].some(s => s.required)) invalid('at least one required step is needed')
  for (const step of steps.values()) for (const dependency of step.depends_on) {
    if (!steps.has(dependency) || dependency === step.step_id) invalid('dependency must refer to another step in this task plan')
  }
  const pending = new Set(steps.keys()), order: string[] = []
  while (pending.size) {
    const ready = [...pending].filter(id => steps.get(id)!.depends_on.every(parent => !pending.has(parent))).sort()
    if (!ready.length) invalid('plan contains a dependency cycle')
    for (const id of ready) { pending.delete(id); order.push(id) }
  }
  return order
}

export function stepDigest(step: TaskPlanStep): string {
  return stableDigest({ ...step, depends_on: [...step.depends_on].sort(),
    review_policy: { ...step.review_policy, required_checks: [...step.review_policy.required_checks].sort() } })
}

/** Every reserved attempt already has frozen input. A failed/unknown attempt
 * counts as started too; its definition must survive subsequent plan edits. */
export function requireUnchangedStartedSteps(steps: TaskPlanStep[], started: { step_id: string; definition: TaskPlanStep }[]): void {
  const next = new Map(steps.map(step => [step.step_id, stepDigest(step)]))
  for (const step of started) {
    if (next.get(step.step_id) !== stepDigest(step.definition)) throw new TeamRepositoryError('invalid_state', 'a started step cannot be changed or removed')
  }
}
