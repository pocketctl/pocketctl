import { describe, expect, test } from 'vitest'
import { countReplayLogicalItems, findCompleteReplayBoundary, hasOpenReplayStreams } from '../replay-page.js'

function streamedRow(id: number, streamId: string, sequence: number) {
  return {
    id,
    payload: {
      type: 'agent_text',
      stream_id: streamId,
      chunk_seq: sequence,
      byte_offset: sequence,
      final: sequence === 77,
    },
  }
}

function fileChangeStreamedRow(id: number, sequence: number) {
  return {
    id,
    payload: {
      type: 'agent_file_change',
      stream_id: 'file-change-stream',
      chunk_seq: sequence,
      byte_offset: sequence * 10,
      diff: `chunk-${sequence}`,
      final: sequence === 2,
    },
  }
}

describe('agent_file_change replay streams', () => {
  test('counts all chunks as one logical item', () => {
    const rows = [
      fileChangeStreamedRow(4, 2),
      fileChangeStreamedRow(3, 1),
      fileChangeStreamedRow(2, 0),
      { id: 1, payload: { type: 'user_text', text: 'older' } },
    ]

    expect(countReplayLogicalItems(rows)).toBe(2)
  })

  test('remains open until the zero chunk appears', () => {
    expect(hasOpenReplayStreams([
      fileChangeStreamedRow(3, 2),
      fileChangeStreamedRow(2, 1),
    ])).toBe(true)
    expect(hasOpenReplayStreams([
      fileChangeStreamedRow(3, 2),
      fileChangeStreamedRow(2, 1),
      fileChangeStreamedRow(1, 0),
    ])).toBe(false)
  })

  test('extends a page through chunk zero after reaching the logical limit', () => {
    const rows = [
      fileChangeStreamedRow(5, 2),
      { id: 4, payload: { type: 'tool_call', call_id: 'call-1' } },
      fileChangeStreamedRow(3, 1),
      fileChangeStreamedRow(2, 0),
      { id: 1, payload: { type: 'user_text', text: 'older' } },
    ]

    expect(findCompleteReplayBoundary(rows, 2)).toEqual({
      endIndex: 3,
      logicalCount: 2,
    })
  })
})

describe('findCompleteReplayBoundary', () => {
  test('extends a logical page backward to chunk zero', () => {
    const rows = Array.from({ length: 78 }, (_, index) => streamedRow(1000 - index, 'stream-a', 77 - index))

    expect(findCompleteReplayBoundary(rows, 1)).toEqual({
      endIndex: 77,
      logicalCount: 1,
    })
  })

  test('does not end a page while a stream has not reached chunk zero', () => {
    const rows = Array.from({ length: 50 }, (_, index) => streamedRow(1000 - index, 'stream-a', 77 - index))

    expect(findCompleteReplayBoundary(rows, 1)).toBeNull()
  })

  test('counts an interleaved non-stream event without dropping it from the contiguous page', () => {
    const rows = [
      streamedRow(5, 'stream-a', 2),
      { id: 4, payload: { type: 'tool_call', call_id: 'call-1' } },
      streamedRow(3, 'stream-a', 1),
      streamedRow(2, 'stream-a', 0),
      { id: 1, payload: { type: 'user_text', text: 'older' } },
    ]

    expect(findCompleteReplayBoundary(rows, 2)).toEqual({
      endIndex: 3,
      logicalCount: 2,
    })
  })

  test('stops after the requested number of complete streams', () => {
    const rows = [
      streamedRow(6, 'stream-b', 1),
      streamedRow(5, 'stream-b', 0),
      streamedRow(4, 'stream-a', 1),
      streamedRow(3, 'stream-a', 0),
      { id: 2, payload: { type: 'user_text', text: 'older' } },
    ]

    expect(findCompleteReplayBoundary(rows, 2)).toEqual({
      endIndex: 3,
      logicalCount: 2,
    })
  })

  test('counts legacy events one at a time', () => {
    const rows = [
      { id: 3, payload: { type: 'agent_text', text: 'newest' } },
      { id: 2, payload: { type: 'tool_call', call_id: 'call-1' } },
      { id: 1, payload: { type: 'user_text', text: 'oldest' } },
    ]

    expect(findCompleteReplayBoundary(rows, 2)).toEqual({
      endIndex: 1,
      logicalCount: 2,
    })
  })

  test('counts a partial stream once when a scan reaches the oldest event', () => {
    const rows = [
      streamedRow(3, 'stream-a', 2),
      streamedRow(2, 'stream-a', 1),
      { id: 1, payload: { type: 'tool_call', call_id: 'call-1' } },
    ]

    expect(countReplayLogicalItems(rows)).toBe(2)
  })
})

describe('hasOpenReplayStreams', () => {
  test('only reports a stream whose zero chunk is absent', () => {
    expect(hasOpenReplayStreams([
      streamedRow(3, 'complete', 2),
      streamedRow(2, 'complete', 1),
      streamedRow(1, 'complete', 0),
    ])).toBe(false)
    expect(hasOpenReplayStreams([
      streamedRow(3, 'partial', 2),
      streamedRow(2, 'partial', 1),
    ])).toBe(true)
    expect(hasOpenReplayStreams([
      { id: 1, payload: { type: 'user_text', text: 'only one row' } },
    ])).toBe(false)
  })
})
