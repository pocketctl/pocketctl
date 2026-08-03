const STREAM_EVENT_TYPES = new Set(['agent_text', 'agent_reasoning', 'tool_result', 'agent_file_change'])

export interface ReplayBoundary {
  endIndex: number
  logicalCount: number
}

interface ReplayStream {
  id: string
  startsAtZero: boolean
}

function replayStream(payload: any): ReplayStream | null {
  if (!STREAM_EVENT_TYPES.has(payload?.type)) return null
  if (typeof payload?.stream_id !== 'string' || payload.stream_id.length === 0) return null
  if (!Number.isInteger(payload?.chunk_seq) || !Number.isInteger(payload?.byte_offset)) return null
  return {
    id: payload.stream_id,
    startsAtZero: payload.chunk_seq === 0 && payload.byte_offset === 0,
  }
}

export function countReplayLogicalItems(rows: any[]): number {
  const seenStreams = new Set<string>()
  let logicalCount = 0
  for (const row of rows) {
    const stream = replayStream(row?.payload)
    if (stream) {
      if (seenStreams.has(stream.id)) continue
      seenStreams.add(stream.id)
    }
    logicalCount += 1
  }
  return logicalCount
}

/** Rows arrive newest first. A stream remains open until its zero chunk is seen. */
export function hasOpenReplayStreams(rowsDesc: any[]): boolean {
  const openStreams = new Set<string>()
  for (const row of rowsDesc) {
    const stream = replayStream(row?.payload)
    if (!stream) continue
    openStreams.add(stream.id)
    if (stream.startsAtZero) openStreams.delete(stream.id)
  }
  return openStreams.size > 0
}

/**
 * Finds the oldest row that closes a backwards-scanned page. Rows must arrive
 * newest first. A chunked stream is one logical item and is only complete once
 * the scan reaches its zero chunk.
 */
export function findCompleteReplayBoundary(rowsDesc: any[], logicalLimit: number): ReplayBoundary | null {
  const seenStreams = new Set<string>()
  const openStreams = new Set<string>()
  let logicalCount = 0

  for (let index = 0; index < rowsDesc.length; index += 1) {
    const stream = replayStream(rowsDesc[index]?.payload)
    if (stream) {
      if (!seenStreams.has(stream.id)) {
        seenStreams.add(stream.id)
        openStreams.add(stream.id)
        logicalCount += 1
      }
      if (stream.startsAtZero) openStreams.delete(stream.id)
    } else {
      logicalCount += 1
    }

    if (logicalCount >= logicalLimit && openStreams.size === 0) {
      return { endIndex: index, logicalCount }
    }
  }

  return null
}
