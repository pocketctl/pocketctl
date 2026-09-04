/**
 * PocketCtl Memory provider client. Installation discovery and grant minting
 * go through the Relay with the user access token; every business call goes
 * DIRECTLY to the operator-configured provider origin with a short Capability
 * Grant. The grant and access token live in module memory only — nothing is
 * persisted to localStorage/sessionStorage — and an expired authorization
 * refreshes exactly once per call.
 */

import { useAuth } from '../composables/useAuth'
import { getRelayOrigin } from '../composables/useEnv'
import { createClientId } from '../utils/clientId'
import type {
  MemoryCandidate,
  MemoryClaimDetail,
  MemoryClaimList,
  MemoryEvidence,
  MemoryFeatureSettings,
  MemoryGovernanceQueueEntry,
  MemoryGovernanceScope,
  MemoryInstallation,
  MemoryReviewPolicyDocument,
  MemoryReviewPolicyState,
  MemoryScopeMember,
  MemoryRecallBundle,
  MemorySearchResult,
  MemoryActiveWiki,
  MemoryChangeImpact,
  MemoryCodeGraphPage,
  MemoryWikiBuildList,
  MemoryWikiCandidate,
  MintedGrant,
} from '../types/memory'

export class MemoryClientError extends Error {
  readonly status: number
  readonly code: string
  readonly currentRevision?: number
  readonly degradedComponents: string[]

  constructor(status: number, code: string, message: string, currentRevision?: number, degradedComponents: string[] = []) {
    super(message)
    this.name = 'MemoryClientError'
    this.status = status
    this.code = code
    this.currentRevision = currentRevision
    this.degradedComponents = degradedComponents
  }
}

interface MemoryClientState {
  installation?: MemoryInstallation
  grant?: { token: string; expiresAt: number; origin: string; services: string[] }
  /** In-flight search keyed by a monotonically increasing id. */
  latestSearchId: number
}

const state: MemoryClientState = { latestSearchId: 0 }

async function relayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { accessToken } = useAuth()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (accessToken.value) headers.set('Authorization', `Bearer ${accessToken.value}`)
  return fetch(`${getRelayOrigin()}${path}`, {
    ...init, headers: Object.fromEntries(headers.entries()), credentials: 'include', redirect: 'error',
  })
}

/** Discover the user's pocketctl-memory installation (undefined if absent). */
export async function discoverMemoryInstallation(): Promise<MemoryInstallation | null> {
  const response = await relayFetch('/api/extensions/v1/installations')
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'discovery_failed', 'installation discovery failed')
  }
  const body = await response.json() as { installations?: MemoryInstallation[] }
  // A user can hold an installation history (older revoked rows first); the
  // relay is the status authority, so prefer the active row for business use
  // and only fall back to the first row so paused/revoked states stay visible.
  const memoryRows = (body.installations ?? []).filter(item => item.provider_id === 'pocketctl-memory')
  const memory = memoryRows.find(item => item.status === 'active') ?? memoryRows[0]
  state.installation = memory ?? undefined
  return memory ?? null
}

