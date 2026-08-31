import { createHash, createHmac, timingSafeEqual } from 'crypto'
import type pg from 'pg'

import type { ValidatedV2Grant } from '../governance/authorization.js'
import type { VerifiedMemoryGrant } from '../auth/grant-guard.js'
import type { RecallClaim, RecallResult } from './recall-service.js'

/**
 * ADR-0005 §6.4 cross-scope retrieval. Authorization precedes retrieval:
 * every selected installation must appear as a validated v2 grant binding
 * (the underlying per-installation SQL is already installation-fenced, so no
 * cross-tenant candidate pool can ever form). Default selection is the
 * primary personal installation only; Web/MCP must explicitly select shared
 * scopes. Results merge per-scope with deterministic RRF tie-breaking and
 * carry owner-scope and conflict metadata on every item.
 */

export type FederatedScopeError =
  | 'too_many_scopes'
  | 'unauthorized_scope'
  | 'duplicate_scope'
  | 'shared_scope_not_enabled'
  | 'invalid_cursor'

export class FederatedScopeSelectionError extends Error {
  readonly code: FederatedScopeError
  constructor(code: FederatedScopeError, message: string) {
    super(message)
    this.name = 'FederatedScopeSelectionError'
    this.code = code
  }
}

export interface SelectedScope {
  installationId: string
  ownerScopeKind: 'personal' | 'team' | 'organization'
  ownerScopeId: string
  authorizationEpoch: string
}

export const MAX_FEDERATED_SCOPES = 16
export const MAX_FEDERATED_OFFSET = 100

export function selectFederatedScopes(input: {
  grant: ValidatedV2Grant
  requestedInstallationIds?: readonly string[] | null
  sharedScopesEnabled: boolean
}): SelectedScope[] {
  const requested = input.requestedInstallationIds ?? null
  if (requested === null) {
    // Default scope selection is personal-only: the primary installation
    // when it is personal, otherwise nothing federates implicitly.
    const primary = input.grant.scopeBindings.find(
      binding => binding.installation_id === input.grant.primaryInstallationId)
    if (!primary || primary.owner_scope_kind !== 'personal') return []
    return [{
      installationId: primary.installation_id,
      ownerScopeKind: 'personal',
      ownerScopeId: primary.owner_scope_id,
      authorizationEpoch: primary.authorization_epoch,
    }]
  }
  if (requested.length === 0) {
    throw new FederatedScopeSelectionError('unauthorized_scope',
      'scope_installation_ids must name at least one installation')
  }
  if (requested.length > MAX_FEDERATED_SCOPES) {
    throw new FederatedScopeSelectionError('too_many_scopes',
      'scope_installation_ids is limited to 16 installations')
  }
  if (new Set(requested).size !== requested.length) {
    throw new FederatedScopeSelectionError('duplicate_scope',
      'scope_installation_ids must be unique')
  }
  const byInstallation = new Map(input.grant.scopeBindings.map(
    binding => [binding.installation_id, binding]))
  const selected: SelectedScope[] = []
  for (const installationId of requested) {
    const binding = byInstallation.get(installationId)
    if (!binding) {
      throw new FederatedScopeSelectionError('unauthorized_scope',
        'scope selection must be a subset of the validated grant bindings')
    }
    if (binding.owner_scope_kind !== 'personal' && !input.sharedScopesEnabled) {
      throw new FederatedScopeSelectionError('shared_scope_not_enabled',
        'shared scope retrieval requires MEMORY_SHARED_SCOPES=enabled')
    }
    selected.push({
      installationId: binding.installation_id,
      ownerScopeKind: binding.owner_scope_kind,
      ownerScopeId: binding.owner_scope_id,
      authorizationEpoch: binding.authorization_epoch,
    })
  }
  return selected
}

/**
 * Legacy/default reads may use a v1 personal grant, or the personal primary
 * binding of a v2 grant. A shared-primary v2 grant never implies consent to
 * read that shared scope: callers must name it explicitly.
 */
export function defaultReadInstallationId(grant: VerifiedMemoryGrant): string {
  if (!('version' in grant) || grant.version !== 'v2') return grant.installationId
  const [personal] = selectFederatedScopes({
    grant,
    requestedInstallationIds: null,
    sharedScopesEnabled: false,
  })
  if (!personal) {
    throw new FederatedScopeSelectionError('unauthorized_scope',
      'shared scope reads require an explicit scope selection')
  }
  return personal.installationId
}

