import { createHash } from 'crypto'
import { z } from 'zod'
import { redactSecrets } from '../episodes/content-policy.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import { SkillCandidateDocumentSchema, skillDocumentHash, type SkillCandidateDocument } from './types.js'

/** A deterministic simulator for recorded data only; it never invokes a tool. */
export const SKILL_REPLAY_RUNNER_VERSION = 'skill-recorded-replay.v1'

const isIdentifier = (value: string) => {
  if (value.length === 0) return false
  const first = value.charCodeAt(0)
  if (!isAlphaNumeric(first)) return false
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (!isAlphaNumeric(code) && value[index] !== '.' && value[index] !== '_' && value[index] !== ':' && value[index] !== '-') return false
  }
  return true
}

const isAlphaNumeric = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
const isHex64 = (value: string) => value.length === 64 && [...value].every(character => {
  const code = character.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102)
})
const isUuid = (value: string) => {
  if (value.length !== 36) return false
  for (let index = 0; index < value.length; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (value[index] !== '-') return false
    } else if (!isHexCharacter(value[index]!)) return false
  }
  return true
}
const isHexCharacter = (character: string) => {
  const code = character.charCodeAt(0)
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
}
const MAX_JSON_DEPTH = 32
const isJsonValue = (value: unknown, depth = 0, seen = new WeakSet<object>()): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (depth >= MAX_JSON_DEPTH || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every(entry => isJsonValue(entry, depth + 1, seen))
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) return false
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) => key !== '__proto__' && key !== 'prototype' && key !== 'constructor' && isJsonValue(entry, depth + 1, seen))
}
const forbiddenPathPart = (part: string) => part === '__proto__' || part === 'prototype' || part === 'constructor'
const scalarExpected = z.union([z.string().max(2048), z.number().finite(), z.boolean(), z.null()])
const boundedText = (max: number) => z.string().min(1).max(max)

const replayStepSchema = z.object({
  step_index: z.number().int().min(0).max(31),
  tool: boundedText(128),
  operation: boundedText(128),
  instruction_hash: boundedText(64).refine(isHex64),
  response: z.unknown().refine(isJsonValue),
}).strict()
const replayAssertionSchema = z.object({
  assertion_id: boundedText(128).refine(isIdentifier),
  validation_index: z.number().int().min(0).max(15),
  validation_hash: boundedText(64).refine(isHex64),
  step_index: z.number().int().min(0).max(31),
  path: z.array(boundedText(128).refine(part => !forbiddenPathPart(part))).max(8),
  operator: z.enum(['equals', 'contains', 'exists']),
  expected: scalarExpected,
}).strict().superRefine((value, context) => {
  if (value.operator === 'exists' && typeof value.expected !== 'boolean') {
    context.addIssue({ code: 'custom', message: 'exists requires boolean expected' })
  }
})

export const ReplayCaseSchema = z.object({
  schema_version: z.literal('skill-replay-case.v1'),
  case_id: boundedText(128).refine(isIdentifier),
  kind: z.enum(['historical_session', 'golden_task']),
  provenance: z.enum(['fixture', 'recorded']),
  installation_id: boundedText(36).refine(isUuid),
  repository_id: boundedText(36).refine(isUuid),
  repo_snapshot_id: boundedText(36).refine(isUuid),
  version_id: boundedText(36).refine(isUuid),
  policy_hash: boundedText(64).refine(isHex64),
  document_hash: boundedText(64).refine(isHex64),
  reference_id: boundedText(200),
  steps: z.array(replayStepSchema).min(1).max(32),
  assertions: z.array(replayAssertionSchema).min(1).max(128),
}).strict().superRefine((value, context) => {
  if (new Set(value.steps.map(step => step.step_index)).size !== value.steps.length) context.addIssue({ code: 'custom', message: 'duplicate step index' })
  if (new Set(value.assertions.map(assertion => assertion.assertion_id)).size !== value.assertions.length) context.addIssue({ code: 'custom', message: 'duplicate assertion id' })
  // Do not serialize untrusted response objects until their bounded JSON shape
  // is accepted; a cycle must become a validation error, never a stack error.
  if (value.steps.every(step => isJsonValue(step.response)) && canonicalJsonString(value).length > 64_000) context.addIssue({ code: 'custom', message: 'case too large' })
})

export type ReplayCase = z.infer<typeof ReplayCaseSchema>

export interface ReplayRunnerInput {
  replayCase: ReplayCase
  document: SkillCandidateDocument
  installationId: string
  repositoryId: string
  repoSnapshotId: string
  versionId: string
  policyHash: string
}

export interface ReplayCaseResult {
  caseId: string
  kind: ReplayCase['kind']
  provenance: ReplayCase['provenance']
  referenceId: string
  inputHash: string
  documentHash: string
  runnerVersion: string
  state: 'passed' | 'failed'
  errorCode: 'ok' | 'assertion_failed' | 'step_mismatch' | 'validation_missing'
  assertions: Array<{ assertionId: string; passed: boolean; code: 'ok' | 'assertion_failed' }>
}

