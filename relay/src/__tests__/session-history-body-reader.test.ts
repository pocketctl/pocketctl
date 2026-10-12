import { randomUUID } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import { SessionHistoryBodyReader } from '../session-history/body-reader.js'
import { encodeArchiveChunk } from '../session-archive/codec.js'
import {
  MemoryArchiveStorage,
  archiveObjectKey,
} from '../session-archive/storage.js'

const limits = {
  maxRawBytes: 1_000_000,
  maxCompressedBytes: 1_000_000,
  maxRecords: 1000,
}
async function fixture() {
  const binding = {
    userId: 1,
    sessionId: 'session',
    activityEpoch: '2',
    manifestId: randomUUID(),
    ordinal: 0,
  }
  const records = [
    { id: '1', eventType: 'user_text', payload: { text: 'hello' } },
    { id: '2', eventType: 'agent_text', payload: { text: '世界' } },
  ]
  const encoded = await encodeArchiveChunk(binding, records, limits)
  const storage = new MemoryArchiveStorage(),
    key = archiveObjectKey(binding.manifestId, 0)
  await storage.put(key, encoded.bytes)
  const authorize = vi.fn().mockResolvedValue(true),
    read = vi.spyOn(storage, 'read')
  const reader = new SessionHistoryBodyReader({
    storage,
    limits,
    authorize,
    loadManifest: async () => ({
      manifest: encoded.manifest,
      key,
      state: 'published',
    }),
    cacheBytes: 1_000_000,
    cacheTtlMs: 1000,
  })
  const hot = records.map((r) => ({
    ...r,
    sessionId: 'session',
    bodyStorage: 'hot' as const,
  }))
  const cold = records.map((r) => ({
    ...r,
    payload: null,
    sessionId: 'session',
    bodyStorage: 'cold' as const,
    manifestId: binding.manifestId,
    chunkOrdinal: 0,
  }))
  return { reader, hot, cold, authorize, read, storage, key }
}
describe('authorized bounded session body reader', () => {
  test('hot/cold/mixed preserve every body and input ordering; one object request per chunk', async () => {
    const f = await fixture()
    const hot = await f.reader.hydrate({
      userId: 1,
      sessionId: 'session',
      rows: f.hot,
    })
    const cold = await f.reader.hydrate({
      userId: 1,
      sessionId: 'session',
      rows: [...f.cold].reverse(),
    })
    expect(cold.map((r) => r.payload)).toEqual(
      [...hot].reverse().map((r) => r.payload),
    )
    expect(
      (
        await f.reader.hydrate({
          userId: 1,
          sessionId: 'session',
          rows: [f.cold[0], f.hot[1]],
        })
      ).map((r) => r.payload),
    ).toEqual(hot.map((r) => r.payload))
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  test('unauthorized requests cannot trigger reads or use warmed cache', async () => {
    const f = await fixture()
    await f.reader.hydrate({ userId: 1, sessionId: 'session', rows: f.cold })
    f.authorize.mockResolvedValue(false)
    await expect(
      f.reader.hydrate({ userId: 1, sessionId: 'session', rows: f.cold }),
    ).rejects.toThrow('not accessible')
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  test('revocation during object IO prevents sending the already-loaded body', async () => {
    const f = await fixture()
    f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false)
    await expect(
      f.reader.hydrate({ userId: 1, sessionId: 'session', rows: f.cold }),
    ).rejects.toThrow('not accessible')
  })
  test('missing objects and mismatched event headers never become empty history', async () => {
    const f = await fixture()
    await f.storage.delete(f.key)
    await expect(
      f.reader.hydrate({ userId: 1, sessionId: 'session', rows: f.cold }),
    ).rejects.toThrow('missing')
    const g = await fixture()
    await expect(
      g.reader.hydrate({
        userId: 1,
        sessionId: 'session',
        rows: [{ ...g.cold[0], eventType: 'wrong' }],
      }),
    ).rejects.toThrow('header')
  })
  test('cache invalidation reloads and rejects cross-session headers', async () => {
    const f = await fixture()
    await f.reader.hydrate({ userId: 1, sessionId: 'session', rows: f.cold })
    f.reader.invalidate(1, 'session')
    await f.reader.hydrate({ userId: 1, sessionId: 'session', rows: f.cold })
    expect(f.read).toHaveBeenCalledTimes(2)
    await expect(
      f.reader.hydrate({
        userId: 1,
        sessionId: 'session',
        rows: [{ ...f.cold[0], sessionId: 'other' }],
      }),
    ).rejects.toThrow('scope')
  })
})
