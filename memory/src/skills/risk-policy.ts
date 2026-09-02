import { redactSecrets } from '../episodes/content-policy.js'
import { canonicalJsonString } from '../inbox/canonical-json.js'
import {
  SkillCandidateDocumentSchema, SKILL_HIGH_RISK_OPERATIONS, SKILL_MAX_CANDIDATE_CHARS,
  skillDocumentHash, type SkillCandidateDocument,
} from './types.js'

export type SkillRisk = 'low' | 'high' | 'unknown'
// These are structured read tools, not shell command prefixes. Arbitrary
// commands (even ones labelled "read") can never enter this allowlist.
const READ_TOOLS = new Set(['read_file', 'search', 'list_files'])
const HIGH_RISK_TEXT = /部署|删除|生产写入|权限变更|修改权限|数据迁移|\b(?:deploy|deployment|delete|remove|migration|migrate|sudo|chmod|chown|truncate)\b|\brm\s|\bdrop\s+(?:table|database|schema)\b|\bproduction[:_ -]+write\b|\bpermission[:_ -]+(?:change|write|grant)\b/iu

/** Static classification is conservative; it is not a shell security sandbox. */
export function assessSkillRisk(input: SkillCandidateDocument): {
  risk: SkillRisk; secretDetected: boolean
} {
  const document = SkillCandidateDocumentSchema.parse(input)
  const serialized = canonicalJsonString(document)
  const secretDetected = redactSecrets(serialized) !== serialized
  const high = HIGH_RISK_TEXT.test(serialized)
    || document.steps.some(step => (SKILL_HIGH_RISK_OPERATIONS as readonly string[]).includes(step.operation))
  const knownRead = document.steps.every(step => step.operation === 'read'
    && READ_TOOLS.has(step.tool) && step.permissions.every(permission => permission === 'repository:read'))
  return { risk: high ? 'high' : knownRead ? 'low' : 'unknown', secretDetected }
}

export interface SkillPublicationFacts {
  /** All facts come from ledger/replay queries, never from request/model JSON. */
  contentHash: string
  conflictingClaims: boolean
  successes: Array<{ episodeId: string; sessionId: string; contentHash: string; verified: boolean }>
  deterministicValidation: { contentHash: string; passed: boolean }
  replays: Array<{ kind: 'historical_session' | 'golden_task'; contentHash: string; passed: boolean }>
  rollbackVerified: boolean
}

export type SkillPublicationDenial =
  | 'invalid_document' | 'content_version_mismatch' | 'secret_detected' | 'risk_requires_review'
  | 'independent_successes_missing' | 'claim_conflict' | 'deterministic_validation_missing'
  | 'replay_missing_or_failed' | 'rollback_missing'

/** Eligibility only: no mode, grant, publisher, state mutation or tool call. */
export function evaluateAutoPublication(input: SkillCandidateDocument, facts: SkillPublicationFacts): {
  eligible: boolean; reasons: SkillPublicationDenial[]; risk: SkillRisk
} {
  const parsed = SkillCandidateDocumentSchema.safeParse(input)
  if (!parsed.success || canonicalJsonString(parsed.data).length > SKILL_MAX_CANDIDATE_CHARS) {
    return { eligible: false, reasons: ['invalid_document'], risk: 'unknown' }
  }
  const document = parsed.data
  const risk = assessSkillRisk(document)
  const reasons: SkillPublicationDenial[] = []
  if (skillDocumentHash(document) !== facts.contentHash) reasons.push('content_version_mismatch')
  if (risk.secretDetected) reasons.push('secret_detected')
  if (risk.risk !== 'low') reasons.push('risk_requires_review')
  const successes = facts.successes.filter(fact => fact.verified && fact.contentHash === facts.contentHash
    && fact.episodeId.length > 0 && fact.sessionId.length > 0)
  if (new Set(successes.map(row => row.sessionId)).size < 2
    || new Set(successes.map(row => row.episodeId)).size < 2) reasons.push('independent_successes_missing')
  if (facts.conflictingClaims) reasons.push('claim_conflict')
  if (!facts.deterministicValidation.passed || facts.deterministicValidation.contentHash !== facts.contentHash) {
    reasons.push('deterministic_validation_missing')
  }
  if (!['historical_session', 'golden_task'].every(kind => facts.replays.some(replay => replay.kind === kind))
    || facts.replays.some(replay => !replay.passed || replay.contentHash !== facts.contentHash)) {
    reasons.push('replay_missing_or_failed')
  }
  if (!facts.rollbackVerified) reasons.push('rollback_missing')
  return { eligible: reasons.length === 0, reasons, risk: risk.risk }
}
