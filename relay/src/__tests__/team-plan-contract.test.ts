import { validateTaskBudget } from '../team/budget-service.js'
import { describe, expect, test } from 'vitest'
import { PLAN_LIMITS, requireUnchangedStartedSteps, stepDigest, validateTaskPlan, type TaskPlanInput, type TaskPlanStep } from '../team/plan-contract.js'
import { resolveTeamCollaborationConfig, teamPlanDraftEnabled, teamCapabilitySnapshot } from '../team/config.js'
import { requireBoundedStepInputs, STEP_INPUT_LIMITS } from '../team/step-input-service.js'
import { stableDigest, stableJSON } from '../team/delivery-contract.js'
import type { FrozenPlanInput } from '../team/plan-inputs.js'

const step = (id: string, dependencies: string[] = []): TaskPlanStep => ({ step_id: id, title: id, instruction: 'Implement a bounded change', acceptance: 'Independent review', required: true, depends_on: dependencies,
  review_policy: { reviewer_user_id: 2, primary_offer_id: 'offer', required_checks: ['unit'] } })
const plan = (): TaskPlanInput => ({ request_id: 'save', expected_revision: 0, team_session_id: 'session', context_version: 0, spec_revision: 1,
  steps: [step('join', ['left', 'right']), step('right', ['root']), step('root'), step('left', ['root'])] })