const AUTHORITY_RANK: Record<string, number> = {
  user_corrected: 6,
  user_accepted: 5,
  organization_published: 4,
  organization_reviewed: 3,
  team_published: 2,
  team_reviewed: 1,
}

export interface FederatedHit<T> {
  scope: SelectedScope
  rank: number
  hit: T
  /** Tie-break key parts per §6.4: applicability, correction, authority, freshness, ids. */
  tieBreak: {
    applicability: number
    correction: number
    authorityRank: number
    freshness: number
    installationId: string
    claimId: string
  }
}

export interface RrfHitInput<T> {
  scope: SelectedScope
  hit: T
  claimId: string
  repositoryApplicable: boolean
  authority: string
  freshnessAt: Date | null
}

export interface FederatedSearchPage<T> {
  hits: T[]
  nextCursor: string | null
  degradedComponents: string[]
  poolSizes: Record<string, number>
}

/**
 * Collect enough of each independently ranked scope to compute a stable
 * federated page. The per-scope service keeps its own installation-bound
 * cursor; this coordinator never asks a backend for more than 20 rows at a
 * time and caps the federated offset at 100 through resolveFederatedCursor.
 */
export async function collectFederatedSearchPages<T>(input: {
  scopes: readonly SelectedScope[]
  targetCount: number
  load: (scope: SelectedScope, cursor: string | null, limit: number) => Promise<FederatedSearchPage<T>>
}): Promise<Array<{
  scope: SelectedScope
  hits: T[]
  degradedComponents: string[]
  poolSizes: Record<string, number>
  hasMore: boolean
}>> {
  const targetCount = Math.min(120, Math.max(1, input.targetCount))
  return Promise.all(input.scopes.map(async scope => {
    const hits: T[] = []
    const degraded = new Set<string>()
    let poolSizes: Record<string, number> = {}
    let cursor: string | null = null
    do {
      const page = await input.load(scope, cursor, Math.min(20, targetCount - hits.length))
      hits.push(...page.hits)
      page.degradedComponents.forEach(component => degraded.add(component))
      poolSizes = page.poolSizes
      cursor = page.nextCursor
    } while (cursor && hits.length < targetCount)
    return {
      scope,
      hits,
      degradedComponents: [...degraded],
      poolSizes,
      hasMore: cursor !== null,
    }
  }))
}

/**
 * Deterministic federated merge (§6.4.4–6): per-scope ranks feed RRF
 * (k = 60); the stable tie-break order is applicability, explicit user
 * correction, authority, freshness, then installation and claim ids so the
 * same inputs always produce the same ordering.
 */
export function mergeFederatedRrf<T>(inputs: readonly RrfHitInput<T>[], limit: number): Array<FederatedHit<T>> {
  const rrfK = 60
  const scores = new Map<string, { total: number; input: RrfHitInput<T>; scopes: Set<string> }>()
  const perScopeRank = new Map<string, Map<string, number>>()

  for (const input of inputs) {
    const scopeKey = input.scope.installationId
    const resultKey = `${scopeKey}:${input.claimId}`
    if (!perScopeRank.has(scopeKey)) perScopeRank.set(scopeKey, new Map())
    const ranks = perScopeRank.get(scopeKey)!
    if (!ranks.has(input.claimId)) ranks.set(input.claimId, ranks.size + 1)
    if (!scores.has(resultKey)) {
      scores.set(resultKey, { total: 0, input, scopes: new Set() })
    }
    const entry = scores.get(resultKey)!
    entry.scopes.add(scopeKey)
  }
  for (const [scopeKey, ranks] of perScopeRank) {
    for (const [claimId, rank] of ranks) {
      const entry = scores.get(`${scopeKey}:${claimId}`)
      if (entry && entry.scopes.has(scopeKey)) {
        entry.total += 1 / (rrfK + rank)
      }
    }
  }

  const merged = [...scores.values()].map(entry => ({
    scope: entry.input.scope,
    rank: entry.total,
    hit: entry.input.hit,
    tieBreak: {
      applicability: entry.input.repositoryApplicable ? 1 : 0,
      correction: entry.input.authority === 'user_corrected' ? 1 : 0,
      authorityRank: AUTHORITY_RANK[entry.input.authority] ?? 0,
      freshness: entry.input.freshnessAt ? entry.input.freshnessAt.getTime() : 0,
      installationId: entry.input.scope.installationId,
      claimId: entry.input.claimId,
    },
  }))

  merged.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank
    if (b.tieBreak.applicability !== a.tieBreak.applicability) {
      return b.tieBreak.applicability - a.tieBreak.applicability
    }
    if (b.tieBreak.correction !== a.tieBreak.correction) {
      return b.tieBreak.correction - a.tieBreak.correction
    }
    if (b.tieBreak.authorityRank !== a.tieBreak.authorityRank) {
      return b.tieBreak.authorityRank - a.tieBreak.authorityRank
    }
    if (b.tieBreak.freshness !== a.tieBreak.freshness) {
      return b.tieBreak.freshness - a.tieBreak.freshness
    }
    if (a.tieBreak.installationId !== b.tieBreak.installationId) {
      return a.tieBreak.installationId < b.tieBreak.installationId ? -1 : 1
    }
    return a.tieBreak.claimId < b.tieBreak.claimId ? -1 : 1
  })
  return merged.slice(0, Math.max(1, limit))
}