export class ReplayInputError extends Error {
  readonly name = 'ReplayInputError'
  constructor(readonly code: 'replay_aborted' | 'replay_case_invalid' | 'replay_binding_invalid') {
    super(code === 'replay_aborted' ? 'Recorded replay was aborted.' : code === 'replay_case_invalid' ? 'Recorded replay input is invalid.' : 'Recorded replay binding is invalid.')
  }
}

export function replayTextHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function replayCaseHash(replayCase: ReplayCase): string {
  return replayTextHash(canonicalJsonString(ReplayCaseSchema.parse(replayCase)))
}

const abortIfNeeded = (signal: AbortSignal) => {
  if (signal.aborted) throw new ReplayInputError('replay_aborted')
}

const resultFor = (replayCase: ReplayCase, documentHash: string): Omit<ReplayCaseResult, 'state' | 'errorCode' | 'assertions'> => ({
  caseId: replayCase.case_id,
  kind: replayCase.kind,
  provenance: replayCase.provenance,
  referenceId: replayCase.reference_id,
  inputHash: replayCaseHash(replayCase),
  documentHash,
  runnerVersion: SKILL_REPLAY_RUNNER_VERSION,
})

const ownPath = (response: unknown, path: readonly string[]): { found: boolean; value?: unknown } => {
  let value = response
  for (const part of path) {
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) return { found: false }
    value = (value as Record<string, unknown>)[part]
  }
  return { found: true, value }
}

const assertionPasses = (assertion: ReplayCase['assertions'][number], response: unknown): boolean => {
  const actual = ownPath(response, assertion.path)
  if (assertion.operator === 'exists') return actual.found === assertion.expected
  if (!actual.found) return false
  if (assertion.operator === 'equals') return Object.is(actual.value, assertion.expected)
  if (typeof actual.value === 'string' && typeof assertion.expected === 'string') return actual.value.includes(assertion.expected)
  return Array.isArray(actual.value) && actual.value.every(item => item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
    && actual.value.some(item => Object.is(item, assertion.expected))
}

/** Evaluate fixed assertions against exact recorded slots. No commands, tools, imports or instructions are executed. */
export async function runRecordedReplayCase(input: ReplayRunnerInput, signal: AbortSignal): Promise<ReplayCaseResult> {
  abortIfNeeded(signal)
  const parsedCase = ReplayCaseSchema.safeParse(input.replayCase)
  if (!parsedCase.success) throw new ReplayInputError('replay_case_invalid')
  const replayCase = parsedCase.data
  const documentResult = SkillCandidateDocumentSchema.safeParse(input.document)
  if (!documentResult.success || redactSecrets(canonicalJsonString(replayCase)) !== canonicalJsonString(replayCase)) throw new ReplayInputError('replay_case_invalid')
  const document = documentResult.data
  const documentHash = skillDocumentHash(document)
  if (replayCase.installation_id !== input.installationId
    || replayCase.repository_id !== input.repositoryId
    || replayCase.repo_snapshot_id !== input.repoSnapshotId
    || replayCase.version_id !== input.versionId
    || replayCase.policy_hash !== input.policyHash
    || replayCase.document_hash !== documentHash) throw new ReplayInputError('replay_binding_invalid')
  abortIfNeeded(signal)

  const base = resultFor(replayCase, documentHash)
  const slotsMatch = replayCase.steps.length === document.steps.length && document.steps.every((step, index) => {
    const slot = replayCase.steps.find(candidate => candidate.step_index === index)
    return slot !== undefined && slot.tool === step.tool && slot.operation === step.operation && slot.instruction_hash === replayTextHash(step.instruction)
  })
  if (!slotsMatch) return { ...base, state: 'failed', errorCode: 'step_mismatch', assertions: [] }

  const validationHashesMatch = replayCase.assertions.every(assertion => assertion.validation_index < document.validation.length
    && assertion.validation_hash === replayTextHash(document.validation[assertion.validation_index]!))
  const validationsCovered = document.validation.every((validation, index) => replayCase.assertions.some(assertion => assertion.validation_index === index && assertion.validation_hash === replayTextHash(validation)))
  const everyStepAsserted = document.steps.every((_step, index) => replayCase.assertions.some(assertion => assertion.step_index === index))
  const assertionSlotsValid = replayCase.assertions.every(assertion => assertion.validation_index < document.validation.length && assertion.step_index < document.steps.length)
  if (!validationHashesMatch || !validationsCovered || !everyStepAsserted || !assertionSlotsValid) return { ...base, state: 'failed', errorCode: 'validation_missing', assertions: [] }

  const assertions = replayCase.assertions.map(assertion => {
    const response = replayCase.steps.find(step => step.step_index === assertion.step_index)!.response
    const passed = assertionPasses(assertion, response)
    return { assertionId: assertion.assertion_id, passed, code: passed ? 'ok' as const : 'assertion_failed' as const }
  })
  abortIfNeeded(signal)
  return { ...base, assertions, state: assertions.every(assertion => assertion.passed) ? 'passed' : 'failed', errorCode: assertions.every(assertion => assertion.passed) ? 'ok' : 'assertion_failed' }
}

export type SkillReplayRunner = { version: string; run: typeof runRecordedReplayCase }
