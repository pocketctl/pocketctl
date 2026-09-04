import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'

import type { ReviewPolicyDocument } from './types.js'

/**
 * ADR-0005 Review Policy V1 (§6.2). Documents are canonically hashed,
 * immutable versions with CAS heads, diff, and rollback — exactly like the
 * Phase 2 policy machinery. Unknown fields fail closed; the code-owned
 * security floor (no self-publish, independent reviewer, publisher gate,
 * bounded evidence and TTL) can never be weakened by a stored document.
 */

export const DEFAULT_TEAM_REVIEW_POLICY: ReviewPolicyDocument = Object.freeze({
  schema_version: 1,
  minimum_approvals: 1,
  require_independent_reviewer: true,
  require_publisher: true,
  publisher_may_count_as_reviewer: true,
  allow_self_publish: false,
  candidate_ttl_days: 30,
  max_shared_evidence: 8,
  retention_days_after_revoke: 90,
  allow_parallel_conflicts: true,
})

/** Organization system floor: at least two approvals (§6.2). */
export const DEFAULT_ORGANIZATION_REVIEW_POLICY: ReviewPolicyDocument = Object.freeze({
  ...DEFAULT_TEAM_REVIEW_POLICY,
  minimum_approvals: 2,
})

const POLICY_BOUNDS = Object.freeze({
  minimum_approvals: [1, 10] as const,
  candidate_ttl_days: [1, 365] as const,
  max_shared_evidence: [1, 8] as const,
  retention_days_after_revoke: [1, 3650] as const,
})

/** Parse and validate a policy document; anything unknown fails closed. */
export function parseReviewPolicyDocument(input: unknown): ReviewPolicyDocument | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const expectedKeys: readonly (keyof ReviewPolicyDocument)[] = [
    'schema_version', 'minimum_approvals', 'require_independent_reviewer',
    'require_publisher', 'publisher_may_count_as_reviewer', 'allow_self_publish',
    'candidate_ttl_days', 'max_shared_evidence', 'retention_days_after_revoke',
    'allow_parallel_conflicts',
  ]
  const keys = Object.keys(value)
  if (keys.length !== expectedKeys.length
    || !expectedKeys.every(key => keys.includes(key))) return null
  if (value.schema_version !== 1) return null

  const document = value as unknown as ReviewPolicyDocument
  for (const [key, [min, max]] of Object.entries(POLICY_BOUNDS)) {
    const entry = document[key as keyof typeof POLICY_BOUNDS] as unknown
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < min || entry > max) {
      return null
    }
  }
  for (const key of ['require_independent_reviewer', 'require_publisher',
    'publisher_may_count_as_reviewer', 'allow_parallel_conflicts'] as const) {
    if (typeof document[key] !== 'boolean') return null
  }
  // Code-owned security floor: these can never be relaxed by any document.
  if (document.allow_self_publish !== false) return null
  if (document.require_independent_reviewer !== true) return null
  if (document.require_publisher !== true) return null
  return document
}

