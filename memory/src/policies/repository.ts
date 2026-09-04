import { randomUUID } from 'crypto'
import type pg from 'pg'
import {
  canonicalPolicyHash,
  systemPolicyFor,
  validatePolicyDocument,
  type AnyPolicyDocument,
  type PolicyKind,
  type PolicyLayer,
} from './schemas.js'

export interface PolicyVersionRow {
  policy_version_id: string
  policy_id: string
  version_number: number
  document: AnyPolicyDocument
  content_hash: Buffer
  created_by: 'system' | 'user'
  created_at: Date
}

export interface PolicyHeadRow {
  policy_id: string
  active_version_id: string
  revision: number
}

/**
 * Policy persistence over the v13 schema. System rows carry a NULL
 * installation and are installed idempotently; repository/user rows are
 * installation-scoped. Organization/team layers are rejected until Phase 3
 * authorization exists (plan ADR-P2-07).
 */
export function createPolicyRepository(pool: pg.Pool) {
  return {
    /** Idempotently install and activate the latest code-owned system document. */
    async ensureSystemPolicies(): Promise<void> {
      for (const kind of ['extraction', 'context', 'ranking'] as const) {
        const set = await pool.query<{ policy_id: string }>(`
          INSERT INTO memory_policy_sets
            (policy_id, installation_id, policy_kind, layer, scope_key)
          VALUES (gen_random_uuid(), NULL, $1, 'system', 'global')
          ON CONFLICT DO NOTHING
          RETURNING policy_id::text
        `, [kind])
        let policyId = set.rows[0]?.policy_id
        if (!policyId) {
          const existing = await pool.query<{ policy_id: string }>(`
            SELECT policy_id::text FROM memory_policy_sets
            WHERE installation_id IS NULL AND policy_kind = $1 AND layer = 'system'
          `, [kind])
          policyId = existing.rows[0].policy_id
        }
        const document = systemPolicyFor(kind)
        const hash = canonicalPolicyHash(document)
        const version = await pool.query<{ policy_version_id: string }>(`
          INSERT INTO memory_policy_versions
            (policy_version_id, policy_id, version_number, schema_version,
             document, content_hash, created_by)
          VALUES ($1, $2,
            (SELECT COALESCE(MAX(version_number), 0) + 1
             FROM memory_policy_versions WHERE policy_id = $2),
            1, $3::jsonb, $4, 'system')
          ON CONFLICT DO NOTHING
          RETURNING policy_version_id::text
        `, [randomUUID(), policyId, JSON.stringify(document), hash])
        const versionId = version.rows[0]?.policy_version_id ??
          (await pool.query<{ policy_version_id: string }>(`
            SELECT policy_version_id::text FROM memory_policy_versions
            WHERE policy_id = $1 AND content_hash = $2
          `, [policyId, hash])).rows[0]?.policy_version_id
        if (!versionId) throw new Error(`system policy version unavailable: ${kind}`)
        await pool.query(`
          INSERT INTO memory_policy_heads (policy_id, active_version_id, revision)
          VALUES ($1, $2, 1)
          ON CONFLICT (policy_id) DO UPDATE
          SET active_version_id = EXCLUDED.active_version_id,
              revision = memory_policy_heads.revision + 1,
              updated_at = NOW()
          WHERE memory_policy_heads.active_version_id <> EXCLUDED.active_version_id
        `, [policyId, versionId])
      }
    },

    async listHeadDocuments(input: {
      installationId: string
      kind: PolicyKind
      repositoryId?: string | null
      userScopeKey?: string | null
      /** Phase 3: parent Organization installation for the org layer. */
      organizationInstallationId?: string | null
      /** Phase 3: include this installation's team layer. */
      includeTeamLayer?: boolean
    }): Promise<Array<{ layer: PolicyLayer; scopeKey: string; document: AnyPolicyDocument; policyVersionId: string; headRevision: number }>> {
      const result = await pool.query<{
        layer: PolicyLayer
        scope_key: string
        document: AnyPolicyDocument
        policy_version_id: string
        revision: string
      }>(`
        SELECT s.layer, s.scope_key, v.document, v.policy_version_id::text, h.revision::text
        FROM memory_policy_sets s
        JOIN memory_policy_heads h ON h.policy_id = s.policy_id
        JOIN memory_policy_versions v ON v.policy_version_id = h.active_version_id
        WHERE s.policy_kind = $2
          AND (s.installation_id IS NULL AND s.layer = 'system'
               OR s.installation_id = $1 AND s.layer = 'repository' AND s.scope_key = $3
               OR s.installation_id = $1 AND s.layer = 'user' AND s.scope_key = $4
               OR ($5::uuid IS NOT NULL AND s.installation_id = $5::uuid AND s.layer = 'organization')
               OR ($6::boolean AND s.installation_id = $1 AND s.layer = 'team'))
        ORDER BY (s.layer = 'system') DESC,
                 (s.layer = 'organization') DESC,
                 (s.layer = 'team') DESC,
                 s.created_at ASC
      `, [input.installationId, input.kind, input.repositoryId ?? '', input.userScopeKey ?? 'global',
        input.organizationInstallationId ?? null, Boolean(input.includeTeamLayer)])
      return result.rows.map(row => ({
        layer: row.layer,
        scopeKey: row.scope_key,
        document: row.document,
        policyVersionId: row.policy_version_id,
        headRevision: Number(row.revision),
      }))
    },

    /**
     * Create a policy version. Phase 3 (ADR-P3-14/§9): the team/organization
     * layers activate only for an authorized policy_admin actor whose
     * installation owner scope matches the layer; the system layer stays
     * code-owned. Unauthorized or mismatched requests keep the frozen
     * `layer_unavailable` answer.
     */
    async createVersion(input: {
      installationId: string
      kind: PolicyKind
      layer: PolicyLayer
      scopeKey: string
      document: unknown
      actor?: { permissions: readonly string[]; ownerScopeKind?: string }
    }): Promise<{ ok: true; policyVersionId: string; versionNumber: number } | {
      ok: false
      error: 'invalid_document' | 'layer_unavailable'
      issues?: string[]
    }> {
      if (input.layer === 'system') {
        return { ok: false, error: 'layer_unavailable' }
      }
      if (input.layer === 'organization' || input.layer === 'team') {
        const actor = input.actor
        if (!actor || !actor.permissions.includes('policy_admin')) {
          return { ok: false, error: 'layer_unavailable' }
        }
        if (actor.ownerScopeKind !== input.layer) {
          return { ok: false, error: 'layer_unavailable' }
        }
      }
      const validated = validatePolicyDocument(input.kind, input.document)
      if (!validated.ok) return { ok: false, error: 'invalid_document', issues: validated.issues }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const set = await client.query<{ policy_id: string }>(`
          INSERT INTO memory_policy_sets
            (policy_id, installation_id, policy_kind, layer, scope_key)
          VALUES (gen_random_uuid(), $1, $2, $3, $4)
          ON CONFLICT DO NOTHING
          RETURNING policy_id::text
        `, [input.installationId, input.kind, input.layer, input.scopeKey])
        const setWasNew = Boolean(set.rows[0])
        let policyId = set.rows[0]?.policy_id
        if (!policyId) {
          const existing = await client.query<{ policy_id: string }>(`
            SELECT policy_id::text FROM memory_policy_sets
            WHERE installation_id = $1 AND policy_kind = $2 AND layer = $3 AND scope_key = $4
          `, [input.installationId, input.kind, input.layer, input.scopeKey])
          policyId = existing.rows[0].policy_id
        }
        // Serialize MAX(version_number)+1 for this policy set. The set row is
        // stable and considerably narrower than locking the versions table.
        await client.query(`SELECT policy_id FROM memory_policy_sets WHERE policy_id = $1 FOR UPDATE`, [policyId])
        const hash = canonicalPolicyHash(validated.document)
        const next = await client.query<{ policy_version_id: string; version_number: number }>(`
          INSERT INTO memory_policy_versions
            (policy_version_id, policy_id, version_number, schema_version,
             document, content_hash, created_by)
          VALUES ($1, $2,
            (SELECT COALESCE(MAX(version_number), 0) + 1 FROM memory_policy_versions
             WHERE policy_id = $2),
            1, $3::jsonb, $4, 'user')
          ON CONFLICT (policy_id, content_hash) DO NOTHING
          RETURNING policy_version_id::text, version_number
        `, [randomUUID(), policyId, JSON.stringify(validated.document), hash])
        const existingVersion = next.rows[0] ?? (await client.query<{
          policy_version_id: string
          version_number: number
        }>(`
          SELECT policy_version_id::text, version_number FROM memory_policy_versions
          WHERE policy_id = $1 AND content_hash = $2
        `, [policyId, hash])).rows[0]
        if (setWasNew) {
          // A brand-new set activates its first version as the initial head.
          await client.query(`
            INSERT INTO memory_policy_heads (policy_id, active_version_id, revision)
            VALUES ($1, $2, 1)
            ON CONFLICT (policy_id) DO NOTHING
          `, [policyId, existingVersion.policy_version_id])
        }
        await client.query('COMMIT')
        return {
          ok: true,
          policyVersionId: existingVersion.policy_version_id,
          versionNumber: Number(existingVersion.version_number),
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    /**
     * CAS activation: the head moves only when the caller observed the same
     * active version and revision. Returns false on conflict.
     */
    async activateVersion(input: {
      installationId: string
      policyVersionId: string
      expectedActiveVersionId: string
      expectedRevision: number
      expectedKind?: PolicyKind
    }): Promise<boolean> {
      const target = await pool.query<{ policy_id: string; installation_id: string | null; policy_kind: PolicyKind }>(`
        SELECT p.policy_id::text, p.installation_id::text, p.policy_kind
        FROM memory_policy_versions v JOIN memory_policy_sets p ON p.policy_id = v.policy_id
        WHERE v.policy_version_id = $1
      `, [input.policyVersionId])
      const row = target.rows[0]
      if (!row || row.installation_id !== input.installationId
        || (input.expectedKind !== undefined && row.policy_kind !== input.expectedKind)) return false
      const updated = await pool.query(`
        UPDATE memory_policy_heads
        SET active_version_id = $1, revision = revision + 1, updated_at = NOW()
        WHERE policy_id = $2 AND active_version_id = $3 AND revision = $4
      `, [input.policyVersionId, row.policy_id, input.expectedActiveVersionId, input.expectedRevision])
      return (updated.rowCount ?? 0) > 0
    },

    async headRevisionForVersion(input: {
      installationId: string
      policyVersionId: string
    }): Promise<number | null> {
      const result = await pool.query<{ revision: string }>(`
        SELECT h.revision::text
        FROM memory_policy_versions v
        JOIN memory_policy_sets s ON s.policy_id = v.policy_id
        JOIN memory_policy_heads h ON h.policy_id = s.policy_id
        WHERE v.policy_version_id = $1 AND s.installation_id = $2
      `, [input.policyVersionId, input.installationId])
      return result.rows[0] ? Number(result.rows[0].revision) : null
    },

    async listVersions(input: {
      installationId: string
      kind: PolicyKind
      layer: PolicyLayer
      scopeKey: string
	}): Promise<Array<{
		policyVersionId: string; versionNumber: number; document: AnyPolicyDocument
		active: boolean; headRevision: number
	}>> {
      const result = await pool.query<{
        policy_version_id: string
        version_number: number
        document: AnyPolicyDocument
        active_version_id: string | null
		revision: string | null
      }>(`
		SELECT v.policy_version_id::text, v.version_number, v.document,
		       h.active_version_id::text, h.revision::text
        FROM memory_policy_sets s
        JOIN memory_policy_versions v ON v.policy_id = s.policy_id
        LEFT JOIN memory_policy_heads h ON h.policy_id = s.policy_id
        WHERE s.installation_id = $1 AND s.policy_kind = $2
          AND s.layer = $3 AND s.scope_key = $4
        ORDER BY v.version_number ASC
      `, [input.installationId, input.kind, input.layer, input.scopeKey])
      return result.rows.map(row => ({
        policyVersionId: row.policy_version_id,
        versionNumber: Number(row.version_number),
        document: row.document,
        active: row.active_version_id === row.policy_version_id,
		headRevision: Number(row.revision ?? 0),
      }))
    },

    /** Enqueue a digest-keyed recompile job (plan section 6.1). */
    async enqueueRecompile(input: {
      installationId: string
      policyHash: Buffer
    }): Promise<void> {
      await pool.query(`
        INSERT INTO memory_jobs
          (job_id, installation_id, job_type, idempotency_key, priority, payload)
        VALUES (gen_random_uuid(), $1, 'recompile_extraction_policy', $2, 84, $3::jsonb)
        ON CONFLICT DO NOTHING
      `, [
        input.installationId,
        `recompile:${input.installationId}:${input.policyHash.toString('hex').slice(0, 32)}`,
        JSON.stringify({ policy_hash: input.policyHash.toString('hex') }),
      ])
    },
  }
}

export type PolicyRepository = ReturnType<typeof createPolicyRepository>