/** Enable services explicitly (first-run opt-in); never auto-widens grants. */
export async function enableMemoryServices(
  installationId: string,
  expectedConfigVersion: number,
  services: string[],
): Promise<MemoryInstallation> {
  const response = await relayFetch(`/api/extensions/v1/installations/${installationId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      expected_config_version: expectedConfigVersion,
      enabled_services: services,
    }),
  })
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'enable_failed', 'enabling memory services failed')
  }
  const body = await response.json() as { installation: MemoryInstallation }
  const installation = body.installation
  state.installation = installation
  return installation
}

async function mintGrant(services: string[]): Promise<NonNullable<MemoryClientState['grant']>> {
  const installation = state.installation ?? await discoverMemoryInstallation()
  if (!installation) {
    throw new MemoryClientError(404, 'no_installation', 'PocketCtl Memory is not installed')
  }
  const response = await relayFetch('/api/extensions/v1/grants', {
    method: 'POST',
    body: JSON.stringify({
      installation_id: installation.installation_id,
      caller_type: 'web',
      services,
    }),
  })
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'grant_failed', 'memory grant minting failed')
  }
  const minted = await response.json() as MintedGrant
  if (!minted.provider_public_origin) {
    throw new MemoryClientError(503, 'no_provider_origin', 'provider origin is not configured')
  }
  state.grant = {
    token: minted.grant,
    expiresAt: Date.now() + minted.expires_in * 1000,
    origin: minted.provider_public_origin,
    services: [...services],
  }
  return state.grant
}

async function memoryFetch(
  service: string,
  path: string,
  init: RequestInit = {},
  allowRefresh = true,
): Promise<Response> {
  const cached = state.grant
  const grant = !cached || cached.expiresAt <= Date.now() + 5_000 || !cached.services.includes(service)
    ? await mintGrant([service])
    : cached
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${grant.token}`)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${grant.origin}${path}`, {
    ...init, headers: Object.fromEntries(headers.entries()), redirect: 'error',
  })
  if (response.status === 401 && allowRefresh) {
    if (state.grant?.token === grant.token) state.grant = undefined
    return memoryFetch(service, path, init, false)
  }
  return response
}

async function memoryJson<T>(
  service: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await memoryFetch(service, path, init)
  if (response.ok) return await response.json() as T
  const body = await response.json().catch(() => ({})) as {
    error?: { code?: string; message?: string; current_revision?: number }
  }
  throw new MemoryClientError(
    response.status,
    body.error?.code ?? `http_${response.status}`,
    body.error?.message ?? 'memory request failed',
    body.error?.current_revision,
  )
}

export function currentMemoryInstallation(): MemoryInstallation | null {
  return state.installation ?? null
}

export function resetMemoryClient(): void {
  state.installation = undefined
  state.grant = undefined
  v2Grant = null
}

/** Search; superseded calls are aborted so only the newest response lands. */
export async function searchMemory(
  query: string,
  options: {
    repositoryId?: string; branch?: string; claimTypes?: string[]; limit?: number
    scopeInstallationIds?: string[]
  } = {},
  signal?: AbortSignal,
): Promise<MemorySearchResult> {
  const searchId = ++state.latestSearchId
  const init = {
    method: 'POST',
    body: JSON.stringify({
      query,
      ...(options.repositoryId ? { repository_id: options.repositoryId } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.claimTypes ? { claim_types: options.claimTypes } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.scopeInstallationIds
        ? { scope_installation_ids: options.scopeInstallationIds }
        : {}),
    }),
    ...(signal ? { signal } : {}),
  }
  const result = options.scopeInstallationIds
    ? await governanceJson<MemorySearchResult>(
        '/api/v1/memory/search', options.scopeInstallationIds, init)
    : await memoryJson<MemorySearchResult>('memory.search', '/api/v1/memory/search', init)
  if (searchId !== state.latestSearchId) {
    throw new MemoryClientError(0, 'superseded', 'a newer search has started')
  }
  return result
}

export function recallMemory(query: string, maxClaims = 5): Promise<MemoryRecallBundle> {
  return memoryJson<MemoryRecallBundle>('memory.recall', '/api/v1/memory/recall', {
    method: 'POST', body: JSON.stringify({ query, max_claims: maxClaims }),
  })
}

export function listMemoryClaims(cursor?: string | null): Promise<MemoryClaimList> {
  const params = new URLSearchParams({ state: 'active', limit: '50' })
  if (cursor) params.set('cursor', cursor)
  return memoryJson<MemoryClaimList>('memory.search', `/api/v1/memory/claims?${params.toString()}`)
}

export function getMemoryClaim(
  claimId: string,
  versionCursor?: string | null,
  installationId?: string,
): Promise<MemoryClaimDetail> {
  const params = new URLSearchParams()
  if (versionCursor) params.set('version_cursor', versionCursor)
  if (installationId) params.set('installation_id', installationId)
  const query = params.size ? `?${params.toString()}` : ''
  return installationId
    ? governanceJson(`/api/v1/memory/claims/${claimId}${query}`, [installationId])
    : memoryJson<MemoryClaimDetail>('memory.search', `/api/v1/memory/claims/${claimId}${query}`)
}

export function listVersionEvidence(versionId: string, installationId?: string): Promise<MemoryEvidence[]> {
  const path = `/api/v1/memory/versions/${versionId}/evidence${installationId
    ? `?installation_id=${encodeURIComponent(installationId)}` : ''}`
  const result = installationId
    ? governanceJson<{ evidence: MemoryEvidence[] }>(path, [installationId])
    : memoryJson<{ evidence: MemoryEvidence[] }>('memory.search', path)
  return result.then(body => body.evidence)
}

export function getMemoryEvidence(evidenceId: string): Promise<MemoryEvidence> {
  return memoryJson<MemoryEvidence>('memory.search', `/api/v1/memory/evidence/${evidenceId}`)
}

export function listMemoryCandidates(): Promise<{ candidates: MemoryCandidate[] }> {
  return memoryJson<{ candidates: MemoryCandidate[] }>('memory.manage', '/api/v1/memory/candidates')
}

export function getMemorySettings(): Promise<MemoryFeatureSettings> {
  return memoryJson<MemoryFeatureSettings>('memory.manage', '/api/v1/memory/settings')
}

export function patchMemorySettings(
  expectedRevision: number,
  patch: {
    extraction_mode?: string
    embedding_mode?: string
    confirm_extraction_fingerprint?: string
    confirm_embedding_fingerprint?: string
  },
  idempotencyKey: string,
): Promise<MemoryFeatureSettings> {
  return memoryJson<MemoryFeatureSettings>('memory.manage', '/api/v1/memory/settings', {
    method: 'PATCH',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ expected_revision: expectedRevision, ...patch }),
  })
}

export function acceptMemoryCandidate(
  candidateId: string,
  expectedRevision: number,
  editedStatement: string | null,
  idempotencyKey: string,
): Promise<{ claim_id: string; version_id: string }> {
  return memoryJson('memory.manage', `/api/v1/memory/candidates/${candidateId}/accept`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({
      expected_revision: expectedRevision,
      ...(editedStatement ? { edited_statement: editedStatement } : {}),
    }),
  })
}

export function rejectMemoryCandidate(
  candidateId: string,
  expectedRevision: number,
  reasonCode: string | null,
  idempotencyKey: string,
): Promise<{ candidate_id: string }> {
  return memoryJson('memory.manage', `/api/v1/memory/candidates/${candidateId}/reject`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({
      expected_revision: expectedRevision,
      ...(reasonCode ? { reason_code: reasonCode } : {}),
    }),
  })
}

export function correctMemoryClaim(
  claimId: string,
  expectedRevision: number,
  statement: string,
  evidence: Array<{
    evidence_kind: 'event' | 'artifact' | 'episode'
    episode_id: string
    source_event_id?: string | null
    artifact_id?: string | null
    locator?: Record<string, unknown>
    excerpt: string
    occurred_at: string
  }>,
  idempotencyKey: string,
): Promise<{ version_id: string; version_number: number }> {
  return memoryJson('memory.manage', `/api/v1/memory/claims/${claimId}/correct`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({
      expected_revision: expectedRevision,
      statement,
      evidence: evidence.map(item => ({
        evidence_kind: item.evidence_kind,
        episode_id: item.episode_id,
        ...(item.evidence_kind === 'event' ? { source_event_id: item.source_event_id } : {}),
        ...(item.evidence_kind === 'artifact' ? { artifact_id: item.artifact_id } : {}),
        locator: item.locator ?? {},
        excerpt: item.excerpt,
        occurred_at: item.occurred_at,
      })),
    }),
  })
}

export function revokeMemoryClaim(
  claimId: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<{ claim_id: string; state: string }> {
  return memoryJson('memory.manage', `/api/v1/memory/claims/${claimId}/revoke`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ expected_revision: expectedRevision }),
  })
}

export function deleteMemoryClaim(
  claimId: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<{ claim_id: string; state: string }> {
  return memoryJson('memory.manage', `/api/v1/memory/claims/${claimId}`, {
    method: 'DELETE',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ expected_revision: expectedRevision }),
  })
}

export function sendMemoryFeedback(
  action: 'recall_used' | 'recall_incorrect' | 'recall_not_useful',
  requestId: string | null,
): Promise<{ recorded: boolean }> {
  return memoryJson('memory.manage', '/api/v1/memory/feedback', {
    method: 'POST',
    headers: { 'idempotency-key': `web-feedback-${requestId ?? 'anonymous'}-${action}-${Date.now()}` },
    body: JSON.stringify({ action, ...(requestId ? { request_id: requestId } : {}) }),
  })
}

// --- Phase 4 source graph and Living Wiki client surface ---

export function getMemoryCodeGraph(
  repositoryId: string,
  cursor?: string | null,
  limit = 50,
): Promise<MemoryCodeGraphPage> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor) query.set('cursor', cursor)
  return memoryJson(
    'memory.search',
    `/api/v1/memory/repositories/${encodeURIComponent(repositoryId)}/codegraph?${query.toString()}`,
  )
}

export function analyzeMemoryChangeImpact(
  repositoryId: string,
  input: {
    entry_paths: string[]
    depth?: number
    max_nodes?: number
    max_edges?: number
  },
): Promise<MemoryChangeImpact> {
  return memoryJson(
    'memory.search',
    `/api/v1/memory/repositories/${encodeURIComponent(repositoryId)}/impact`,
    { method: 'POST', body: JSON.stringify(input) },
  )
}

export function getMemoryWiki(repositoryId: string): Promise<MemoryActiveWiki> {
  return memoryJson(
    'memory.search',
    `/api/v1/memory/repositories/${encodeURIComponent(repositoryId)}/wiki`,
  )
}

export function listMemoryWikiBuilds(
  wikiId: string,
  cursor?: string | null,
  limit = 20,
): Promise<MemoryWikiBuildList> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor) query.set('cursor', cursor)
  return memoryJson(
    'memory.search',
    `/api/v1/memory/wikis/${encodeURIComponent(wikiId)}/builds?${query.toString()}`,
  )
}

export function getMemoryWikiCandidate(wikiId: string, buildId: string): Promise<MemoryWikiCandidate> {
  return memoryJson(
    'memory.search',
    `/api/v1/memory/wikis/${encodeURIComponent(wikiId)}/candidates/${encodeURIComponent(buildId)}`,
  )
}

export function scheduleMemoryWikiBuild(
  wikiId: string,
  expectedGeneration: number,
): Promise<{ run_id: string; generation: number }> {
  return memoryJson('memory.manage', `/api/v1/memory/wikis/${encodeURIComponent(wikiId)}/builds`, {
    method: 'POST', body: JSON.stringify({ expected_generation: expectedGeneration }),
  })
}

export function publishMemoryWikiCandidate(
  wikiId: string,
  buildId: string,
  expectedGeneration: number,
  expectedHeadRevision: number,
): Promise<{ wikiVersionId: string; revision: number }> {
  return memoryJson(
    'memory.manage',
    `/api/v1/memory/wikis/${encodeURIComponent(wikiId)}/candidates/${encodeURIComponent(buildId)}/publish`,
    {
      method: 'POST',
      body: JSON.stringify({
        expected_generation: expectedGeneration,
        expected_head_revision: expectedHeadRevision,
      }),
    },
  )
}

export function editMemoryWikiSection(
  wikiId: string,
  sectionKey: string,
  markdown: string,
  expectedLockVersion: number,
): Promise<{ manualVersionId: string; lockVersion: number }> {
  return memoryJson(
    'memory.manage',
    `/api/v1/memory/wikis/${encodeURIComponent(wikiId)}/manual-sections/${encodeURIComponent(sectionKey)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ markdown, expected_lock_version: expectedLockVersion }),
    },
  )
}

