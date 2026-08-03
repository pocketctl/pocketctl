import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createAgentFileChangeReducer, type AgentFileChangeMessage } from '../agentFileChange'

const fixture = JSON.parse(readFileSync(
  resolve(process.cwd(), '../testdata/contracts/agent_file_change_turn.json'),
  'utf8',
)) as { events: Array<Record<string, unknown>> }

function completed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'agent_file_change',
    session_id: 'ses_1',
    turn_id: 'turn_1',
    seq: 20,
    event_id: 'event-1',
    change_set_id: 'native:call_1',
    change_index: 0,
    change_total: 1,
    path: 'src/a.ts',
    change_kind: 'update',
    diff: '@@ -1 +1 @@\n-old\n+new\n',
    additions: 1,
    deletions: 1,
    status: 'completed',
    ...overrides,
  }
}

function card(target: AgentFileChangeMessage[]) {
  return target[0].fileChange
}

describe('createAgentFileChangeReducer', () => {
  test('aggregates the shared two-file fixture into one turn card', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()

    expect(reducer.accept(fixture.events[0], target)).toBe('inserted')
    expect(reducer.accept(fixture.events[1], target)).toBe('updated')

    expect(target).toHaveLength(1)
    expect(card(target)).toMatchObject({
      turnId: 'turn_contract', additions: 3, deletions: 1, selectedPath: 'a.txt',
    })
    expect(card(target).files.map(file => file.path)).toEqual(['a.txt', 'b.txt'])
  })

  test('keeps two change sets for the same path as ordered edit history', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()

    reducer.accept(completed({ event_id: 'later', change_set_id: 'native:later', seq: 30 }), target)
    reducer.accept(completed({ event_id: 'earlier', change_set_id: 'native:earlier', seq: 10 }), target)

    expect(card(target).files).toHaveLength(1)
    expect(card(target).files[0].edits.map(edit => edit.eventId)).toEqual(['earlier', 'later'])
    expect(card(target)).toMatchObject({ additions: 2, deletions: 2 })
  })

  test('derives file metadata from the last deterministic edit instead of arrival order', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()

    reducer.accept(completed({
      event_id: 'later-delete', change_set_id: 'native:later', seq: 30,
      change_kind: 'delete', move_path: undefined,
    }), target)
    reducer.accept(completed({
      event_id: 'earlier-move', change_set_id: 'native:earlier', seq: 10,
      change_kind: 'move', move_path: 'src/old-a.ts',
    }), target)

    expect(card(target).files[0]).toMatchObject({ kind: 'delete', movePath: undefined })
  })

  test('includes streamed edits when deriving deterministic file metadata', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()
    reducer.accept(completed({ event_id: 'first-update', seq: 10 }), target)

    reducer.accept(completed({
      event_id: 'later-move', stream_id: 'stream-move', streaming: true,
      chunk_seq: 0, byte_offset: 0, final: true, total_bytes: 3,
      content_hash: 'b5d4045c3f466fa91fe2cc6abe79232a', diff: 'ABC',
      change_set_id: 'native:later', seq: 20, change_kind: 'move', move_path: 'src/renamed.ts',
    }), target)

    expect(card(target).files[0]).toMatchObject({ kind: 'move', movePath: 'src/renamed.ts' })
  })

  test('deduplicates completed event IDs across live and replay delivery', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()
    const event = completed()

    expect(reducer.accept(event, target)).toBe('inserted')
    expect(reducer.accept({ ...event }, target)).toBe('ignored')
    expect(card(target)).toMatchObject({ additions: 1, deletions: 1 })
    expect(card(target).files[0].edits).toHaveLength(1)
  })

  test('reorders delayed lower relay sequences deterministically', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()

    reducer.accept(completed({ event_id: 'b', path: 'b.ts', seq: 200 }), target)
    reducer.accept(completed({ event_id: 'a', path: 'a.ts', seq: 100 }), target)

    expect(card(target).files.map(file => file.path)).toEqual(['a.ts', 'b.ts'])
  })

  test('orders one change set by change index even when relay sequences disagree', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()

    reducer.accept(completed({ event_id: 'index-1', seq: 10, change_index: 1, change_total: 2 }), target)
    reducer.accept(completed({ event_id: 'index-0', seq: 20, change_index: 0, change_total: 2 }), target)

    expect(card(target).files[0].edits.map(edit => edit.eventId)).toEqual(['index-0', 'index-1'])
  })

  test('uses first-arrival order as the fallback when relay sequence is absent', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()

    reducer.accept(completed({ event_id: 'arrived-first', seq: undefined, change_set_id: 'native:first' }), target)
    reducer.accept(completed({ event_id: 'arrived-second', seq: undefined, change_set_id: 'native:second' }), target)

    expect(card(target).files[0].edits.map(edit => edit.eventId)).toEqual(['arrived-first', 'arrived-second'])
  })

  test.each([
    ['turn', { turn_id: '' }],
    ['whitespace turn', { turn_id: '   ' }],
    ['path', { path: '' }],
    ['change set', { change_set_id: '   ' }],
    ['kind', { change_kind: 'copy' }],
    ['total', { change_total: 0 }],
    ['negative index', { change_index: -1 }],
    ['index beyond total', { change_index: 1 }],
  ])('fails closed for invalid %s', (_name, override) => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()

    expect(reducer.accept(completed(override), target)).toBe('ignored')
    expect(target).toEqual([])
  })

  test('upserts a stream by stream ID and finalizes it to one event ID without recounting stats', async () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()
    const base = completed({ event_id: undefined, stream_id: 'stream-1', streaming: true, diff: '', additions: 2, deletions: 1 })

    expect(reducer.accept({
      ...base, chunk_seq: 0, byte_offset: 0, final: false, diff: 'AB',
    }, target)).toBe('inserted')
    expect(card(target)).toMatchObject({ additions: 2, deletions: 1 })
    expect(card(target).files[0].edits[0]).toMatchObject({ streamId: 'stream-1', diff: 'AB', integrity: 'streaming' })

    expect(reducer.accept({
      ...base, event_id: 'event-final', chunk_seq: 1, byte_offset: 2,
      final: true, total_bytes: 3, content_hash: 'b5d4045c3f466fa91fe2cc6abe79232a', diff: 'C',
    }, target)).toBe('updated')
    expect(card(target)).toMatchObject({ additions: 2, deletions: 1 })
    expect(card(target).files[0].edits).toHaveLength(1)
    expect(card(target).files[0].edits[0]).toMatchObject({
      eventId: 'event-final', streamId: undefined, diff: 'ABC', integrity: 'verifying',
    })
    await vi.waitFor(() => expect(card(target).files[0].edits[0].integrity).toBe('complete'))
  })

  test('fails a completed stream closed when its stable event ID is missing', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()

    expect(reducer.accept(completed({
      event_id: undefined, stream_id: 'stream-no-event', streaming: true,
      chunk_seq: 0, byte_offset: 0, final: true, total_bytes: 3,
      content_hash: 'b5d4045c3f466fa91fe2cc6abe79232a', diff: 'ABC',
    }), target)).toBe('inserted')
    expect(card(target).files[0].edits[0]).toMatchObject({ integrity: 'failed', diff: '' })
  })

  test('assembles out-of-order chunks and reports truncated and digest-failed previews honestly', async () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()
    const base = completed({ event_id: undefined, stream_id: 'stream-order', streaming: true, diff: '' })

    reducer.accept({
      ...base, event_id: 'ordered-final', chunk_seq: 2, byte_offset: 2,
      final: true, total_bytes: 3, content_hash: 'b5d4045c3f466fa91fe2cc6abe79232a', diff: 'C',
    }, target)
    reducer.accept({ ...base, chunk_seq: 0, byte_offset: 0, final: false, diff: 'A' }, target)
    reducer.accept({ ...base, chunk_seq: 1, byte_offset: 1, final: false, diff: 'B' }, target)
    await vi.waitFor(() => expect(card(target).files[0].edits[0].integrity).toBe('complete'))
    expect(card(target).files[0].edits[0].diff).toBe('ABC')

    const oversized = 'x'.repeat(8 * 1024 * 1024 + 1)
    reducer.accept(completed({
      event_id: 'truncated-final', stream_id: 'stream-large', streaming: true,
      chunk_seq: 0, byte_offset: 0, final: true, total_bytes: oversized.length,
      content_hash: 'ignored-for-truncated-preview', path: 'large.txt', diff: oversized,
    }), target)
    expect(card(target).files.find(file => file.path === 'large.txt')?.edits[0]).toMatchObject({
      integrity: 'truncated',
    })

    reducer.accept(completed({
      event_id: 'bad-final', stream_id: 'stream-bad', streaming: true,
      chunk_seq: 0, byte_offset: 0, final: true, total_bytes: 3,
      content_hash: '00000000000000000000000000000000', path: 'bad.txt', diff: 'ABC',
    }), target)
    await vi.waitFor(() => expect(
      card(target).files.find(file => file.path === 'bad.txt')?.edits[0].integrity,
    ).toBe('failed'))
    expect(card(target).files.find(file => file.path === 'bad.txt')?.edits[0].diff).toBe('')
  })

  test('resetting transient streams preserves completed cards', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()
    reducer.accept(completed(), target)

    reducer.resetTransientStreams()

    expect(target).toHaveLength(1)
    expect(card(target).files[0].edits[0]).toMatchObject({ eventId: 'event-1', integrity: 'complete' })
  })

  test('resetting transient streams removes incomplete edits and their counted stats before reuse', () => {
    const target: AgentFileChangeMessage[] = []
    const reducer = createAgentFileChangeReducer()
    reducer.accept(completed(), target)
    const stream = completed({
      event_id: undefined, stream_id: 'stream-reset', streaming: true,
      path: 'src/transient.ts', additions: 4, deletions: 2,
      chunk_seq: 0, byte_offset: 0, final: false, diff: 'A',
    })
    reducer.accept(stream, target)
    expect(card(target)).toMatchObject({ additions: 5, deletions: 3 })

    reducer.resetTransientStreams()

    expect(card(target).files.map(file => file.path)).toEqual(['src/a.ts'])
    expect(card(target)).toMatchObject({ additions: 1, deletions: 1 })

    reducer.accept(stream, target)
    expect(card(target).files.find(file => file.path === 'src/transient.ts')?.edits).toHaveLength(1)
    expect(card(target)).toMatchObject({ additions: 5, deletions: 3 })
  })
})