/** Canonical JSON hash: stable key order, no whitespace. */
export function canonicalReviewPolicyHash(document: ReviewPolicyDocument): string {
  const canonical = JSON.stringify(document, Object.keys(document).sort())
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Monotonic layer resolution (§6.2): the child (team) layer may only
 * strengthen the parent (organization) floor — approvals and retention take
 * the maximum, TTL and evidence keep the stricter lower bound, booleans can only
 * tighten — and the code floor can never be violated by either layer.
 */
export function resolveEffectivePolicy(
  parent: ReviewPolicyDocument,
  child: ReviewPolicyDocument,
): ReviewPolicyDocument {
  return {
    schema_version: 1,
    minimum_approvals: Math.max(parent.minimum_approvals, child.minimum_approvals),
    require_independent_reviewer: parent.require_independent_reviewer || child.require_independent_reviewer,
    require_publisher: parent.require_publisher || child.require_publisher,
    publisher_may_count_as_reviewer: parent.publisher_may_count_as_reviewer && child.publisher_may_count_as_reviewer,
    allow_self_publish: false,
    candidate_ttl_days: Math.min(parent.candidate_ttl_days, child.candidate_ttl_days),
    max_shared_evidence: Math.min(parent.max_shared_evidence, child.max_shared_evidence),
    retention_days_after_revoke: Math.max(parent.retention_days_after_revoke, child.retention_days_after_revoke),
    allow_parallel_conflicts: parent.allow_parallel_conflicts && child.allow_parallel_conflicts,
  }
}

export interface EffectiveReviewPolicySnapshot {
  scopeKind: 'team' | 'organization'
  activeVersionId: string
  parentActiveVersionId: string | null
  policy: ReviewPolicyDocument
}

type PolicyQueryClient = Pick<pg.PoolClient, 'query'>

async function ensurePolicyHead(
  client: PolicyQueryClient,
  installationId: string,
  document: ReviewPolicyDocument,
): Promise<void> {
  await client.query(`
    INSERT INTO memory_review_policy_sets (policy_id, installation_id)
    VALUES (gen_random_uuid(), $1)
    ON CONFLICT (installation_id) DO NOTHING
  `, [installationId])
  const policySet = await client.query<{ policy_id: string }>(`
    SELECT policy_id::text FROM memory_review_policy_sets
    WHERE installation_id = $1
    FOR UPDATE
  `, [installationId])
  const policyId = policySet.rows[0]?.policy_id
  if (!policyId) throw new Error('review policy set missing')
  const current = await client.query<{ active_version_id: string }>(`
    SELECT active_version_id::text FROM memory_review_policy_heads
    WHERE policy_id = $1
  `, [policyId])
  if (current.rows[0]) return
  const policyVersionId = randomUUID()
  await client.query(`
    INSERT INTO memory_review_policy_versions
      (policy_version_id, policy_id, version_number, document, content_hash)
    VALUES ($1, $2, 1, $3::jsonb, $4)
  `, [policyVersionId, policyId, JSON.stringify(document), canonicalReviewPolicyHash(document)])
  await client.query(`
    INSERT INTO memory_review_policy_heads (policy_id, active_version_id, revision)
    VALUES ($1, $2, 1)
  `, [policyId, policyVersionId])
}

async function readPolicyHead(
  client: PolicyQueryClient,
  installationId: string,
): Promise<{ activeVersionId: string; document: ReviewPolicyDocument }> {
  const result = await client.query<{
    active_version_id: string
    document: Record<string, unknown>
  }>(`
    SELECT h.active_version_id::text, v.document
    FROM memory_review_policy_versions v
    JOIN memory_review_policy_heads h ON h.active_version_id = v.policy_version_id
    JOIN memory_review_policy_sets s ON s.policy_id = h.policy_id
    WHERE s.installation_id = $1
    FOR SHARE OF h
  `, [installationId])
  const row = result.rows[0]
  if (!row) throw new Error('review policy head missing')
  const document = parseReviewPolicyDocument(row.document)
  if (!document) throw new Error('review policy document invalid')
  return { activeVersionId: row.active_version_id, document }
}

/**
 * Resolve the active policy plus every version that contributed to it. Team
 * snapshots include their parent Organization layer so candidate revisions
 * can fence both independently mutable policy heads.
 */
export async function loadEffectiveReviewPolicySnapshot(
  client: PolicyQueryClient,
  installationId: string,
  options: { ensure?: boolean } = {},
): Promise<EffectiveReviewPolicySnapshot> {
  const scope = await client.query<{
    owner_scope_kind: string
    parent_organization_id: string | null
  }>(`
    SELECT owner_scope_kind, parent_organization_id::text
    FROM memory_owner_scopes
    WHERE installation_id = $1
    FOR SHARE
  `, [installationId])
  const row = scope.rows[0]
  if (!row || !['team', 'organization'].includes(row.owner_scope_kind)) {
    throw new Error('shared review policy scope missing')
  }
  const scopeKind = row.owner_scope_kind as 'team' | 'organization'
  const targetDefault = scopeKind === 'organization'
    ? DEFAULT_ORGANIZATION_REVIEW_POLICY
    : DEFAULT_TEAM_REVIEW_POLICY
  if (options.ensure) await ensurePolicyHead(client, installationId, targetDefault)
  const target = await readPolicyHead(client, installationId)
  const targetPolicy = resolveEffectivePolicy(targetDefault, target.document)

  if (scopeKind === 'organization' || !row.parent_organization_id) {
    return {
      scopeKind,
      activeVersionId: target.activeVersionId,
      parentActiveVersionId: null,
      policy: targetPolicy,
    }
  }

  const parentScope = await client.query<{ installation_id: string }>(`
    SELECT installation_id::text
    FROM memory_owner_scopes
    WHERE owner_scope_kind = 'organization' AND owner_scope_id = $1
    FOR SHARE
  `, [row.parent_organization_id])
  const parentInstallationId = parentScope.rows[0]?.installation_id
  if (!parentInstallationId) throw new Error('parent organization review policy scope missing')
  if (options.ensure) {
    await ensurePolicyHead(client, parentInstallationId, DEFAULT_ORGANIZATION_REVIEW_POLICY)
  }
  const parent = await readPolicyHead(client, parentInstallationId)
  const parentPolicy = resolveEffectivePolicy(DEFAULT_ORGANIZATION_REVIEW_POLICY, parent.document)
  return {
    scopeKind,
    activeVersionId: target.activeVersionId,
    parentActiveVersionId: parent.activeVersionId,
    policy: resolveEffectivePolicy(parentPolicy, targetPolicy),
  }
}

export class ReviewPolicyRevisionConflictError extends Error {
  constructor() {
    super('review policy head revision mismatch')
    this.name = 'ReviewPolicyRevisionConflictError'
  }
}

interface PolicyVersionRow {
  policy_version_id: string
  version_number: string | number
  document: Record<string, unknown>
  content_hash: string
  created_by_membership_id: string | null
  created_at: Date
}

export function createReviewPolicyRepository(pool: pg.Pool) {
  return {
    /** Create the policy set with its V1 default document; idempotent. */
    async ensurePolicySet(
      installationId: string,
      document: ReviewPolicyDocument,
    ): Promise<{ policyId: string; policyVersionId: string; versionNumber: number }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const set = await client.query<{ policy_id: string }>(`
            INSERT INTO memory_review_policy_sets (policy_id, installation_id)
            VALUES ($1, $2)
            ON CONFLICT (installation_id) DO NOTHING
            RETURNING policy_id
          `, [randomUUID(), installationId])
          const policyId = set.rows[0]?.policy_id
            ?? (await client.query<{ policy_id: string }>(
              `SELECT policy_id FROM memory_review_policy_sets WHERE installation_id = $1`,
              [installationId],
            )).rows[0].policy_id
          const existing = await client.query<{ policy_version_id: string }>(`
            SELECT active_version_id AS policy_version_id FROM memory_review_policy_heads
            WHERE policy_id = $1
          `, [policyId])
          if (existing.rows[0]) {
            await client.query('COMMIT')
            const head = await this.getHead(installationId)
            return {
              policyId,
              policyVersionId: existing.rows[0].policy_version_id,
              versionNumber: head?.revision ?? 1,
            }
          }
          const version = await client.query<{ policy_version_id: string }>(`
            INSERT INTO memory_review_policy_versions
              (policy_version_id, policy_id, version_number, document, content_hash)
            VALUES ($1, $2, 1, $3::jsonb, $4)
            RETURNING policy_version_id
          `, [randomUUID(), policyId, JSON.stringify(document), canonicalReviewPolicyHash(document)])
          await client.query(`
            INSERT INTO memory_review_policy_heads (policy_id, active_version_id, revision)
            VALUES ($1, $2, 1)
          `, [policyId, version.rows[0].policy_version_id])
          await client.query('COMMIT')
          return {
            policyId,
            policyVersionId: version.rows[0].policy_version_id,
            versionNumber: 1,
          }
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async getHead(installationId: string): Promise<{
      policyId: string
      activeVersionId: string
      revision: number
    } | null> {
      const result = await pool.query<{ policy_id: string; active_version_id: string; revision: string }>(`
        SELECT h.policy_id, h.active_version_id, h.revision::text
        FROM memory_review_policy_heads h
        JOIN memory_review_policy_sets s ON s.policy_id = h.policy_id
        WHERE s.installation_id = $1
      `, [installationId])
      const row = result.rows[0]
      if (!row) return null
      return {
        policyId: row.policy_id,
        activeVersionId: row.active_version_id,
        revision: Number(row.revision),
      }
    },

    /** Publish an immutable new version under CAS on the head revision. */
    async publishVersion(input: {
      installationId: string
      document: ReviewPolicyDocument
      createdByMembershipId: string | null
      expectedRevision: number
    }): Promise<{ policyVersionId: string; versionNumber: number }> {
      const document = parseReviewPolicyDocument(input.document)
      if (!document) throw new Error('review policy document failed validation')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const head = await client.query<{ policy_id: string; revision: string }>(`
            SELECT h.policy_id, h.revision::text
            FROM memory_review_policy_heads h
            JOIN memory_review_policy_sets s ON s.policy_id = h.policy_id
            WHERE s.installation_id = $1
            FOR UPDATE OF h
          `, [input.installationId])
          const current = head.rows[0]
          if (!current || Number(current.revision) !== input.expectedRevision) {
            throw new ReviewPolicyRevisionConflictError()
          }
          const nextNumber = await client.query<{ next: string }>(`
            SELECT COALESCE(MAX(version_number), 0) + 1 AS next
            FROM memory_review_policy_versions WHERE policy_id = $1
          `, [current.policy_id])
          const version = await client.query<{ policy_version_id: string }>(`
            INSERT INTO memory_review_policy_versions
              (policy_version_id, policy_id, version_number, document, content_hash, created_by_membership_id)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6)
            RETURNING policy_version_id
          `, [
            randomUUID(), current.policy_id, Number(nextNumber.rows[0].next),
            JSON.stringify(document), canonicalReviewPolicyHash(document),
            input.createdByMembershipId,
          ])
          const bumped = await client.query(`
            UPDATE memory_review_policy_heads
            SET active_version_id = $2, revision = revision + 1, updated_at = NOW()
            WHERE policy_id = $1 AND revision = $3
          `, [current.policy_id, version.rows[0].policy_version_id, input.expectedRevision])
          if ((bumped.rowCount ?? 0) === 0) throw new ReviewPolicyRevisionConflictError()
          await client.query('COMMIT')
          return {
            policyVersionId: version.rows[0].policy_version_id,
            versionNumber: Number(nextNumber.rows[0].next),
          }
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    /** Rollback re-points the head at a historical version under CAS. */
    async rollback(input: {
      installationId: string
      targetVersionId: string
      expectedRevision: number
    }): Promise<{ activeVersionId: string; revision: number }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const head = await client.query<{ policy_id: string }>(`
          SELECT h.policy_id FROM memory_review_policy_heads h
          JOIN memory_review_policy_sets s ON s.policy_id = h.policy_id
          WHERE s.installation_id = $1 FOR UPDATE OF h
        `, [input.installationId])
        const current = head.rows[0]
        if (!current) throw new ReviewPolicyRevisionConflictError()
        const updated = await client.query<{ revision: string }>(`
          UPDATE memory_review_policy_heads
          SET active_version_id = $2, revision = revision + 1, updated_at = NOW()
          WHERE policy_id = $1 AND revision = $3
          RETURNING revision::text
        `, [current.policy_id, input.targetVersionId, input.expectedRevision])
        if ((updated.rowCount ?? 0) === 0) throw new ReviewPolicyRevisionConflictError()
        await client.query('COMMIT')
        return { activeVersionId: input.targetVersionId, revision: Number(updated.rows[0].revision) }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    async listVersions(installationId: string): Promise<Array<{
      policyVersionId: string
      versionNumber: number
      document: ReviewPolicyDocument | null
      contentHash: string
      createdAt: Date
    }>> {
      const result = await pool.query<PolicyVersionRow>(`
        SELECT v.policy_version_id, v.version_number, v.document, v.content_hash, v.created_at
        FROM memory_review_policy_versions v
        JOIN memory_review_policy_sets s ON s.policy_id = v.policy_id
        WHERE s.installation_id = $1
        ORDER BY v.version_number ASC
      `, [installationId])
      return result.rows.map(row => ({
        policyVersionId: row.policy_version_id,
        versionNumber: Number(row.version_number),
        document: parseReviewPolicyDocument(row.document),
        contentHash: row.content_hash,
        createdAt: row.created_at,
      }))
    },

    async getActiveDocument(installationId: string): Promise<ReviewPolicyDocument | null> {
      const result = await pool.query<{ document: Record<string, unknown> }>(`
        SELECT v.document
        FROM memory_review_policy_versions v
        JOIN memory_review_policy_heads h ON h.active_version_id = v.policy_version_id
        JOIN memory_review_policy_sets s ON s.policy_id = h.policy_id
        WHERE s.installation_id = $1
      `, [installationId])
      return parseReviewPolicyDocument(result.rows[0]?.document)
    },
  }
}

export type ReviewPolicyRepository = ReturnType<typeof createReviewPolicyRepository>
