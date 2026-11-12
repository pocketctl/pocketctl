import type pg from 'pg'
import { canonicalJsonString } from '@pocketctl/session-source'
import { prepareSourceReferences, preparedSourceUnavailable } from './prepared-sources.js'

const references = `SELECT source_event_id::text FROM source_events
  WHERE installation_id=$1 AND session_id=$2
  ORDER BY occurred_at DESC,source_event_id DESC LIMIT 4097`
const repositoryPrefixSize = 48

/** Applicability discovery, never a grant. Resolve exact stored source UUIDs
 * before BEGIN and fail closed when a bounded current observation is unprovable. */
export async function sharedSessionRepository(pool: pg.Pool, installationId: string, sessionId: string): Promise<string | null> {
  const ids = (await pool.query(references, [installationId, sessionId])).rows.map(row => row.source_event_id as string)
  if (!ids.length || ids.length > 4096) return null
  try {
    // A fact in this newest prefix wins over every older observation,
    // regardless of event type. Preserve the full lookup when no prefix fact
    // maps to a registered repository.
    const prefix = ids.slice(0, repositoryPrefixSize)
    const match = await resolveRepository(pool, installationId, sessionId, ids, prefix)
    if (match || prefix.length === ids.length) return match
    return await resolveRepository(pool, installationId, sessionId, ids, ids)
  } catch (error) {
    if (preparedSourceUnavailable(error)) return null
    throw error
  }
}

async function resolveRepository(
  pool: pg.Pool, installationId: string, sessionId: string, orderedIds: string[], selectedIds: string[],
): Promise<string | null> {
  const prepared = await prepareSourceReferences(pool, installationId, selectedIds)
  const byId = new Map(prepared.events.map(event => [event.source_event_id, event]))
  const keys = selectedIds.map(id => byId.get(id)?.payload.repository_id)
    .filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= 2048)
  if (!keys.length) return null

  const client = await pool.connect()
  try {
    // PostgreSQL requires a regular transaction for metadata FOR SHARE.
    // This path executes no DML and canonical bodies were resolved above.
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'")
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:session:'||$1||':'||$2,0))", [installationId, sessionId])
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))", [installationId])
    await prepared.assertCurrent(client)
    const current = (await client.query(references, [installationId, sessionId])).rows.map(row => row.source_event_id)
    if (canonicalJsonString(current) !== canonicalJsonString(orderedIds)) throw Error('source_reference_changed')
    const repositories = (await client.query<{ repository_id: string; repository_key: string }>(`
      SELECT repository_id::text, repository_key FROM repositories
      WHERE installation_id=$1 AND repository_key=ANY($2::text[])
    `, [installationId, keys])).rows
    const match = keys.map(key => repositories.find(row => row.repository_key === key)).find(Boolean)?.repository_id ?? null
    await prepared.assertCurrent(client, { forCommit: true })
    await client.query('COMMIT')
    return match
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