export function setMemoryWikiSectionLock(
  wikiId: string,
  sectionKey: string,
  action: 'lock' | 'unlock',
  expectedLockVersion: number,
): Promise<{ lockVersion: number }> {
  return memoryJson(
    'memory.manage',
    `/api/v1/memory/wikis/${encodeURIComponent(wikiId)}/manual-sections/${encodeURIComponent(sectionKey)}/${action}`,
    {
      method: 'POST',
      body: JSON.stringify({ expected_lock_version: expectedLockVersion }),
    },
  )
}

// ---- Phase 2 context management client (plan 10.3) ----

function phase2IdempotencyKey(operation: string): string {
  return `web-${operation}-${createClientId()}`
}

export async function listContextSettings(): Promise<{ settings: import('../types/memory.js').ContextSettings[] }> {
  return memoryJson('memory.manage', '/api/v1/memory/context/settings')
}

export async function putContextSetting(input: {
  scope_kind: 'installation' | 'repository' | 'session'
  scope_key: string
  agent?: string | null
  mode: 'off' | 'shadow' | 'enabled'
  max_tokens?: number | null
  expected_revision: number
}): Promise<{ revision: number }> {
  return memoryJson('memory.manage', '/api/v1/memory/context/settings', {
    method: 'PUT',
    headers: { 'idempotency-key': phase2IdempotencyKey('context-setting') },
    body: JSON.stringify(input),
  })
}

