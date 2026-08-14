import { describe, expect, test } from 'vitest'
import { ContentStreamAssembler } from '../contentStream'

describe('ContentStreamAssembler', () => {
  test('bounds the preview by UTF-8 bytes without preventing final completion', () => {
    const assembler = new ContentStreamAssembler(4)

    assembler.accept({
      streamId: 'utf8-stream', sequence: 0, byteOffset: 0,
      content: '你A', final: false,
    })
    const completed = assembler.accept({
      streamId: 'utf8-stream', sequence: 1, byteOffset: 4,
      content: 'B', final: true, totalBytes: 5,
    })

    expect(completed).toMatchObject({
      content: '你A',
      completed: true,
      truncated: true,
      receivedBytes: 5,
    })
  })

  test('backs up to a valid UTF-8 boundary when the preview cuts a character', () => {
    const assembler = new ContentStreamAssembler(2)

    const completed = assembler.accept({
      streamId: 'utf8-boundary', sequence: 0, byteOffset: 0,
      content: '你A', final: true, totalBytes: 4,
    })

    expect(completed).toMatchObject({
      content: '', completed: true, truncated: true, receivedBytes: 4,
    })
  })

  test('waits for a corrected chunk when its byte offset is inconsistent', () => {
    const assembler = new ContentStreamAssembler()

    const invalid = assembler.accept({
      streamId: 'offset-stream', sequence: 0, byteOffset: 1,
      content: 'A', final: true, totalBytes: 1,
    })
    expect(invalid).toMatchObject({
      content: '', completed: false, incomplete: true, receivedBytes: 0,
    })

    const corrected = assembler.accept({
      streamId: 'offset-stream', sequence: 0, byteOffset: 0,
      content: 'A', final: true, totalBytes: 1,
    })
    expect(corrected).toMatchObject({
      content: 'A', completed: true, incomplete: false, receivedBytes: 1,
    })
  })

  test('does not complete until final total_bytes matches assembled UTF-8 bytes', () => {
    const assembler = new ContentStreamAssembler()

    const mismatched = assembler.accept({
      streamId: 'total-stream', sequence: 0, byteOffset: 0,
      content: 'A', final: true, totalBytes: 2,
    })
    expect(mismatched).toMatchObject({
      content: 'A', completed: false, incomplete: true, receivedBytes: 1,
    })

    const corrected = assembler.accept({
      streamId: 'total-stream', sequence: 0, byteOffset: 0,
      content: 'A', final: true, totalBytes: 1,
    })
    expect(corrected).toMatchObject({
      content: 'A', changed: false, completed: true, incomplete: false,
    })
  })

  test('bounds pending chunks, bytes, active streams, and completed stream identities', () => {
    const assembler = new ContentStreamAssembler(1024, {
      maxBufferedChunksPerStream: 2,
      maxBufferedBytes: 2,
      maxActiveStreams: 1,
      maxCompletedStreams: 1,
    })

    expect(assembler.accept({
      streamId: 'oversized', sequence: 0, byteOffset: 0,
      content: 'ABC', final: true, totalBytes: 3,
    })).toBeNull()
    expect(assembler.accept({
      streamId: 'bounded-a', sequence: 2, byteOffset: 0,
      content: 'A', final: false,
    })).not.toBeNull()
    expect(assembler.accept({
      streamId: 'bounded-a', sequence: 3, byteOffset: 1,
      content: 'B', final: true, totalBytes: 2,
    })).not.toBeNull()
    expect(assembler.accept({
      streamId: 'bounded-a', sequence: 4, byteOffset: 2,
      content: 'C', final: false,
    })).toBeNull()
    expect(assembler.accept({
      streamId: 'bounded-b', sequence: 0, byteOffset: 0,
      content: 'B', final: true, totalBytes: 1,
    })).toBeNull()

    assembler.accept({
      streamId: 'bounded-a', sequence: 0, byteOffset: 0,
      content: '', final: false,
    })
    const completedA = assembler.accept({
      streamId: 'bounded-a', sequence: 1, byteOffset: 0,
      content: '', final: false,
    })
    expect(completedA).toMatchObject({ content: 'AB', completed: true })

    expect(assembler.accept({
      streamId: 'bounded-b', sequence: 0, byteOffset: 0,
      content: 'B', final: true, totalBytes: 1,
    })).toMatchObject({ completed: true })

    // With a one-entry completion cache, finishing B evicts A. Reusing A is
    // accepted as a new stream instead of growing completion metadata forever.
    expect(assembler.accept({
      streamId: 'bounded-a', sequence: 0, byteOffset: 0,
      content: 'A', final: true, totalBytes: 1,
    })).toMatchObject({ content: 'A', changed: true, completed: true })
  })
})
