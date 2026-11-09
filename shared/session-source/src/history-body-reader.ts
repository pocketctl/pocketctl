import { decodeArchiveChunk } from './archive/codec.js'
import {
  assertArchiveBinding,
  type ArchiveChunkManifest,
  type ArchiveEventBody,
  type ArchiveLimits,
} from './archive/manifest.js'
import {
  archiveObjectKey,
  readArchiveObject,
  type ArchiveReadStorage,
} from './archive/storage.js'

export interface HistoryBodyHead {
  id: string
  sessionId: string
  eventType: string
  bodyStorage: 'hot' | 'cold'
  payload: unknown
  manifestId?: string
  chunkOrdinal?: number
  bodySessionId?: string
  activityEpoch?: string
}
interface Dependencies {
  storage: ArchiveReadStorage
  limits: ArchiveLimits
  authorize(userId: number, sessionId: string): Promise<boolean>
  loadManifest(
    userId: number,
    sessionId: string,
    manifestId: string,
    ordinal: number,
  ): Promise<{
    manifest: ArchiveChunkManifest
    key: string
    state: string
  } | null>
  cacheBytes: number
  cacheTtlMs: number
  pageLimits?: {maxChunks:number;maxRawBytes:number;maxCompressedBytes:number}
}
interface CachedChunk {
  userId: number
  sessionId: string
  expires: number
  bytes: number
  records: ArchiveEventBody[]
}

/** Hydrates already-filtered event heads. Consumers must retain SQL pagination
 * and stream boundaries using head projections before invoking this reader.
 * No existing SQL consumer is declared compatible merely by having this class.
 */