export async function listContextPacks(sessionId: string): Promise<{
  packs: import('../types/memory.js').ContextPackListEntry[]
}> {
  return memoryJson('memory.manage', `/api/v1/memory/context/packs?session_id=${encodeURIComponent(sessionId)}`)
}

export async function getContextLoadout(input: {
	repositoryId?: string | null
	agent?: string | null
} = {}): Promise<{ revision: number; items: import('../types/memory.js').LoadoutItemSummary[] }> {
	const query = new URLSearchParams()
	if (input.repositoryId) query.set('repository_id', input.repositoryId)
	if (input.agent) query.set('agent', input.agent)
	return memoryJson('memory.manage', `/api/v1/memory/context/loadouts?${query.toString()}`)
}

export async function replaceContextLoadout(input: {
	repository_id?: string | null
	agent?: string | null
	expected_revision: number
	items: Array<{
		item_id: string
		asset_kind: 'claim' | 'persona' | 'runbook' | 'wiki' | 'skill'
		claim_id?: string | null
		external_asset_ref?: string | null
		representation: 'summary' | 'on_demand' | 'reference'
		priority: number
	}>
}): Promise<{ revision: number }> {
	return memoryJson('memory.manage', '/api/v1/memory/context/loadouts', {
		method: 'PUT',
		headers: { 'idempotency-key': phase2IdempotencyKey('context-loadout') },
		body: JSON.stringify(input),
	})
}

