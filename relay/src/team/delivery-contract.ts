import { createHash } from 'node:crypto'
import { TeamRepositoryError } from './repository.js'

export const DELIVERY_LIMITS = Object.freeze({ artifacts: 16, artifactBytes: 2 * 1024 * 1024, taskBytes: 32 * 1024 * 1024, submissions: 100, checks: 32 })
export interface TaskReviewPolicy { reviewer_user_id: number; primary_offer_id: string; required_checks: string[] }
export interface ArtifactManifest { id: string; name: string; mime_type: string; byte_size: number; sha256: string; required: boolean }
export interface SubmissionEvidence { check_id: string; result: 'passed' | 'failed' | 'unverified'; artifact_id: string; code_revision: string | null; source_kind: 'agent_claim' }
export interface PrepareSubmission {
  request_id: string
  expected_revision: number
  spec_revision: number
  source_call_id: string
  summary: string
  code_revision: string | null
  artifacts: ArtifactManifest[]
  evidence: SubmissionEvidence[]
  contribution_ids: string[]
  publish_scope: 'team'
}
export interface DeliveryMutation { request_id: string; expected_revision: number }
export interface AcceptanceInput extends DeliveryMutation {
  submission_id: string
  spec_revision: number
  decision: 'accepted' | 'changes_requested'
  reason: string
  verified_checks: string[]
}
export function deliveryInvalid(message: string): never { throw new TeamRepositoryError('invalid_request', message) }
export function boundedText(value: unknown, name: string, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) deliveryInvalid(`${name} is invalid`)
}
export function positiveRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) deliveryInvalid('revision must be a positive integer')
}
function stringList(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > DELIVERY_LIMITS.checks) deliveryInvalid(`${name} is invalid`)
  for (const item of value) boundedText(item, name, 120)
  if (new Set(value).size !== value.length) deliveryInvalid(`${name} must be unique`)
}
export function validateReviewPolicy(value: unknown): asserts value is TaskReviewPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deliveryInvalid('review policy required')
  const policy = value as TaskReviewPolicy
  if (Object.keys(policy).some(key => !['reviewer_user_id', 'primary_offer_id', 'required_checks'].includes(key))) deliveryInvalid('unexpected review policy field')
  boundedText(policy.primary_offer_id, 'primary_offer_id', 128)
  positiveRevision(policy.reviewer_user_id)
  stringList(policy.required_checks, 'required_checks')
}
export function validateMutation(value: DeliveryMutation): void {
  boundedText(value.request_id, 'request_id', 128)
  positiveRevision(value.expected_revision)
}
export function validateSubmission(value: PrepareSubmission): void {
  validateMutation(value)
  positiveRevision(value.spec_revision)
  boundedText(value.source_call_id, 'source_call_id', 128)
  boundedText(value.summary, 'summary', 16_000)
  if (value.code_revision !== null) boundedText(value.code_revision, 'code_revision', 200)
  if (value.publish_scope !== 'team') deliveryInvalid('explicit team publication scope required')
  if (!Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > DELIVERY_LIMITS.artifacts) deliveryInvalid('1-16 artifacts required')
  stringList(value.contribution_ids, 'contribution_ids')
  if (value.contribution_ids.some(id => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) deliveryInvalid('invalid contribution ID')
  const ids = new Set<string>()
  for (const artifact of value.artifacts) {
    if (!artifact || typeof artifact !== 'object') deliveryInvalid('invalid artifact')
    if (typeof artifact.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(artifact.id) || ids.has(artifact.id)) deliveryInvalid('artifact IDs must be unique safe identifiers')
    ids.add(artifact.id)
    boundedText(artifact.name, 'artifact name', 240)
    if (/[\/\\\r\n]/.test(artifact.name) || artifact.name === '.' || artifact.name === '..') deliveryInvalid('artifact name must not contain a path')
    if (!['text/plain', 'text/markdown', 'text/html', 'text/x-diff', 'application/json', 'application/pdf'].includes(artifact.mime_type)) deliveryInvalid('unsupported artifact type')
    if (!Number.isSafeInteger(artifact.byte_size) || artifact.byte_size < 1 || artifact.byte_size > DELIVERY_LIMITS.artifactBytes) deliveryInvalid('artifact byte limit exceeded')
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) || typeof artifact.required !== 'boolean') deliveryInvalid('artifact hash or required flag invalid')
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > DELIVERY_LIMITS.checks) deliveryInvalid('invalid evidence list')
  const checks = new Set<string>()
  for (const evidence of value.evidence) {
    if (!evidence || typeof evidence !== 'object') deliveryInvalid('invalid evidence')
    boundedText(evidence.check_id, 'check_id', 120)
    if (checks.has(evidence.check_id) || !ids.has(evidence.artifact_id)) deliveryInvalid('duplicate check or unknown evidence artifact')
    checks.add(evidence.check_id)
    if (!['passed', 'failed', 'unverified'].includes(evidence.result) || evidence.source_kind !== 'agent_claim') deliveryInvalid('trusted evidence cannot be supplied by this endpoint')
    if (evidence.code_revision !== value.code_revision) deliveryInvalid('evidence code version mismatch')
  }
}
export function validateAcceptance(value: AcceptanceInput): void {
  validateMutation(value)
  boundedText(value.submission_id, 'submission_id', 128)
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value.submission_id)) deliveryInvalid('invalid submission ID')
  positiveRevision(value.spec_revision)
  if (!['accepted', 'changes_requested'].includes(value.decision)) deliveryInvalid('invalid acceptance decision')
  boundedText(value.reason, 'reason', 8000, value.decision === 'accepted')
  stringList(value.verified_checks, 'verified_checks')
}
export function stableJSON(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : item
  return JSON.stringify(canonical(value))
}
export function stableDigest(value: unknown): string { return createHash('sha256').update(stableJSON(value)).digest('hex') }
export function artifactDigest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
