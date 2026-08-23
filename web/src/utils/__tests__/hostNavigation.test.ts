import { describe, expect, test } from 'vitest'
import { hostSessionsLocation } from '../hostNavigation'

describe('host card navigation', () => {
  test('opens the selected host session list instead of a default session detail', () => {
    expect(hostSessionsLocation('daemon-1')).toEqual({
      path: '/sessions',
      query: { host: 'daemon-1' },
    })
  })
})
