import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import {
  encodeArchiveChunk,
  decodeArchiveChunk,
} from '../session-archive/codec.js'
import {
  MemoryArchiveStorage,
  readArchiveObject,
  archiveObjectKey,
} from '../session-archive/storage.js'

const binding = {
  userId: 1,
  sessionId: 'session-private',
  activityEpoch: '5',
  manifestId: randomUUID(),
  ordinal: 0,
}
const limits = {
  maxRawBytes: 1024 * 1024,
  maxCompressedBytes: 1024 * 1024,
  maxRecords: 1000,
}
const events = [
  {
    id: '9007199254740993',
    eventType: 'user_text',
    payload: { text: '中文与🙂' },
  },
  {
    id: '9007199254740994',
    eventType: 'tool_result',
    payload: {
      output: 'x'.repeat(200_000),
      binary: Buffer.from([0, 1, 255]).toString('base64'),
    },
  },
]
describe('versioned bounded session archive', () => {
  test('round trip preserves exact event IDs, order, Unicode and JSON body', async () => {
    const encoded = await encodeArchiveChunk(binding, events, limits)
    expect(
      await decodeArchiveChunk(
        encoded.bytes,
        encoded.manifest,
        binding,
        limits,
      ),
    ).toEqual(events)
    expect(encoded.manifest.rawBytes).toBeGreaterThan(
      encoded.manifest.compressedBytes,
    )
  })
  test('truncation, corruption and mismatched authorization binding never return fake history', async () => {
    const encoded = await encodeArchiveChunk(binding, events, limits)
    await expect(
      decodeArchiveChunk(
        encoded.bytes.subarray(0, -1),
        encoded.manifest,
        binding,
        limits,
      ),
    ).rejects.toThrow()
    const bad = Buffer.from(encoded.bytes)
    bad[20] ^= 1
    await expect(
      decodeArchiveChunk(bad, encoded.manifest, binding, limits),
    ).rejects.toThrow()
    await expect(
      decodeArchiveChunk(
        encoded.bytes,
        encoded.manifest,
        { ...binding, userId: 2 },
        limits,
      ),
    ).rejects.toThrow('binding')
    await expect(
      decodeArchiveChunk(
        encoded.bytes,
        { ...encoded.manifest, codec: 'unknown' } as any,
        binding,
        limits,
      ),
    ).rejects.toThrow('format')
  })
  test('decompression cap holds even for dishonest manifest lengths and correct compressed hash', async () => {
    const encoded = await encodeArchiveChunk(binding, [events[0]], limits)
    const bomb = gzipSync('x'.repeat(2 * 1024 * 1024))
    await expect(
      decodeArchiveChunk(
        bomb,
        {
          ...encoded.manifest,
          compressedBytes: bomb.length,
          compressedSha256: createHash('sha256').update(bomb).digest('hex'),
        },
        binding,
        limits,
      ),
    ).rejects.toThrow('limit')
  })
  test('encoding enforces bytes, ordered IDs and record count', async () => {
    await expect(
      encodeArchiveChunk(binding, events, { ...limits, maxRawBytes: 100 }),
    ).rejects.toThrow('limit')
    await expect(
      encodeArchiveChunk(binding, [...events].reverse(), limits),
    ).rejects.toThrow('order')
    await expect(
      encodeArchiveChunk(binding, events, { ...limits, maxRecords: 1 }),
    ).rejects.toThrow('limit')
  })
  test('opaque object names and idempotent deletion, unavailable objects fail explicitly', async () => {
    const storage = new MemoryArchiveStorage()
    const encoded = await encodeArchiveChunk(binding, events, limits)
    const key = archiveObjectKey(binding.manifestId, binding.ordinal)
    expect(key).not.toContain(binding.sessionId)
    await storage.put(key, encoded.bytes)
    expect(
      await readArchiveObject(storage, key, limits.maxCompressedBytes),
    ).toEqual(encoded.bytes)
    await expect(readArchiveObject(storage, key, 10)).rejects.toThrow('limit')
    await storage.delete(key)
    await storage.delete(key)
    await expect(
      readArchiveObject(storage, key, limits.maxCompressedBytes),
    ).rejects.toThrow('missing')
  })
})
