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
import type {
  MemoryCandidate,
  MemoryClaimDetail,
  MemoryEvidence,
  MemoryFeatureSettings,
  MemoryInstallation,
  MemoryRecallBundle,
  MemorySearchResult,
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
  const memory = (body.installations ?? []).find(item => item.provider_id === 'pocketctl-memory')
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
}

/** Search; superseded calls are aborted so only the newest response lands. */
export async function searchMemory(
  query: string,
  options: { repositoryId?: string; branch?: string; claimTypes?: string[]; limit?: number } = {},
  signal?: AbortSignal,
): Promise<MemorySearchResult> {
  const searchId = ++state.latestSearchId
  const result = await memoryJson<MemorySearchResult>('memory.search', '/api/v1/memory/search', {
    method: 'POST',
    body: JSON.stringify({
      query,
      ...(options.repositoryId ? { repository_id: options.repositoryId } : {}),
      ...(options.branch ? { branch: options.branch } : {}),
      ...(options.claimTypes ? { claim_types: options.claimTypes } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    }),
    ...(signal ? { signal } : {}),
  })
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

export function getMemoryClaim(claimId: string, versionCursor?: string | null): Promise<MemoryClaimDetail> {
  const query = versionCursor ? `?version_cursor=${encodeURIComponent(versionCursor)}` : ''
  return memoryJson<MemoryClaimDetail>('memory.search', `/api/v1/memory/claims/${claimId}${query}`)
}

export function listVersionEvidence(versionId: string): Promise<MemoryEvidence[]> {
  const result = memoryJson<{ evidence: MemoryEvidence[] }>(
    'memory.search', `/api/v1/memory/versions/${versionId}/evidence`,
  )
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