describe('task plan contract', () => {
  test('large Unicode input snapshot fits the separate wire envelope and rejects excess file/byte budgets', () => {
    const inputs: FrozenPlanInput[]=Array.from({length:8},(_,i)=>({step_id:`step-${i}`,attempt_id:'a1234567-1234-4234-8234-123456789abc',submission_id:'b1234567-1234-4234-8234-123456789abc',
      plan_revision:1,source_call_id:`call-${i}`,submission_version:1,spec_revision:1,context_version:0,context_hash:null,decision_id:'decision',reviewer_user_id:2,verified_checks:[],code_revision:null,manifest_sha256:'a'.repeat(64),evidence_sha256:stableDigest([]),evidence:[],
      artifacts:Array.from({length:16},(_,j)=>({id:`file-${j}`,name:'字'.repeat(200),mime_type:'text/plain',byte_size:512*1024,sha256:'b'.repeat(64),required:true}))}))
    expect(()=>requireBoundedStepInputs(inputs)).not.toThrow()
    const canonical=stableJSON(inputs), wire=JSON.stringify({schema_version:1,call_id:'call',task_id:'task',attempt_id:'a1234567-1234-4234-8234-123456789abc',spec_revision:1,input_hash:stableDigest(inputs),inputs,inputs_json:canonical})
    expect(Buffer.byteLength(canonical)).toBeGreaterThan(90*1024)
    expect(Buffer.byteLength(canonical)).toBeLessThanOrEqual(STEP_INPUT_LIMITS.canonicalBytes)
    expect(Buffer.byteLength(wire)).toBeGreaterThan(STEP_INPUT_LIMITS.canonicalBytes)
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(STEP_INPUT_LIMITS.wireBytes)
    inputs[0].artifacts[0].byte_size++
    expect(()=>requireBoundedStepInputs(inputs)).toThrow('materialization limit')
    inputs[0].artifacts[0].byte_size--
    inputs[0].artifacts.push({...inputs[0].artifacts[0],byte_size:1})
    expect(()=>requireBoundedStepInputs(inputs)).toThrow('materialization limit')
  })
  test('orders a diamond while retaining both join prerequisites', () => {
    const input = plan(), before = structuredClone(input)
    expect(validateTaskPlan(input)).toEqual(['root', 'left', 'right', 'join'])
    expect(input).toEqual(before)
  })
  test.each([
    ['cycle', (p: TaskPlanInput) => { p.steps[2].depends_on = ['join'] }],
    ['self edge', (p: TaskPlanInput) => { p.steps[2].depends_on = ['root'] }],
    ['unknown step / other task', (p: TaskPlanInput) => { p.steps[0].depends_on = ['other:step'] }],
    ['duplicate step', (p: TaskPlanInput) => { p.steps.push(p.steps[0]) }],
    ['duplicate edge', (p: TaskPlanInput) => { p.steps[0].depends_on = ['left', 'left'] }],
    ['empty', (p: TaskPlanInput) => { p.steps = [] }],
    ['unbounded graph', (p: TaskPlanInput) => { p.steps = Array.from({ length: PLAN_LIMITS.steps + 1 }, (_, i) => step(`s${i}`)) }],
    ['no required step', (p: TaskPlanInput) => { p.steps.forEach(s => { s.required = false }) }],
    ['extra task ID', (p: TaskPlanInput) => { Object.assign(p.steps[0], { task_id: 'other' }) }],
    ['negative context', (p: TaskPlanInput) => { p.context_version = -1 }],
    ['fractional revision', (p: TaskPlanInput) => { p.expected_revision = .5 }],
    ['invalid policy', (p: TaskPlanInput) => { p.steps[0].review_policy.reviewer_user_id = 0 }],
    ['byte limit', (p: TaskPlanInput) => { p.steps = Array.from({ length: 32 }, (_, i) => ({ ...step(`s${i}`), instruction: '字'.repeat(16000) })) }],
  ])('rejects %s', (_name, mutate) => {
    const input = plan(); mutate(input)
    expect(() => validateTaskPlan(input)).toThrow()
  })
  test.each([null, [], {}, { steps: [null] }])('rejects malformed input %j', input => expect(() => validateTaskPlan(input)).toThrow())
  test('started definition cannot disappear, change policy or acquire new dependencies', () => {
    const input = plan(), old = structuredClone(input.steps[0])
    const started = [{ step_id: old.step_id, definition: old }]
    expect(() => requireUnchangedStartedSteps(input.steps, started)).not.toThrow()
    expect(() => requireUnchangedStartedSteps(input.steps.slice(1), started)).toThrow('started step')
    input.steps[0].review_policy.reviewer_user_id = 3
    expect(() => requireUnchangedStartedSteps(input.steps, started)).toThrow('started step')
    input.steps[0] = { ...old, depends_on: ['root'] }
    expect(() => requireUnchangedStartedSteps(input.steps, started)).toThrow('started step')
  })
  test('canonical step digest ignores edge/check ordering, but not content', () => {
    const a = plan().steps[0], b = structuredClone(a)
    b.depends_on.reverse()
    expect(stepDigest(a)).toBe(stepDigest(b))
    b.instruction += ' Changed'
    expect(stepDigest(a)).not.toBe(stepDigest(b))
  })
  test('draft capability is independent, off by default, and requires the P0 allowlist', () => {
    expect(teamPlanDraftEnabled(resolveTeamCollaborationConfig({}), 't')).toBe(false)
    expect(() => resolveTeamCollaborationConfig({ TEAM_TASK_PLAN_DRAFT_V1: 'on' })).toThrow('requires TEAM_TASK_DELIVERY')
    expect(() => resolveTeamCollaborationConfig({ TEAM_TASK_PLAN_DRAFT_V1: 'true' })).toThrow('must be')
    const config = resolveTeamCollaborationConfig({ TEAM_COLLABORATION: 'on', TEAM_TASK_DELIVERY_V1: 'on', TEAM_TASK_DELIVERY_TEAMS: 't', TEAM_TASK_PLAN_DRAFT_V1: 'on' })
    expect(teamPlanDraftEnabled(config, 't')).toBe(true)
    expect(teamPlanDraftEnabled(config, 'other')).toBe(false)
    expect(teamCapabilitySnapshot(config, { memoryExtensionAvailable: false })).toMatchObject({ task_plan_draft_v1: true, autorun: false })
  })
})


describe('task plan budget policy', () => {
  test('accepts only bounded explicit policies and rejects unsupported hard token limits', () => {
    expect(()=>validateTaskBudget({max_concurrent_calls:32,max_duration_seconds:604800,token_warning_limit:1000000})).not.toThrow()
    for(const value of [null,[],{max_concurrent_calls:0},{max_concurrent_calls:33},{max_duration_seconds:604801},{token_warning_limit:1.5},{max_tokens:1000},{max_rounds:2}]) expect(()=>validateTaskBudget(value)).toThrow()
  })
})
