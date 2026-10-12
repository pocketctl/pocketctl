export interface ArchiveBinding {
  userId: number
  sessionId: string
  activityEpoch: string
  manifestId: string
  ordinal: number
}
export interface ArchiveEventBody {
  id: string
  eventType: string
  payload: unknown
}
export interface ArchiveChunkManifest extends ArchiveBinding {
  schemaVersion: 1
  codec: 'gzip'
  firstEventId: string
  lastEventId: string
  eventCount: number
  rawBytes: number
  compressedBytes: number
  rawSha256: string
  compressedSha256: string
}
export interface ArchiveLimits {
  maxRawBytes: number
  maxCompressedBytes: number
  maxRecords: number
}
export function assertArchiveBinding(
  actual: ArchiveBinding,
  expected: ArchiveBinding,
): void {
  for (const key of [
    'userId',
    'sessionId',
    'activityEpoch',
    'manifestId',
    'ordinal',
  ] as const) {
    if (actual[key] !== expected[key])
      throw new Error('archive binding mismatch')
  }
}