export interface FederatedCursorContextInput {
  scopes: readonly SelectedScope[]
  query: string
  repositoryId?: string | null
  repoSnapshotId?: string | null
  branch?: string | null
  claimTypes?: readonly string[] | null
}

/**
 * Federated cursors bind the ordered page offset to the complete query and to
 * every selected installation authorization epoch. A membership or lifecycle
 * change therefore invalidates an otherwise correctly signed cursor.
 */
export function resolveFederatedCursor(input: {
  cursor?: string | null
  context: FederatedCursorContextInput
  key: string
  requestedAsOf?: Date | null
  now?: Date
}): { offset: number; asOf: Date } {
  if (!input.cursor) return { offset: 0, asOf: input.requestedAsOf ?? input.now ?? new Date() }
  try {
    const [payload, suppliedSignature, extra] = input.cursor.split('.')
    if (!payload || !suppliedSignature || extra !== undefined) throw new Error('invalid_cursor')
    const expected = createHmac('sha256', input.key).update(payload).digest()
    const supplied = Buffer.from(suppliedSignature, 'base64url')
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new Error('invalid_cursor')
    }
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      o?: unknown; q?: unknown; a?: unknown
    }
    if (parsed.q !== federatedCursorContext(input.context)) throw new Error('invalid_cursor')
    if (typeof parsed.o !== 'number' || !Number.isInteger(parsed.o)
      || parsed.o < 0 || parsed.o > MAX_FEDERATED_OFFSET || typeof parsed.a !== 'string') {
      throw new Error('invalid_cursor')
    }
    const asOf = new Date(parsed.a)
    if (Number.isNaN(asOf.getTime()) || asOf.toISOString() !== parsed.a) throw new Error('invalid_cursor')
    if (input.requestedAsOf && input.requestedAsOf.getTime() !== asOf.getTime()) {
      throw new Error('invalid_cursor')
    }
    return { offset: parsed.o, asOf }
  } catch {
    throw new FederatedScopeSelectionError('invalid_cursor', 'invalid federated cursor')
  }
}

