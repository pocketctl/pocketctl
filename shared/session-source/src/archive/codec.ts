import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import {
  assertArchiveBinding,
  type ArchiveBinding,
  type ArchiveChunkManifest,
  type ArchiveEventBody,
  type ArchiveLimits,
} from './manifest.js'

export function archiveSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function validateLimits(limits: ArchiveLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 128 * 1024 * 1024)
      throw new Error('invalid archive limit')
  }
  if (limits.maxRecords > 10_000)
    throw new Error('invalid archive record limit')
}
function sink(maximum: number) {
  let size = 0
  const chunks: Buffer[] = []
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > maximum) {
        callback(new Error('archive byte limit exceeded'))
        return
      }
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  return { writable, bytes: () => Buffer.concat(chunks, size) }
}
function assertRecords(
  records: ArchiveEventBody[],
  limits: ArchiveLimits,
): void {
  if (records.length === 0 || records.length > limits.maxRecords)
    throw new Error('archive record limit exceeded')
  let previous = 0n
  for (const row of records) {
    if (
      !row ||
      typeof row.id !== 'string' ||
      !/^[1-9]\d*$/.test(row.id) ||
      BigInt(row.id) > 9223372036854775807n ||
      BigInt(row.id) <= previous
    )
      throw new Error('archive event order invalid')
    if (
      typeof row.eventType !== 'string' ||
      !row.eventType ||
      row.eventType.length > 64 ||
      row.payload === undefined
    )
      throw new Error('archive event body invalid')
    previous = BigInt(row.id)
  }
}

export async function encodeArchiveChunk(
  binding: ArchiveBinding,
  records: ArchiveEventBody[],
  limits: ArchiveLimits,
): Promise<{ bytes: Buffer; manifest: ArchiveChunkManifest }> {
  validateLimits(limits)
  assertRecords(records, limits)
  const hash = createHash('sha256')
  let rawBytes = 0
  function* lines() {
    for (const value of [
      { schemaVersion: 1, codec: 'gzip', ...binding },
      ...records,
    ]) {
      const bytes = Buffer.from(JSON.stringify(value) + '\n')
      rawBytes += bytes.length
      if (rawBytes > limits.maxRawBytes)
        throw new Error('archive byte limit exceeded')
      hash.update(bytes)
      yield bytes
    }
  }
  const compressed = sink(limits.maxCompressedBytes)
  await pipeline(Readable.from(lines()), createGzip(), compressed.writable)
  const bytes = compressed.bytes()
  return {
    bytes,
    manifest: {
      ...binding,
      schemaVersion: 1,
      codec: 'gzip',
      firstEventId: records[0].id,
      lastEventId: records.at(-1)!.id,
      eventCount: records.length,
      rawBytes,
      compressedBytes: bytes.length,
      rawSha256: hash.digest('hex'),
      compressedSha256: archiveSha256(bytes),
    },
  }
}

export async function decodeArchiveChunk(
  bytes: Buffer,
  manifest: ArchiveChunkManifest,
  expected: ArchiveBinding,
  limits: ArchiveLimits,
): Promise<ArchiveEventBody[]> {
  validateLimits(limits)
  if (manifest.schemaVersion !== 1 || manifest.codec !== 'gzip')
    throw new Error('unsupported archive format')
  assertArchiveBinding(manifest, expected)
  if (
    !Number.isSafeInteger(manifest.rawBytes) ||
    manifest.rawBytes <= 0 ||
    manifest.rawBytes > limits.maxRawBytes ||
    bytes.length > limits.maxCompressedBytes ||
    manifest.eventCount > limits.maxRecords
  )
    throw new Error('archive byte limit exceeded')
  if (
    bytes.length !== manifest.compressedBytes ||
    archiveSha256(bytes) !== manifest.compressedSha256
  )
    throw new Error('archive compressed integrity failed')
  const uncompressed = sink(limits.maxRawBytes)
  await pipeline(Readable.from([bytes]), createGunzip(), uncompressed.writable)
  const raw = uncompressed.bytes()
  if (
    raw.length !== manifest.rawBytes ||
    archiveSha256(raw) !== manifest.rawSha256
  )
    throw new Error('archive raw integrity failed')
  // A verified UTF-8 body must round trip. Node's replacement decoder must not
  // silently repair damaged bytes into different conversation content.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  if (!text.endsWith('\n')) throw new Error('archive truncated records')
  const lines = text.slice(0, -1).split('\n', limits.maxRecords + 2)
  if (lines.length > limits.maxRecords + 1)
    throw new Error('archive record limit exceeded')
  const header = JSON.parse(lines.shift()!)
  if (header.schemaVersion !== 1 || header.codec !== 'gzip')
    throw new Error('unsupported archive format')
  assertArchiveBinding(header, expected)
  const records: ArchiveEventBody[] = lines.map((line) => JSON.parse(line))
  assertRecords(records, limits)
  if (
    records.length !== manifest.eventCount ||
    records[0].id !== manifest.firstEventId ||
    records.at(-1)!.id !== manifest.lastEventId
  )
    throw new Error('archive range integrity failed')
  return records
}
