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
  installationId?: string
  ownerScopeKind?: 'personal' | 'team' | 'organization'
  ownerScopeId?: string
  conflictGroupId?: string | null
  conflictVariant?: number | null
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

export interface MemoryClaimSummary {
  claim_id: string
  claim_type: MemoryClaimType
  scope_kind: string
  scope_key: string
  state: 'active'
  revision: string
  current_version_id: string
  statement: string
  authority: string
  repository_id: string | null
  repo_snapshot_id: string | null
  branch: string | null
  freshness_at: string | null
  created_at: string
  updated_at: string
  version_created_at: string
}

export interface MemoryClaimList {
  claims: MemoryClaimSummary[]
  next_cursor: string | null
  total_count: number
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

// ---- Phase 2: context, policies, loadouts (plan sections 9-13) ----

export interface ContextSettings {
  settingId: string
  scopeKind: 'installation' | 'repository' | 'session'
  scopeKey: string
  agent: string | null
  mode: 'off' | 'shadow' | 'enabled'
  maxTokens: number | null
  revision: number
}

export interface ContextPackListEntry {
  pack_id: string
  state: string
  client_request_id: string
  created_at: string
  delivery: { state: string; outcome_code: string | null } | null
  mode: string
  agent: string
  stable_text: string
  dynamic_text: string
  stable_tokens: number
  dynamic_tokens: number
  error_code: string | null
  policy_revision: number
  settings_revision: number
  loadout_revision: number
  items: Array<{
    item_id: string
    claim_id: string
    version_id: string
    claim_type: string
    layer: string
    section: string
    representation: string
    reason_codes: string[]
    token_count: number
    ordinal: number
    evidence_ids: string[]
  }>
  trajectory: null | {
    result_state: string
    degraded_components: string[]
    candidates: Array<{
      version_id: string
      decision: string
      reason_code: string
      final_ordinal: number | null
    }>
  }
}

export interface PolicyVersionSummary {
	policy_version_id: string
	version_number: number
  document: Record<string, unknown>
  active: boolean
	head_revision: number
}

export interface EffectivePolicy {
  document: Record<string, unknown>
  policy_version_ids: string[]
  effective_policy_hash: string
}

export interface LoadoutItemSummary {
  itemId: string
  assetKind: string
  representation: string
  priority: number
  claimId: string | null
  status: 'resolved' | 'asset_unavailable' | 'claim_inactive'
  claimType: string | null
  versionId: string | null
}

export interface ContextFeedbackAction {
  injectionId?: string
  packId?: string
  itemId?: string
  action: 'used' | 'ignored' | 'incorrect' | 'harmful'
  reasonCode?: string
}

// --- ADR-0005 Phase 3 governance types ---

export interface MemoryGovernanceScope {
  installation_id: string
  owner_scope_kind: 'personal' | 'team' | 'organization'
  owner_scope_id: string
  authorization_epoch: string
  permissions: string[]
  state?: string
  revision?: number
  name?: string
  parent_organization_id?: string | null
}

export interface MemoryGovernanceQueueEntry {
  candidate: {
    candidate_id: string
    target_installation_id: string
    source_scope_kind: string
    normalized_key: string
    state: string
    conflict_group_id: string | null
    duplicate_of_claim_id: string | null
    expires_at: string
    revision: number
  }
  current_revision: { revision_number: number; statement: string } | null
  decisions: Array<{ decision: string; membership_id: string; created_at: string }>
  conflict_claims: Array<{ claim_id: string; statement: string; conflict_variant: number }>
}

export interface MemoryScopeMember {
  membership_id: string
  display_label: string
  roles: string[]
  state: string
  membership_revision: number
}

export interface MemoryReviewPolicyState {
  versions: Array<{
    policyVersionId: string
    versionNumber: number
    document: MemoryReviewPolicyDocument
    createdAt: string
  }>
  head: { activeVersionId: string; revision: number } | null
}

export interface MemoryReviewPolicyDocument {
  schema_version: 1
  minimum_approvals: number
  require_independent_reviewer: boolean
  require_publisher: boolean
  publisher_may_count_as_reviewer: boolean
  allow_self_publish: boolean
  candidate_ttl_days: number
  max_shared_evidence: number
  retention_days_after_revoke: number
  allow_parallel_conflicts: boolean
}