export function encodeFederatedCursor(input: {
  offset: number
  asOf: Date
  context: FederatedCursorContextInput
  key: string
}): string {
  if (!Number.isInteger(input.offset) || input.offset < 0 || input.offset > MAX_FEDERATED_OFFSET) {
    throw new FederatedScopeSelectionError('invalid_cursor', 'invalid federated cursor offset')
  }
  const payload = Buffer.from(JSON.stringify({
    o: input.offset,
    q: federatedCursorContext(input.context),
    a: input.asOf.toISOString(),
  }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', input.key).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function federatedCursorContext(input: FederatedCursorContextInput): string {
  return createHash('sha256').update(JSON.stringify({
    scopes: input.scopes.map(scope => [scope.installationId, scope.authorizationEpoch]),
    query: input.query,
    repositoryId: input.repositoryId ?? null,
    repoSnapshotId: input.repoSnapshotId ?? null,
    branch: input.branch ?? null,
    claimTypes: input.claimTypes ? [...input.claimTypes].sort() : null,
  })).digest('base64url')
}

export interface ScopedRecallResult {
  scope: SelectedScope
  result: RecallResult
}

/** Build and re-bound one federated Recall DTO after per-scope RRF merge. */
export function buildFederatedRecallResult(
  perScope: readonly ScopedRecallResult[],
  merged: readonly FederatedHit<RecallClaim>[],
  maxChars: number,
  metadata: ReadonlyMap<string, {
    ownerScopeKind: string
    ownerScopeId: string
    conflictGroupId: string | null
    conflictVariant: number | null
  }> = new Map(),
): Omit<RecallResult, 'claims'> & { claims: Array<RecallClaim & {
  installationId: string
  ownerScopeKind: string
  ownerScopeId: string
  conflictGroupId: string | null
  conflictVariant: number | null
}> } {
  const claims = merged.map(entry => {
    const decorated = metadata.get(`${entry.scope.installationId}:${entry.hit.claimId}`)
    return {
      ...entry.hit,
      installationId: entry.scope.installationId,
      ownerScopeKind: decorated?.ownerScopeKind ?? entry.scope.ownerScopeKind,
      ownerScopeId: decorated?.ownerScopeId ?? entry.scope.ownerScopeId,
      conflictGroupId: decorated?.conflictGroupId ?? null,
      conflictVariant: decorated?.conflictVariant ?? null,
    }
  })
  const sharedGroups = new Map<string, typeof claims>()
  for (const claim of claims) {
    if (!claim.conflictGroupId) continue
    const key = `${claim.installationId}:${claim.conflictGroupId}`
    const group = sharedGroups.get(key) ?? []
    group.push(claim)
    sharedGroups.set(key, group)
  }
  const sharedConflicts = [...sharedGroups.values()]
    .filter(group => group.length > 1)
    .flatMap(group => group
      .sort((left, right) => (left.conflictVariant ?? 0) - (right.conflictVariant ?? 0))
      .map(claim => ({
        claimId: claim.claimId,
        claimType: claim.claimType,
        statementExcerpt: claim.statement.slice(0, 160),
      })))
  const result = {
    requestId: perScope[0]?.result.requestId ?? 'federated-empty',
    degradedComponents: [...new Set(perScope.flatMap(entry => entry.result.degradedComponents))],
    claims,
    conflicts: [...perScope.flatMap(entry => entry.result.conflicts), ...sharedConflicts].slice(0, 20),
    relatedEpisodes: perScope.flatMap(entry => entry.result.relatedEpisodes).slice(0, 10),
    coverageGaps: [...new Set(perScope.flatMap(entry => entry.result.coverageGaps))],
    totalChars: 0,
  }
  const serializedLength = (): number => {
    let previous = -1
    for (let index = 0; index < 4; index++) {
      const current = JSON.stringify(result).length
      result.totalChars = current
      if (current === previous) break
      previous = current
    }
    return JSON.stringify(result).length
  }
  let truncated = false
  while (serializedLength() > maxChars) {
    if (result.relatedEpisodes.length > 0) result.relatedEpisodes.pop()
    else if (result.conflicts.length > 0) result.conflicts.pop()
    else {
      const withEvidence = [...result.claims].reverse().find(claim => claim.evidence.length > 0)
      if (withEvidence) withEvidence.evidence.pop()
      else if (result.claims.length > 0) result.claims.pop()
      else if (result.coverageGaps.length > 0) result.coverageGaps.pop()
      else break
    }
    truncated = true
  }
  if (truncated && !result.coverageGaps.includes('response_truncated')) {
    result.coverageGaps.push('response_truncated')
    if (serializedLength() > maxChars) result.coverageGaps.pop()
  }
  serializedLength()
  return result
}

/** Owner-scope + conflict decoration for one installation's claims. */
export async function decorateWithScopeMetadata(
  pool: pg.Pool,
  installationIds: readonly string[],
  claimIdsByInstallation: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, {
  ownerScopeKind: string
  ownerScopeId: string
  conflictGroupId: string | null
  conflictVariant: number | null
}>> {
  const decoration = new Map<string, {
    ownerScopeKind: string
    ownerScopeId: string
    conflictGroupId: string | null
    conflictVariant: number | null
  }>()
  for (const installationId of installationIds) {
    const claimIds = claimIdsByInstallation.get(installationId) ?? []
    if (claimIds.length === 0) continue
    const result = await pool.query<{
      claim_id: string
      owner_scope_kind: string
      owner_scope_id: string
      conflict_group_id: string | null
      conflict_variant: number | null
    }>(`
      SELECT claim_id, owner_scope_kind, owner_scope_id::text, conflict_group_id::text, conflict_variant
      FROM knowledge_claims
      WHERE installation_id = $1 AND claim_id = ANY($2::uuid[])
    `, [installationId, claimIds])
    for (const row of result.rows) {
      decoration.set(`${installationId}:${row.claim_id}`, {
        ownerScopeKind: row.owner_scope_kind,
        ownerScopeId: row.owner_scope_id,
        conflictGroupId: row.conflict_group_id,
        conflictVariant: row.conflict_variant === null ? null : Number(row.conflict_variant),
      })
    }
  }
  return decoration
}
