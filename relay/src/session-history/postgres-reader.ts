import { AsyncLocalStorage } from 'node:async_hooks'
import type pg from 'pg'
import type { ArchiveLimits, ArchiveChunkManifest } from '../session-archive/manifest.js'
import type { ArchiveStorage } from '../session-archive/storage.js'
import { SessionHistoryBodyReader, type HistoryBodyHead } from './body-reader.js'

export const EVENT_BODY_COLUMNS = 'body_storage, body_manifest_id, body_chunk_ordinal, body_owner_user_id, body_activity_epoch'
interface HistoryScope { userId: number; authorize?: () => Promise<boolean> }
const scopeContext = new AsyncLocalStorage<HistoryScope>()
export function withSessionHistoryScope<T>(scope: HistoryScope, work: () => T): T {
  return scopeContext.run(scope, work)
}
type Queryable = Pick<pg.Pool, 'query'>
const readers = new WeakMap<Queryable, SessionHistoryBodyReader>()
export function invalidatePostgresHistoryBodies(db:Queryable,userId:number,sessionId:string):void{
  readers.get(db)?.invalidate(userId,sessionId)
}

export function installPostgresHistoryBodyReader(db: Queryable, storage: ArchiveStorage, limits: ArchiveLimits): SessionHistoryBodyReader {
  const reader = new SessionHistoryBodyReader({
    storage, limits, cacheBytes: 16 * 1024 * 1024, cacheTtlMs: 30_000,
    async authorize(userId, sessionId) {
      const context = scopeContext.getStore()
      if (context && (context.userId !== userId || (context.authorize && !await context.authorize()))) return false
      const result = await db.query(`SELECT 1 FROM sessions s JOIN daemons d ON d.daemon_id=s.daemon_id
        WHERE s.session_id=$1 AND s.user_id=$2 AND d.user_id=$2
          AND s.content_state NOT IN ('deleting','deleted')
          AND NOT EXISTS (SELECT 1 FROM deleted_sessions t WHERE t.session_id=s.session_id)`, [sessionId,userId])
      return result.rows.length === 1
    },
    async loadManifest(userId, sessionId, manifestId, ordinal) {
      const result = await db.query(`SELECT m.user_id,m.session_id,m.activity_epoch::text,m.manifest_id::text,m.schema_version,m.codec,m.state,m.storage_namespace,
        c.ordinal,c.object_key,c.first_event_id::text,c.last_event_id::text,c.event_count,c.raw_bytes::text,c.compressed_bytes::text,
        c.raw_sha256,c.compressed_sha256 FROM session_archive_manifests m JOIN session_archive_chunks c USING(manifest_id)
        WHERE m.manifest_id=$1 AND m.user_id=$2 AND m.session_id=$3 AND c.ordinal=$4`, [manifestId,userId,sessionId,ordinal])
      const row = result.rows[0]
      if (!row) return null
      if (storage.namespace && row.storage_namespace !== storage.namespace) throw new Error('history storage namespace mismatch')
      const manifest: ArchiveChunkManifest = {
        userId: row.user_id, sessionId: row.session_id, activityEpoch: row.activity_epoch,
        manifestId: row.manifest_id, ordinal: row.ordinal, schemaVersion: row.schema_version, codec: row.codec,
        firstEventId: row.first_event_id, lastEventId: row.last_event_id, eventCount: row.event_count,
        rawBytes: Number(row.raw_bytes), compressedBytes: Number(row.compressed_bytes),
        rawSha256: row.raw_sha256, compressedSha256: row.compressed_sha256,
      }
      return { manifest, key: row.object_key, state: row.state }
    },
  })
  readers.set(db, reader)
  return reader
}

/** All SQL pagination/filtering remains on stable event heads. No fabricated
 * empty object is returned when cold configuration or a referenced object fails. */
export async function hydratePostgresEventRows<T extends Record<string, any>>(db: Queryable, sessionId: string, rows: T[]): Promise<T[]> {
  const reader = readers.get(db)
  if (!reader) {
    if (rows.some(row => row.body_storage === 'cold' || row.payload == null)) throw new Error('history body reader not configured')
    return rows
  }
  const scope = scopeContext.getStore()
  if (!scope || !Number.isSafeInteger(scope.userId) || scope.userId < 1) throw new Error('authenticated history scope required')
  for (const row of rows) {
    if (row.session_id !== undefined && row.session_id !== sessionId) throw new Error('history header scope mismatch')
    if (row.body_storage === 'cold' && row.body_owner_user_id !== scope.userId) throw new Error('session history not accessible')
  }
  const result: T[] = []
  // Keep per-reader bounds even for legacy all-event callers. Their response
  // budget/streaming is an independent caller concern, never one huge cold IO.
  for (let offset = 0; offset < rows.length; offset += 256) {
    const batch = rows.slice(offset,offset+256)
    const heads: HistoryBodyHead[] = batch.map(row => ({
      id: String(row.id ?? row.event_id), sessionId, eventType: row.event_type,
      bodyStorage: row.body_storage ?? 'hot', payload: row.payload,
      manifestId: row.body_manifest_id ?? undefined, chunkOrdinal: row.body_chunk_ordinal ?? undefined,
      activityEpoch: row.body_activity_epoch == null ? undefined : String(row.body_activity_epoch),
    }))
    const hydrated = await reader.hydrate({ userId: scope.userId, sessionId, rows: heads })
    result.push(...batch.map((row,index) => ({ ...row,payload:hydrated[index].payload })))
  }
  // Empty histories are still authorized; absence of rows is not an auth bypass.
  if (!rows.length) await reader.hydrate({userId:scope.userId,sessionId,rows:[]})
  return result
}
