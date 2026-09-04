import { createHash, randomUUID } from 'crypto'
import type pg from 'pg'
import {
  minContextMode,
  type ContextMode,
  type ContextSettingsRow,
  type EffectiveContextSettings,
} from './types.js'

export function effectiveContextSettingsFingerprint(settings: EffectiveContextSettings): Buffer {
  return createHash('sha256').update(JSON.stringify({
    mode: settings.mode,
    maxTokens: settings.maxTokens,
    revisions: settings.revisions,
  })).digest()
}

/**
 * Context mode settings per (installation, scope, agent) with CAS revisions
 * (plan section 6.4). A more-specific row may only turn the mode DOWN; the
 * resolver takes the minimum across every applying row, and agent-specific
 * rows override the agent-generic row at the same scope.
 */
export function createContextSettingsRepository(pool: pg.Pool) {
  return {
    async upsert(input: {
      installationId: string
      scopeKind: 'installation' | 'repository' | 'session'
      scopeKey: string
      agent: string | null
      mode: ContextMode
      maxTokens: number | null
      expectedRevision: number
    }): Promise<{ ok: true; revision: number } | { ok: false; error: 'cas_conflict' }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const existing = await client.query<{ setting_id: string; revision: string }>(`
          SELECT setting_id::text, revision::text FROM memory_context_settings
          WHERE installation_id = $1 AND scope_kind = $2 AND scope_key = $3
            AND agent IS NOT DISTINCT FROM $4
          FOR UPDATE
        `, [input.installationId, input.scopeKind, input.scopeKey, input.agent])
        const row = existing.rows[0]
        if (row) {
          if (Number(row.revision) !== input.expectedRevision) {
            await client.query('COMMIT')
            return { ok: false, error: 'cas_conflict' }
          }
          const updated = await client.query<{ revision: string }>(`
            UPDATE memory_context_settings
            SET mode = $2, max_tokens = $3, revision = revision + 1, updated_at = NOW()
            WHERE setting_id = $1
            RETURNING revision::text
          `, [row.setting_id, input.mode, input.maxTokens])
          await client.query('COMMIT')
          return { ok: true, revision: Number(updated.rows[0].revision) }
        }
        if (input.expectedRevision !== 1) {
          await client.query('COMMIT')
          return { ok: false, error: 'cas_conflict' }
        }
        const inserted = await client.query<{ revision: string }>(`
          INSERT INTO memory_context_settings
            (setting_id, installation_id, scope_kind, scope_key, agent, mode, max_tokens, revision)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
          RETURNING revision::text
        `, [randomUUID(), input.installationId, input.scopeKind, input.scopeKey,
          input.agent, input.mode, input.maxTokens])
        await client.query('COMMIT')
        return { ok: true, revision: Number(inserted.rows[0].revision) }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async list(input: { installationId: string }): Promise<ContextSettingsRow[]> {
      const result = await pool.query(`
        SELECT setting_id::text, installation_id::text, scope_kind, scope_key,
               agent, mode, max_tokens, revision::text
        FROM memory_context_settings
        WHERE installation_id = $1
        ORDER BY scope_kind ASC, agent NULLS FIRST
      `, [input.installationId])
      return result.rows.map(row => ({
        settingId: row.setting_id,
        installationId: row.installation_id,
        scopeKind: row.scope_kind,
        scopeKey: row.scope_key,
        agent: row.agent,
        mode: row.mode as ContextMode,
        maxTokens: row.max_tokens === null ? null : Number(row.max_tokens),
        revision: Number(row.revision),
      }))
    },

    /**
     * Effective settings for one request: installation row, the repository
     * row for the resolved repository, the session row, each with agent
     * specificity overriding agent-generic. The mode is the minimum; the
     * token budget is the tightest bound.
     */
    async resolve(input: {
      installationId: string
      repositoryId?: string | null
      sessionId?: string | null
      agent?: string | null
    }): Promise<EffectiveContextSettings> {
      const rows = await this.list({ installationId: input.installationId })
      const applying: ContextSettingsRow[] = []
      for (const scopeKind of ['installation', 'repository', 'session'] as const) {
        const scopeKey = scopeKind === 'installation' ? 'global'
          : scopeKind === 'repository' ? (input.repositoryId ?? '')
          : (input.sessionId ?? '')
        if (!scopeKey) continue
        const scoped = rows.filter(row => row.scopeKind === scopeKind && row.scopeKey === scopeKey)
        const agentRow = input.agent ? scoped.find(row => row.agent === input.agent) : undefined
        const genericRow = scoped.find(row => row.agent === null)
        // Agent-specific row overrides the generic row at the same scope;
        // a generic ceiling still applies when only an agent row exists.
        if (agentRow) applying.push(agentRow)
        if (genericRow && (!agentRow || genericRow.mode !== agentRow.mode || agentRow.maxTokens === null)) {
          applying.push(genericRow)
        }
      }
      if (applying.length === 0) {
        return { mode: 'off', maxTokens: null, revisions: [] }
      }
      const modes = applying.map(row => row.mode)
      const tokens = applying
        .map(row => row.maxTokens)
        .filter((value): value is number => value !== null)
      return {
        mode: minContextMode(modes),
        maxTokens: tokens.length > 0 ? Math.min(...tokens) : null,
        revisions: applying.map(row => row.revision),
      }
    },
  }
}

export type ContextSettingsRepository = ReturnType<typeof createContextSettingsRepository>
