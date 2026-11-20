const STREAM_EVENT_TYPES = new Set(['agent_text', 'agent_reasoning', 'tool_result', 'agent_file_change'])

export interface ReplayBoundary {
  endIndex: number
  logicalCount: number
}

interface ReplayStream {
  id: string
  startsAtZero: boolean
  endsAtFinal: boolean
}

function replayStream(payload: any): ReplayStream | null {
  if (!STREAM_EVENT_TYPES.has(payload?.type)) return null
  if (typeof payload?.stream_id !== 'string' || payload.stream_id.length === 0) return null
  if (!Number.isInteger(payload?.chunk_seq) || !Number.isInteger(payload?.byte_offset)) return null
  return {
    id: payload.stream_id,
    startsAtZero: payload.chunk_seq === 0 && payload.byte_offset === 0,
    endsAtFinal: payload.final === true,
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

/** Consumes authorized events newest first. Only a real zero chunk closes a stream. */
export class BackwardReplayScan {
  private readonly seen = new Set<string>()
  private readonly open = new Map<string, number>()
  logicalCount = 0

  consume(rows: any[], limit: number): ReplayBoundary | null {
    for (let index = 0; index < rows.length; index++) {
      const payload = rows[index]?.payload
      const stream = replayStream(payload)
      if (stream) {
        if (!this.seen.has(stream.id)) {
          this.seen.add(stream.id)
          this.open.set(stream.id, payload.chunk_seq)
          this.logicalCount++
        }
        if (stream.startsAtZero) {
          this.open.delete(stream.id)
        } else {
          const previous = this.open.get(stream.id)
          if (previous !== undefined && payload.chunk_seq < previous) this.open.set(stream.id, payload.chunk_seq)
        }
      } else {
        this.logicalCount++
      }

      if (this.logicalCount >= limit && this.open.size === 0) {
        return { endIndex: index, logicalCount: this.logicalCount }
      }
    }
    return null
  }

  streamWithRemainingChunks(minimum: number): string | undefined {
    for (const [id, lowestSequence] of this.open) {
      if (lowestSequence >= minimum) return id
    }
  }
}

export function findCompleteReplayBoundary(rowsDesc: any[], logicalLimit: number): ReplayBoundary | null {
  return new BackwardReplayScan().consume(rowsDesc, logicalLimit)
}

/** Rows arrive oldest first. A stream remains open until its final chunk is seen. */
export function hasOpenForwardReplayStreams(rowsAsc: any[]): boolean {
  const openStreams = new Set<string>()
  for (const row of rowsAsc) {
    const stream = replayStream(row?.payload)
    if (!stream) continue
    openStreams.add(stream.id)
    if (stream.endsAtFinal) openStreams.delete(stream.id)
  }
  return openStreams.size > 0
}

/**
 * Finds the newest row that closes a forward-scanned page. Rows must arrive
 * oldest first. A chunked stream is one logical item and the page cannot end
 * until every stream opened inside it has emitted its final chunk.
 */
export function findCompleteForwardReplayBoundary(rowsAsc: any[], logicalLimit: number): ReplayBoundary | null {
  const seenStreams = new Set<string>()
  const openStreams = new Set<string>()
  let logicalCount = 0

  for (let index = 0; index < rowsAsc.length; index += 1) {
    const stream = replayStream(rowsAsc[index]?.payload)
    if (stream) {
      if (!seenStreams.has(stream.id)) {
        seenStreams.add(stream.id)
        openStreams.add(stream.id)
        logicalCount += 1
      }
      if (stream.endsAtFinal) openStreams.delete(stream.id)
    } else {
      logicalCount += 1
    }

    if (logicalCount >= logicalLimit && openStreams.size === 0) {
      return { endIndex: index, logicalCount }
    }
  }

  return null
}