export async function getEffectivePolicy(
  kind: 'extraction' | 'context' | 'ranking',
  repositoryId?: string | null,
): Promise<import('../types/memory.js').EffectivePolicy> {
  const query = repositoryId ? `?repository_id=${encodeURIComponent(repositoryId)}` : ''
  return memoryJson('memory.manage', `/api/v1/memory/policies/${kind}/effective${query}`)
}

export async function createPolicyVersion(input: {
  kind: 'extraction' | 'context' | 'ranking'
  layer: 'user' | 'repository'
  scope_key: string
  document: Record<string, unknown>
}): Promise<{ policy_version_id: string; version_number: number }> {
  const { kind, ...body } = input
  return memoryJson('memory.manage', `/api/v1/memory/policies/${kind}/versions`, {
    method: 'POST',
    headers: { 'idempotency-key': phase2IdempotencyKey('policy-version') },
    body: JSON.stringify(body),
  })
}

export async function listPolicyVersions(input: {
	kind: 'extraction' | 'context' | 'ranking'
	layer: 'user' | 'repository'
	scope_key: string
}): Promise<{ versions: import('../types/memory.js').PolicyVersionSummary[] }> {
	const query = new URLSearchParams({ layer: input.layer, scope_key: input.scope_key })
	return memoryJson('memory.manage', `/api/v1/memory/policies/${input.kind}/versions?${query.toString()}`)
}