export class SessionHistoryBodyReader {
  private readonly cache = new Map<string, CachedChunk>()
  private cachedBytes = 0
  constructor(private readonly dependencies: Dependencies) {
    if (
      !Number.isSafeInteger(dependencies.cacheBytes) ||
      dependencies.cacheBytes < 0 ||
      dependencies.cacheBytes > 128 * 1024 * 1024 ||
      !Number.isSafeInteger(dependencies.cacheTtlMs) ||
      dependencies.cacheTtlMs < 0 ||
      dependencies.cacheTtlMs > 300_000
    )
      throw new Error('invalid history cache budget')
    const p=dependencies.pageLimits
    if(p&&(![p.maxChunks,p.maxRawBytes,p.maxCompressedBytes].every(v=>Number.isSafeInteger(v)&&v>0)
      ||p.maxChunks>256||p.maxRawBytes>256*1024*1024||p.maxCompressedBytes>128*1024*1024))throw new Error('invalid history page archive budget')
  }
  private remove(key: string): void {
    const item = this.cache.get(key)
    if (item) {
      this.cachedBytes -= item.bytes
      this.cache.delete(key)
    }
  }
  invalidate(userId: number, sessionId: string): void {
    for (const [key, value] of this.cache)
      if (value.userId === userId && value.sessionId === sessionId)
        this.remove(key)
  }
  private async authorize(userId: number, sessionId: string): Promise<void> {
    if (!(await this.dependencies.authorize(userId, sessionId))) {
      this.invalidate(userId, sessionId)
      throw new Error('session history not accessible')
    }
  }
  async hydrate<T extends HistoryBodyHead>(input: {
    userId: number
    sessionId: string
    rows: T[]
  }): Promise<T[]> {
    if (input.rows.length > 1000) throw new Error('history page limit exceeded')
    await this.authorize(input.userId, input.sessionId)
    for (const [key, entry] of this.cache)
      if (entry.expires <= Date.now()) this.remove(key)
    const output = input.rows.map((row) => ({ ...row }))
    const groups = new Map<
      string,
      { manifestId: string; ordinal: number; bodySessionId: string; activityEpoch: string; indexes: number[] }
    >()
    for (let index = 0; index < input.rows.length; index++) {
      const row = input.rows[index]
      if (row.sessionId !== input.sessionId)
        throw new Error('history header scope mismatch')
      if (row.bodyStorage === 'hot') {
        if (row.payload === null || row.payload === undefined)
          throw new Error('hot history body unavailable')
        continue
      }
      if (
        row.bodyStorage !== 'cold' ||
        !row.manifestId || !row.bodySessionId || !row.activityEpoch ||
        !Number.isSafeInteger(row.chunkOrdinal) ||
        row.chunkOrdinal! < 0
      )
        throw new Error('invalid cold history reference')
      const groupKey = `${row.manifestId}:${row.chunkOrdinal}`
      const existing = groups.get(groupKey)
      if (existing) {
        if (existing.activityEpoch !== row.activityEpoch || existing.bodySessionId !== row.bodySessionId) throw new Error('cold history epoch reference mismatch')
        existing.indexes.push(index)
      }
      else
        groups.set(groupKey, {
          manifestId: row.manifestId,
          ordinal: row.chunkOrdinal!,
          bodySessionId: row.bodySessionId!,
          activityEpoch: row.activityEpoch!,
          indexes: [index],
        })
    }
    // Sequential chunk IO is intentional: per-page memory/transfer limits do
    // not grow with the number of referenced objects. Each chunk is bounded.
    let pagePayloadBytes = 0,pageRawBytes=0,pageCompressedBytes=0
    const pageLimits=this.dependencies.pageLimits
    if(pageLimits&&groups.size>pageLimits.maxChunks)throw new Error('history page archive limit exceeded')
    for (const group of groups.values()) {
      const loaded = await this.dependencies.loadManifest(
        input.userId,
        input.sessionId,
        group.manifestId,
        group.ordinal,
      )
      if (!loaded || loaded.state !== 'published')
        throw new Error('published history manifest unavailable')
      const { manifest, key } = loaded
      pageRawBytes+=manifest.rawBytes;pageCompressedBytes+=manifest.compressedBytes
      if(pageLimits&&(!Number.isSafeInteger(manifest.rawBytes)||manifest.rawBytes<=0||!Number.isSafeInteger(manifest.compressedBytes)||manifest.compressedBytes<=0
        ||pageRawBytes>pageLimits.maxRawBytes||pageCompressedBytes>pageLimits.maxCompressedBytes))throw new Error('history page archive limit exceeded')
      assertArchiveBinding(manifest, {
        userId: input.userId,
        sessionId: group.bodySessionId,
        manifestId: group.manifestId,
        ordinal: group.ordinal,
        activityEpoch: group.activityEpoch,
      })
      if (key !== archiveObjectKey(group.manifestId, group.ordinal))
        throw new Error('history object binding mismatch')
      const cacheKey = JSON.stringify([
        input.userId,
        input.sessionId,
        group.manifestId,
        group.bodySessionId,
        manifest.activityEpoch,
        group.ordinal,
        manifest.rawSha256,
      ])
      let records = this.cache.get(cacheKey)?.records
      if (!records) {
        const bytes = await readArchiveObject(
          this.dependencies.storage,
          key,
          this.dependencies.limits.maxCompressedBytes,
        )
        records = await decodeArchiveChunk(
          bytes,
          manifest,
          manifest,
          this.dependencies.limits,
        )
        await this.authorize(input.userId, input.sessionId)
        if (
          this.dependencies.cacheTtlMs > 0 &&
          manifest.rawBytes <= this.dependencies.cacheBytes
        ) {
          while (
            this.cachedBytes + manifest.rawBytes >
              this.dependencies.cacheBytes &&
            this.cache.size
          )
            this.remove(this.cache.keys().next().value!)
          this.cache.set(cacheKey, {
            userId: input.userId,
            sessionId: input.sessionId,
            expires: Date.now() + this.dependencies.cacheTtlMs,
            bytes: manifest.rawBytes,
            records,
          })
          this.cachedBytes += manifest.rawBytes
        }
      }
      await this.authorize(input.userId, input.sessionId)
      const fresh = await this.dependencies.loadManifest(input.userId,input.sessionId,group.manifestId,group.ordinal)
      if(!fresh || fresh.state!=='published' || fresh.key!==key || JSON.stringify(fresh.manifest)!==JSON.stringify(manifest))
        throw new Error('history manifest reference changed')
      const byId = new Map(records.map((record) => [record.id, record]))
      for (const index of group.indexes) {
        const head = output[index],
          record = byId.get(head.id)
        if (!record || record.eventType !== head.eventType)
          throw new Error('cold history header mismatch')
        // Sparse subagent/selector pages may reference many full chunks. Only
        // selected bodies remain in the output; IO and decode stay sequential.
        pagePayloadBytes+=Buffer.byteLength(JSON.stringify(record.payload))
        if(pagePayloadBytes>32*1024*1024)throw new Error('history page byte limit exceeded')
        // Do not hand mutable cached payload references to response processors.
        head.payload = structuredClone(record.payload)
      }
    }
    await this.authorize(input.userId, input.sessionId)
    return output
  }
}
