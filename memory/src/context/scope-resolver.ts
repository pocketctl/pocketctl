import type pg from 'pg'
import type { ScopeResolution } from './types.js'

/**
 * Scope resolution (plan section 7.2). Repository and branch hints from the
 * daemon are applicability hints ONLY: they resolve against repositories
 * already learned inside the verified Installation, and an unknown hint can
 * only NARROW to Installation-scoped Persona — it can never open another
 * repository scope. Branch/commit narrow eligibility downstream; they never
 * widen access here.
 */
export function createScopeResolver(pool: pg.Pool) {
  return {
    async resolve(input: {
      installationId: string
      sessionId: string
      repositoryIdHint?: string | null
      repositoryKeyHint?: string | null
      unknownRepositoryBehavior?: 'persona_only' | 'empty'
    }): Promise<ScopeResolution> {
      const session = await pool.query<{ n: number }>(`
        SELECT COUNT(*)::int AS n FROM source_sessions
        WHERE installation_id = $1 AND session_id = $2 AND deleted_at IS NULL
      `, [input.installationId, input.sessionId])

      let repositoryId: string | null = null
      if (input.repositoryIdHint) {
        const byId = await pool.query<{ repository_id: string }>(`
          SELECT repository_id::text FROM repositories
          WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryIdHint])
        repositoryId = byId.rows[0]?.repository_id ?? null
      }
      if (!repositoryId && input.repositoryKeyHint) {
        const byKey = await pool.query<{ repository_id: string }>(`
          SELECT repository_id::text FROM repositories
          WHERE installation_id = $1 AND repository_key = $2
        `, [input.installationId, input.repositoryKeyHint])
        repositoryId = byKey.rows[0]?.repository_id ?? null
      }
      if (!repositoryId && !input.repositoryIdHint && !input.repositoryKeyHint) {
        const fromSession = await pool.query<{ repository_id: string }>(`
          SELECT r.repository_id::text
          FROM source_events e
          JOIN repositories r
            ON r.installation_id = e.installation_id
           AND r.repository_key = e.payload->>'repository_id'
          WHERE e.installation_id = $1 AND e.session_id = $2
          ORDER BY e.occurred_at DESC, e.source_event_id DESC
          LIMIT 1
        `, [input.installationId, input.sessionId])
        repositoryId = fromSession.rows[0]?.repository_id ?? null
      }

      const repositoryKnown = repositoryId !== null
      const personaOnlyBehavior = input.unknownRepositoryBehavior ?? 'persona_only'
      return {
        installationId: input.installationId,
        repositoryId,
        repositoryKnown,
        // An unknown hint narrows to Persona (or empty); never widens scope.
        personaOnly: !repositoryKnown && personaOnlyBehavior === 'persona_only',
        sessionKnown: (session.rows[0]?.n ?? 0) > 0,
      }
    },

    /**
     * L3 Persona eligibility (plan 1.1/7.4): only active `work_method`
     * claim versions with explicit user-reviewed authority and at least one
     * live evidence row. No behavioral inference creates a Persona item.
     */
    async personaVersions(input: {
      installationId: string
    }): Promise<Array<{ claimId: string; versionId: string }>> {
      const result = await pool.query<{ claim_id: string; version_id: string }>(`
        SELECT c.claim_id::text, v.version_id::text
        FROM knowledge_claims c
        JOIN knowledge_versions v ON v.version_id = c.current_version_id
        WHERE c.installation_id = $1 AND c.state = 'active'
          AND c.claim_type = 'work_method'
          AND c.scope_kind = 'installation'
          AND c.scope_key = 'global'
          AND v.authority IN ('user_accepted', 'user_corrected')
          AND EXISTS (
            SELECT 1 FROM knowledge_evidence e
            WHERE e.installation_id = c.installation_id
              AND e.version_id = v.version_id)
      `, [input.installationId])
      return result.rows.map(row => ({ claimId: row.claim_id, versionId: row.version_id }))
    },
  }
}

export type ScopeResolver = ReturnType<typeof createScopeResolver>