export async function activatePolicy(input: {
  kind: 'extraction' | 'context' | 'ranking'
  policy_version_id: string
  expected_active_version_id: string
  expected_revision: number
  rollback?: boolean
}): Promise<void> {
  const action = input.rollback ? 'rollback' : 'activate'
  await memoryJson('memory.manage', `/api/v1/memory/policies/${input.kind}/${action}`, {
    method: 'POST',
    headers: { 'idempotency-key': phase2IdempotencyKey(`policy-${action}`) },
    body: JSON.stringify({
      policy_version_id: input.policy_version_id,
      expected_active_version_id: input.expected_active_version_id,
      expected_revision: input.expected_revision,
    }),
  })
}

export async function previewPolicyDiff(input: {
  kind: 'extraction' | 'context' | 'ranking'
  document: Record<string, unknown>
}): Promise<{ diff: Array<{ path: string; before: unknown; after: unknown }> }> {
  return memoryJson('memory.manage', `/api/v1/memory/policies/${input.kind}/diff`, {
		method: 'POST',
    body: JSON.stringify({ document: input.document }),
  })
}

export async function submitContextFeedback(input: import('../types/memory.js').ContextFeedbackAction): Promise<{ feedback_id: string }> {
  return memoryJson('memory.manage', '/api/v1/memory/context/feedback', {
    method: 'POST',
    headers: { 'idempotency-key': phase2IdempotencyKey('context-feedback') },
    body: JSON.stringify(input),
  })
}

// --- Phase 3 governance client surface ---

interface V2GrantState {
  token: string
  expiresAt: number
  installationIds: string[]
  origin: string
  services: string[]
}
let v2Grant: V2GrantState | null = null

async function mintV2Grant(installationIds: string[], services: string[] = []): Promise<V2GrantState> {
  if (v2Grant && v2Grant.expiresAt > Date.now() + 5_000
    && v2Grant.installationIds.join(',') === installationIds.join(',')
    && v2Grant.services.join(',') === services.join(',')) {
    return v2Grant
  }
  const response = await relayFetch('/api/extensions/v2/grants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      installation_ids: installationIds,
      caller_type: 'web',
      ...(services.length ? { services } : {}),
    }),
  })
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'feature_disabled', 'v2 grant mint failed')
  }
  const body = await response.json() as { grant: string; expires_in: number; provider_public_origin?: string }
  if (!body.provider_public_origin) {
    throw new MemoryClientError(503, 'no_provider_origin', 'provider origin is not configured')
  }
  v2Grant = {
    token: body.grant,
    expiresAt: Date.now() + body.expires_in * 1000,
    installationIds,
    services,
    origin: body.provider_public_origin,
  }
  return v2Grant
}

