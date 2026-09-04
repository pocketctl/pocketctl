import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import type { ValidatedV2Grant } from '../governance/authorization.js'
import { requireCurrentWikiPermission } from './authorization.js'
import type { Phase4Metrics } from '../metrics.js'

export type WikiManualErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'revision_conflict'
  | 'locked'
  | 'invalid_input'

export class WikiManualError extends Error {
  constructor(readonly code: WikiManualErrorCode) {
    super(`wiki_manual_${code}`)
  }
}

interface ManualActionInput {
  grant: ValidatedV2Grant
  targetInstallationId: string
  wikiId: string
  sectionKey: string
  expectedLockVersion: number
  reasonCode?: string
}

function validateBounded(input: ManualActionInput, markdown?: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.sectionKey)
    || !Number.isSafeInteger(input.expectedLockVersion) || input.expectedLockVersion < 0
    || (input.reasonCode !== undefined && input.reasonCode.length > 64)
    || (markdown !== undefined && (markdown.length === 0 || markdown.length > 200_000))) {
    throw new WikiManualError('invalid_input')
  }
}

function hash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

export function createWikiManualService(
  pool: pg.Pool,
  options: { metrics?: Phase4Metrics } = {},
) {
  async function observe<T>(
    action: 'edit' | 'lock' | 'unlock',
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await work()
      options.metrics?.wikiManualActions.inc({ action, result: 'succeeded' })
      return result
    } catch (error) {
      const code = error instanceof WikiManualError ? error.code : 'invalid_input'
      const result = code === 'forbidden' ? 'unauthorized'
        : code === 'revision_conflict' || code === 'locked' ? 'conflict'
          : 'rejected'
      options.metrics?.wikiManualActions.inc({ action, result })
      throw error
    }
  }
  async function transact<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if (error instanceof WikiManualError) throw error
      if (error instanceof Error && error.message === 'wiki_forbidden') {
        throw new WikiManualError('forbidden')
      }
      throw error
    } finally {
      client.release()
    }
  }

  async function lockState(input: ManualActionInput, locked: boolean): Promise<{ lockVersion: number }> {
    validateBounded(input)
    return transact(async client => {
      const binding = await requireCurrentWikiPermission({
        client, grant: input.grant, targetInstallationId: input.targetInstallationId,
        permission: 'contribute',
      })
      const current = await client.query<{
        current_version_id: string
        locked: boolean
        lock_version: string
        content_hash: string
      }>(`
        SELECT h.current_version_id::text, h.locked, h.lock_version::text, v.content_hash
        FROM memory_wiki_manual_section_heads h
        JOIN memory_wiki_manual_section_versions v
          ON v.installation_id = h.installation_id
         AND v.manual_version_id = h.current_version_id
        WHERE h.installation_id = $1 AND h.wiki_id = $2 AND h.section_key = $3
        FOR UPDATE OF h
      `, [input.targetInstallationId, input.wikiId, input.sectionKey])
      const row = current.rows[0]
      if (!row) throw new WikiManualError('not_found')
      if (Number(row.lock_version) !== input.expectedLockVersion || row.locked === locked) {
        throw new WikiManualError('revision_conflict')
      }
      const next = input.expectedLockVersion + 1
      await client.query(`
        UPDATE memory_wiki_manual_section_heads
        SET locked = $4, lock_version = $5, updated_at = NOW()
        WHERE installation_id = $1 AND wiki_id = $2 AND section_key = $3
      `, [input.targetInstallationId, input.wikiId, input.sectionKey, locked, next])
      const headRevision = await client.query<{ revision: string }>(`
        SELECT revision::text FROM memory_wiki_heads
        WHERE installation_id = $1 AND wiki_id = $2
      `, [input.targetInstallationId, input.wikiId])
      await client.query(`
        INSERT INTO memory_wiki_audit_events
          (audit_id, installation_id, wiki_id, action, result, reason_code,
           old_content_hash, new_content_hash, actor_scope_kind, actor_scope_id,
           head_revision)
        VALUES ($1, $2, $3, $4, 'success', $5, $6, $6, $7, $8, $9)
      `, [randomUUID(), input.targetInstallationId, input.wikiId,
        locked ? 'lock' : 'unlock', input.reasonCode ?? null, row.content_hash,
        binding.owner_scope_kind, binding.owner_scope_id,
        headRevision.rows[0]?.revision ?? null])
      return { lockVersion: next }
    })
  }

    async function edit(input: ManualActionInput & { markdown: string },governed?:{sourceSectionKey:string}): Promise<{
      manualVersionId: string
      lockVersion: number
    }> {
      return observe('edit', async () => {
        validateBounded(input, input.markdown)
        return transact(async client => {
        const binding = await requireCurrentWikiPermission({
          client, grant: input.grant, targetInstallationId: input.targetInstallationId,
          permission: governed?'publish':'contribute',
        })
        const wiki = await client.query(`
          SELECT 1 FROM memory_wikis w
          WHERE w.installation_id = $1 AND w.wiki_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM memory_repository_tombstones t
              WHERE t.installation_id = w.installation_id AND t.repository_id = w.repository_id
            )
          FOR SHARE OF w
        `, [input.targetInstallationId, input.wikiId])
        if (!wiki.rows[0]) throw new WikiManualError('not_found')
        const current = await client.query<{
          current_version_id: string
          locked: boolean
          lock_version: string
          content_hash: string
        }>(`
          SELECT h.current_version_id::text, h.locked, h.lock_version::text, v.content_hash
          FROM memory_wiki_manual_section_heads h
          JOIN memory_wiki_manual_section_versions v
            ON v.installation_id = h.installation_id
           AND v.manual_version_id = h.current_version_id
          WHERE h.installation_id = $1 AND h.wiki_id = $2 AND h.section_key = $3
          FOR UPDATE OF h
        `, [input.targetInstallationId, input.wikiId, governed?.sourceSectionKey??input.sectionKey])
        const previous = current.rows[0]
        const currentLockVersion = Number(previous?.lock_version ?? 0)
        if (currentLockVersion !== input.expectedLockVersion) {
          throw new WikiManualError('revision_conflict')
        }
        if (previous?.locked) throw new WikiManualError('locked')
        if(governed&&governed.sourceSectionKey!==input.sectionKey) {
          const collision=await client.query('SELECT 1 FROM memory_wiki_manual_section_heads WHERE installation_id=$1 AND wiki_id=$2 AND section_key=$3',
            [input.targetInstallationId,input.wikiId,input.sectionKey])
          if(collision.rowCount)throw new WikiManualError('revision_conflict')
          await client.query('DELETE FROM memory_wiki_manual_section_heads WHERE installation_id=$1 AND wiki_id=$2 AND section_key=$3',
            [input.targetInstallationId,input.wikiId,governed.sourceSectionKey])
        }
        const manualVersionId = randomUUID()
        const contentHash = hash(input.markdown)
        await client.query(`
          INSERT INTO memory_wiki_manual_section_versions
            (manual_version_id, installation_id, wiki_id, section_key, markdown,
             content_hash, actor_scope_kind, actor_scope_id, reason_code,
             previous_version_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [manualVersionId, input.targetInstallationId, input.wikiId,
          input.sectionKey, input.markdown, contentHash, binding.owner_scope_kind,
          binding.owner_scope_id, input.reasonCode ?? null,
          previous?.current_version_id ?? null])
        const next = currentLockVersion + 1
        await client.query(`
          INSERT INTO memory_wiki_manual_section_heads
            (installation_id, wiki_id, section_key, current_version_id, locked, lock_version)
          VALUES ($1, $2, $3, $4, FALSE, $5)
          ON CONFLICT (installation_id, wiki_id, section_key) DO UPDATE
          SET current_version_id = EXCLUDED.current_version_id,
              lock_version = EXCLUDED.lock_version, updated_at = NOW()
        `, [input.targetInstallationId, input.wikiId, input.sectionKey,
          manualVersionId, next])
        const headRevision = await client.query<{ revision: string }>(`
          SELECT revision::text FROM memory_wiki_heads
          WHERE installation_id = $1 AND wiki_id = $2
        `, [input.targetInstallationId, input.wikiId])
        await client.query(`
          INSERT INTO memory_wiki_audit_events
            (audit_id, installation_id, wiki_id, action, result, reason_code,
             old_content_hash, new_content_hash, actor_scope_kind, actor_scope_id,
             head_revision)
          VALUES ($1, $2, $3, 'manual_edit', 'success', $4, $5, $6, $7, $8, $9)
        `, [randomUUID(), input.targetInstallationId, input.wikiId,
          input.reasonCode ?? null, previous?.content_hash ?? null, contentHash,
          binding.owner_scope_kind, binding.owner_scope_id,
          headRevision.rows[0]?.revision ?? null])
          return { manualVersionId, lockVersion: next }
        })
      })
    }
  return {
    edit:(input:ManualActionInput & {markdown:string})=>edit(input),
    /** Domain publication has a real publisher binding; it does not invent a
     * contributor grant just to append the same guarded manual revision. */
    appendGoverned:(input:ManualActionInput & {markdown:string},sourceSectionKey:string)=>edit(input,{sourceSectionKey}),
    lock: (input: ManualActionInput) => observe('lock', () => lockState(input, true)),
    unlock: (input: ManualActionInput) => observe('unlock', () => lockState(input, false)),
  }
}
