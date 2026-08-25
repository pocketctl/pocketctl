/** Phase 1 Memory domain types mirrored from the provider REST contract. */

export interface MemoryInstallation {
  installation_id: string
  provider_id: string
  status: 'pending' | 'active' | 'paused' | 'revoking' | 'revoked'
  granted_scopes: string[]
  subscriptions: string[]
  enabled_services: string[]
  config_version: string
}

export interface MintedGrant {
  grant: string
  expires_in: number
  token_type: 'extension_capability'
  provider_public_origin?: string
}

export type MemoryClaimType =
  | 'architecture_decision' | 'repository_convention' | 'bug_root_cause'
  | 'rejected_hypothesis' | 'test_invariant' | 'implementation_map'
  | 'operational_runbook' | 'work_method' | 'reusable_skill_candidate'

export interface MemorySearchHit {
  versionId: string
  claimId: string
  claimType: MemoryClaimType
  statement: string
  scopeKind: string
  scopeKey: string
  freshnessAt: string | null
  authority: string
  repositoryId: string | null
  branch: string | null
  score: number
  sources: string[]
}

export interface MemorySearchResult {
  hits: MemorySearchHit[]
  nextCursor: string | null
  degradedComponents: string[]
  poolSizes: Record<string, number>
  shadowComparison?: { topK: number; overlapCount: number }
}

export interface MemoryRecallEvidence {
  evidenceId: string
  evidenceKind: string
  episodeId: string
  excerpt: string
  occurredAt: string
  truncated: boolean
}

export interface MemoryRecallClaim {
  claimId: string
  versionId: string
  claimType: MemoryClaimType
  statement: string
  scopeKind: string
  scopeKey: string
  freshnessAt: string | null
  authority: string
  evidence: MemoryRecallEvidence[]
}

export interface MemoryRecallBundle {
  requestId: string
  degradedComponents: string[]
  claims: MemoryRecallClaim[]
  conflicts: Array<{ claimId: string; claimType: string; statementExcerpt: string }>
  relatedEpisodes: Array<{
    episodeId: string; sessionId: string; turnId: string
    outcome: string | null; terminalAt: string | null
  }>
  coverageGaps: string[]
  totalChars: number
}

export interface MemoryCandidate {
  candidate_id: string
  claim_type: MemoryClaimType
  statement: string
  structured_content?: Record<string, string | number | boolean | null | string[]>
  scope_kind: string
  scope_key: string
  repository_id: string | null
  repo_snapshot_id: string | null
  branch: string | null
  evidence: Array<{ handle: string; excerpt: string }>
  confidence: string
  freshness_at: string
  status: string
  revision: string
  episode_id: string
  duplicate_of_claim_id: string | null
  created_at: string
}

export interface MemoryClaimDetail {
  claim: {
    claim_id: string
    claim_type: MemoryClaimType
    scope_kind: string
    scope_key: string
    state: 'active' | 'superseded' | 'expired' | 'revoked'
    revision: string
    current_version_id: string | null
  }
  versions: Array<{
    version_id: string
    version_number: string
    statement: string
    structured_content?: Record<string, string | number | boolean | null | string[]>
    authority: string
    confidence: string
    repository_id: string | null
    repo_snapshot_id: string | null
    branch: string | null
    freshness_at: string | null
    created_at: string
  }>
  next_version_cursor: string | null
}

/** Wire shape of the provider's version-evidence listing (snake_case). */
export interface MemoryEvidenceRow {
  evidence_id: string
  evidence_kind: string
  episode_id: string
  excerpt: string
  truncated: boolean
  occurred_at: string
  locator?: Record<string, unknown>
  source_event_id?: string | null
  artifact_id?: string | null
}

export interface MemoryEvidence extends MemoryEvidenceRow {
  claim_id?: string
  version_id?: string
}

export interface MemoryFeatureSettings {
  extraction_mode: 'off' | 'shadow' | 'enabled'
  embedding_mode: 'off' | 'shadow' | 'enabled'
  revision: number
  extraction_ready?: boolean
  embedding_ready?: boolean
  extraction_adapter?: MemoryModelDisclosure | null
  embedding_adapter?: MemoryModelDisclosure | null
  extraction_consent_required?: boolean
  embedding_consent_required?: boolean
}

export interface MemoryModelDisclosure {
  provider: string
  origin: string
  model: string
  fingerprint: string
  pricing_configured: boolean
}