async function governanceFetch(
  path: string,
  installationIds: string[],
  init: RequestInit = {},
  services: string[] = [],
): Promise<Response> {
  const grant = await mintV2Grant(installationIds, services)
  return fetch(`${grant.origin}${path}`, {
    ...init,
    redirect: 'error',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${grant.token}`,
      ...(init.headers ?? {}),
    },
  })
}

async function governanceJson<T>(
  path: string,
  installationIds: string[],
  init: RequestInit = {},
  retry = true,
  services: string[] = [],
): Promise<T> {
  const response = await governanceFetch(path, installationIds, init, services)
  if (response.status === 401 && retry) {
    v2Grant = null
    return governanceJson(path, installationIds, init, false, services)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as {
      error?: { code?: string; message?: string; current_revision?: number }
    }
    throw new MemoryClientError(
      response.status,
      body.error?.code ?? 'governance_unavailable',
      body.error?.message ?? 'governance request failed',
      body.error?.current_revision,
    )
  }
  return response.json() as Promise<T>
}

/** Reuse the v2 scope-bound transport without widening the requested service. */
export function scopedMemoryJson<T>(
  installationId: string,
  service: 'memory.search' | 'memory.manage',
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return governanceJson<T>(path, [installationId], init, true, [service])
}

export async function listGovernanceScopes(): Promise<{ scopes: MemoryGovernanceScope[] }> {
  const response = await relayFetch('/api/extensions/v2/scopes')
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'governance_unavailable', 'governance scopes unavailable')
  }
  const body = await response.json() as {
    scopes: Array<{
      owner_scope_id: string
      owner_scope_kind: 'personal' | 'team' | 'organization'
      authorization_epoch: string | number
      permissions: string[]
      state: string
      revision: number
      name: string
      parent_organization_id: string | null
    }>
  }
  const installations = await relayFetch('/api/extensions/v2/installations')
  if (!installations.ok) {
    throw new MemoryClientError(installations.status, 'governance_unavailable', 'governance installations unavailable')
  }
  const installationBody = await installations.json() as {
    installations: Array<{
      installation_id: string
      owner_scope_kind: 'personal' | 'team' | 'organization'
      owner_scope_id: string
    }>
  }
  const installationByOwner = new Map(installationBody.installations.map(entry =>
    [`${entry.owner_scope_kind}:${entry.owner_scope_id}`, entry.installation_id]))
  return {
    scopes: (body.scopes ?? []).flatMap(entry => {
      const installationId = entry.owner_scope_kind === 'personal'
        ? entry.owner_scope_id
        : installationByOwner.get(`${entry.owner_scope_kind}:${entry.owner_scope_id}`)
      if (!installationId) return []
      return [{
      installation_id: installationId,
      owner_scope_kind: entry.owner_scope_kind,
      owner_scope_id: entry.owner_scope_id,
      authorization_epoch: String(entry.authorization_epoch),
      permissions: entry.permissions,
      state: entry.state,
      revision: entry.revision,
      name: entry.name,
      parent_organization_id: entry.parent_organization_id,
      }]
    }),
  }
}

export async function listScopeMembers(scope: MemoryGovernanceScope): Promise<{ members: MemoryScopeMember[] }> {
  const response = await relayFetch(
    `/api/extensions/v2/scopes/${scope.owner_scope_kind}/${encodeURIComponent(scope.owner_scope_id)}/members`)
  if (!response.ok) throw new MemoryClientError(response.status, 'members_unavailable', 'scope members unavailable')
  return response.json()
}

export async function updateScopeMember(input: {
  scope: MemoryGovernanceScope
  membershipId: string
  expectedRevision: number
  roles?: string[]
  state?: 'active' | 'suspended' | 'revoked'
}): Promise<void> {
  const response = await relayFetch(
    `/api/extensions/v2/scopes/${input.scope.owner_scope_kind}/${encodeURIComponent(input.scope.owner_scope_id)}/members/${encodeURIComponent(input.membershipId)}`,
    {
      method: 'PATCH',
      headers: { 'idempotency-key': phase2IdempotencyKey('scope-member') },
      body: JSON.stringify({
        expected_revision: input.expectedRevision,
        ...(input.roles ? { roles: input.roles } : {}),
        ...(input.state ? { state: input.state } : {}),
      }),
    })
  if (!response.ok) throw new MemoryClientError(response.status, 'member_update_failed', 'scope member update failed')
}

export async function updateScopeLifecycle(input: {
  scope: MemoryGovernanceScope
  state: 'suspended' | 'dissolving' | 'dissolved'
}): Promise<void> {
  const response = await relayFetch(
    `/api/extensions/v2/scopes/${input.scope.owner_scope_kind}/${encodeURIComponent(input.scope.owner_scope_id)}/lifecycle`,
    {
      method: 'POST',
      headers: { 'idempotency-key': phase2IdempotencyKey('scope-lifecycle') },
      body: JSON.stringify({ expected_revision: input.scope.revision, state: input.state }),
    })
  if (!response.ok) throw new MemoryClientError(response.status, 'lifecycle_failed', 'scope lifecycle update failed')
  v2Grant = null
}

export function startScopeTransfer(input: {
  sourceInstallationId: string
  targetInstallationId: string
  expectedRevision: number
}): Promise<unknown> {
  return governanceJson('/api/v1/memory/governance/transfers', [
    input.sourceInstallationId, input.targetInstallationId,
  ], {
    method: 'POST',
    headers: { 'idempotency-key': phase2IdempotencyKey('scope-transfer') },
    body: JSON.stringify({
      source_installation_id: input.sourceInstallationId,
      target_installation_id: input.targetInstallationId,
      expected_revision: input.expectedRevision,
    }),
  }, true, ['memory.manage'])
}

export function getReviewPolicy(targetInstallationId: string): Promise<MemoryReviewPolicyState> {
  return governanceJson(
    `/api/v1/memory/governance/review-policy?target_installation_id=${encodeURIComponent(targetInstallationId)}`,
    [targetInstallationId])
}

export function saveReviewPolicy(input: {
  targetInstallationId: string
  expectedRevision: number
  document: MemoryReviewPolicyDocument
}): Promise<unknown> {
  return governanceJson('/api/v1/memory/governance/review-policy', [input.targetInstallationId], {
    method: 'PATCH',
    headers: { 'idempotency-key': phase2IdempotencyKey('review-policy') },
    body: JSON.stringify({
      target_installation_id: input.targetInstallationId,
      expected_revision: input.expectedRevision,
      document: input.document,
    }),
  })
}

export async function listGovernanceQueue(targetInstallationId: string): Promise<{
  queue: MemoryGovernanceQueueEntry[]
}> {
  const response = await governanceFetch(
    `/api/v1/memory/governance/proposals?target_installation_id=${encodeURIComponent(targetInstallationId)}`,
    [targetInstallationId])
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'governance_unavailable', 'governance queue unavailable')
  }
  return response.json()
}

export async function proposeGovernanceClaim(input: {
  installationIds: string[]
  targetInstallationId: string
  expectedRevision: number
  sourceInstallationId: string
  sourceClaimId: string
  evidenceIds: string[]
}): Promise<{ candidate: { candidate_id: string } }> {
  const response = await governanceFetch('/api/v1/memory/governance/proposals', input.installationIds, {
    method: 'POST',
    headers: { 'idempotency-key': phase2IdempotencyKey('governance-propose') },
    body: JSON.stringify({
      target_installation_id: input.targetInstallationId,
      expected_revision: input.expectedRevision,
      source_installation_id: input.sourceInstallationId,
      source_claim_id: input.sourceClaimId,
      evidence_ids: input.evidenceIds,
    }),
  })
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'proposal_failed', 'proposal failed')
  }
  return response.json()
}

export async function decideGovernanceCandidate(input: {
  installationIds: string[]
  candidateId: string
  targetInstallationId: string
  expectedRevision: number
  decision: 'approve' | 'request_changes' | 'reject'
}): Promise<void> {
  const response = await governanceFetch(
    `/api/v1/memory/governance/proposals/${encodeURIComponent(input.candidateId)}/decisions`,
    input.installationIds, {
      method: 'POST',
      headers: { 'idempotency-key': phase2IdempotencyKey('governance-decision') },
      body: JSON.stringify({
        target_installation_id: input.targetInstallationId,
        expected_revision: input.expectedRevision,
        decision: input.decision,
      }),
    })
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'decision_failed', 'decision failed')
  }
}

export async function publishGovernanceCandidate(input: {
  installationIds: string[]
  candidateId: string
  targetInstallationId: string
  expectedRevision: number
  resolution: 'new' | 'parallel' | 'supersede'
  supersedeClaimIds?: string[]
}): Promise<void> {
  const response = await governanceFetch(
    `/api/v1/memory/governance/proposals/${encodeURIComponent(input.candidateId)}/publish`,
    input.installationIds, {
      method: 'POST',
      headers: { 'idempotency-key': phase2IdempotencyKey('governance-publish') },
      body: JSON.stringify({
        target_installation_id: input.targetInstallationId,
        expected_revision: input.expectedRevision,
        resolution: input.resolution,
        supersede_claim_ids: input.supersedeClaimIds,
      }),
    })
  if (!response.ok) {
    throw new MemoryClientError(response.status, 'publish_failed', 'publish failed')
  }
}
