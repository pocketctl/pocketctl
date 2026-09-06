import { afterEach, describe, expect, test, vi } from 'vitest'
import { createClientId } from '../clientId'

describe('createClientId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  test('uses the browser UUID implementation when it is available', () => {
    const randomUUID = vi.fn(() => 'native-uuid')
    vi.stubGlobal('crypto', { randomUUID })

    expect(createClientId()).toBe('native-uuid')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  test('builds an RFC 4122 UUID when only getRandomValues is available', () => {
    const getRandomValues = vi.fn((values: Uint8Array) => values.fill(0))
    vi.stubGlobal('crypto', { getRandomValues })

    expect(createClientId()).toBe('00000000-0000-4000-8000-000000000000')
    expect(getRandomValues).toHaveBeenCalledOnce()
  })

  test('keeps request identifiers unique when an HTTP LAN origin has no crypto API', () => {
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    vi.spyOn(Math, 'random').mockReturnValue(0.25)

    const first = createClientId()
    const second = createClientId()

    expect(first).not.toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
