import { describe, expect, test } from 'vitest'
import { ReplayPageBuffer } from '../replayPageBuffer'

describe('ReplayPageBuffer', () => {
  test('keeps batches in arrival order and clears after take', () => {
    const buffer = new ReplayPageBuffer<number>()
    buffer.append([1, 2])
    buffer.append([3])

    expect(buffer.take()).toEqual([1, 2, 3])
    expect(buffer.take()).toEqual([])
  })

  test('drops pending events when a replay request resets', () => {
    const buffer = new ReplayPageBuffer<string>()
    buffer.append(['stale'])
    buffer.reset()
    buffer.append(['current'])

    expect(buffer.take()).toEqual(['current'])
  })
})
