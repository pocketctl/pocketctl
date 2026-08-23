export interface ContentStreamChunk {
  streamId: string
  sequence: number
  byteOffset: number
  content: string
  final: boolean
  totalBytes?: number
}

export interface ContentStreamUpdate {
  appended: string
  content: string
  changed: boolean
  completed: boolean
  transitionedToComplete: boolean
  incomplete: boolean
  truncated: boolean
  receivedBytes: number
}

interface BufferedChunk {
  byteOffset: number
  content: string
  final: boolean
  totalBytes?: number
}

interface ContentStreamState {
  nextSequence: number
  chunks: Map<number, BufferedChunk>
  content: string
  finalSequence?: number
  finalTotalBytes?: number
  receivedBytes: number
  retainedBytes: number
  truncated: boolean
}

export interface ContentStreamLimits {
  maxBufferedChunksPerStream: number
  maxBufferedBytes: number
  maxActiveStreams: number
  maxCompletedStreams: number
}

export class ContentStreamAssembler {
  private readonly streams = new Map<string, ContentStreamState>()
  private readonly completedStreams = new Set<string>()
  private readonly completedOrder: string[] = []
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly limits: ContentStreamLimits
  private bufferedBytes = 0

  constructor(
    private readonly maxPreviewBytes = 1024 * 1024,
    limits: Partial<ContentStreamLimits> = {},
  ) {
    this.limits = {
      maxBufferedChunksPerStream: Math.max(1, limits.maxBufferedChunksPerStream ?? 64),
      maxBufferedBytes: Math.max(0, limits.maxBufferedBytes ?? 8 * 1024 * 1024),
      maxActiveStreams: Math.max(1, limits.maxActiveStreams ?? 32),
      maxCompletedStreams: Math.max(0, limits.maxCompletedStreams ?? 2048),
    }
  }

  accept(chunk: ContentStreamChunk): ContentStreamUpdate | null {
    if (!chunk.streamId || !Number.isInteger(chunk.sequence) || chunk.sequence < 0) return null
    if (this.completedStreams.has(chunk.streamId)) {
      return {
        appended: '', content: '', changed: false, completed: true,
        transitionedToComplete: false, incomplete: false,
        truncated: false, receivedBytes: 0,
      }
    }

    let state = this.streams.get(chunk.streamId)
    if (!state) {
      if (this.streams.size >= this.limits.maxActiveStreams) return null
      state = {
        nextSequence: 0, chunks: new Map(), content: '',
        receivedBytes: 0, retainedBytes: 0, truncated: false,
      }
    }
    if (chunk.sequence < state.nextSequence) {
      if (chunk.final && chunk.sequence === state.finalSequence) {
        state.finalTotalBytes = chunk.totalBytes
        return this.finishUpdate(chunk.streamId, state, '', false)
      }
      return {
        appended: '', content: state.content, changed: false, completed: false,
        transitionedToComplete: false,
        incomplete: state.finalSequence !== undefined,
        truncated: state.truncated, receivedBytes: state.receivedBytes,
      }
    }

    const existing = state.chunks.get(chunk.sequence)
    if (existing &&
        existing.byteOffset === chunk.byteOffset &&
        existing.content === chunk.content &&
        existing.final === chunk.final &&
        existing.totalBytes === chunk.totalBytes) {
      return this.finishUpdate(chunk.streamId, state, '', false)
    }
    const chunkBytes = this.encoder.encode(chunk.content).length
    const existingBytes = existing ? this.encoder.encode(existing.content).length : 0
    const drainsImmediately = chunk.sequence === state.nextSequence &&
      chunk.byteOffset === state.receivedBytes
    if ((!existing && !drainsImmediately &&
        state.chunks.size >= this.limits.maxBufferedChunksPerStream) ||
        chunkBytes > this.limits.maxBufferedBytes ||
        (!drainsImmediately &&
          this.bufferedBytes - existingBytes + chunkBytes > this.limits.maxBufferedBytes)) {
      return null
    }
    this.bufferedBytes += chunkBytes - existingBytes
    state.chunks.set(chunk.sequence, {
      byteOffset: chunk.byteOffset,
      content: chunk.content,
      final: chunk.final,
      totalBytes: chunk.totalBytes,
    })
    if (chunk.final) {
      state.finalSequence = chunk.sequence
      state.finalTotalBytes = chunk.totalBytes
    }

    let changed = false
    let appended = ''
    while (state.chunks.has(state.nextSequence)) {
      const next = state.chunks.get(state.nextSequence)!
      if (next.byteOffset !== state.receivedBytes) break
      state.chunks.delete(state.nextSequence)
      const bytes = this.encoder.encode(next.content).length
      this.bufferedBytes -= bytes
      state.receivedBytes += bytes
      const retained = this.retainUtf8Prefix(next.content, this.maxPreviewBytes - state.retainedBytes)
      state.content += retained
      appended += retained
      state.retainedBytes += this.encoder.encode(retained).length
      if (retained !== next.content) state.truncated = true
      state.nextSequence += 1
      changed = changed || retained.length > 0
      if (next.final) break
    }

    return this.finishUpdate(chunk.streamId, state, appended, changed)
  }

  reset() {
    this.streams.clear()
    this.completedStreams.clear()
    this.completedOrder.length = 0
    this.bufferedBytes = 0
  }

  private retainUtf8Prefix(content: string, byteLimit: number): string {
    if (byteLimit <= 0 || !content) return ''
    const encoded = this.encoder.encode(content)
    if (encoded.length <= byteLimit) return content
    const firstCandidate = Math.min(byteLimit, encoded.length)
    const lastCandidate = Math.max(0, firstCandidate - 3)
    for (let end = firstCandidate; end >= lastCandidate; end -= 1) {
      try {
        return this.decoder.decode(encoded.subarray(0, end))
      } catch {
        // A UTF-8 code point uses at most four bytes, so a valid boundary is
        // at most three bytes behind an arbitrary preview limit.
      }
    }
    return ''
  }

  private finishUpdate(
    streamId: string,
    state: ContentStreamState,
    appended: string,
    changed: boolean,
  ): ContentStreamUpdate {
    const reachedFinal = state.finalSequence !== undefined &&
      state.nextSequence > state.finalSequence
    const totalMatches = state.finalTotalBytes === undefined ||
      state.finalTotalBytes === state.receivedBytes
    const completed = reachedFinal && totalMatches
    const update: ContentStreamUpdate = {
      appended,
      content: state.content,
      changed,
      completed,
      transitionedToComplete: completed,
      incomplete: state.finalSequence !== undefined && !completed,
      truncated: state.truncated,
      receivedBytes: state.receivedBytes,
    }
    if (completed) {
      for (const pending of state.chunks.values()) {
        this.bufferedBytes -= this.encoder.encode(pending.content).length
      }
      this.streams.delete(streamId)
      this.rememberCompleted(streamId)
    } else {
      this.streams.set(streamId, state)
    }
    return update
  }

  private rememberCompleted(streamId: string) {
    if (this.limits.maxCompletedStreams === 0) return
    this.completedStreams.add(streamId)
    this.completedOrder.push(streamId)
    while (this.completedOrder.length > this.limits.maxCompletedStreams) {
      const expired = this.completedOrder.shift()
      if (expired !== undefined) this.completedStreams.delete(expired)
    }
  }
}
