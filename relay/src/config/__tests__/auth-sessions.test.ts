import { describe, expect, test } from 'vitest'
import {
  createDeviceAuthSessionStore,
  DeviceAuthStoreCapacityError,
} from '../auth-sessions.js'

function makeConfig(overrides: Partial<Parameters<typeof createDeviceAuthSessionStore>[0]> = {}) {
  return {
    maxSessions: 2,
    ttlMs: 600_000,
    baseIntervalSeconds: 5,
    slowDownIncrementSeconds: 5,
    ...overrides,
  }
}

describe('device auth session store capacity (M-2)', () => {
  test('create works below capacity and reports the RFC interval', () => {
    const store = createDeviceAuthSessionStore(makeConfig(), () => 1_000)
    const created = store.create('pocketctl-cli', 'challenge', undefined)
    expect(created.device_code).toBeTruthy()
    expect(created.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect(created.interval).toBe(5)
    expect(created.expires_in).toBe(600)
  })

  test('create fails with an explicit capacity error at the hard cap without evicting live sessions', () => {
    const store = createDeviceAuthSessionStore(makeConfig(), () => 1_000)
    const first = store.create('pocketctl-cli', 'c1', undefined)
    store.create('pocketctl-cli', 'c2', undefined)
    expect(() => store.create('pocketctl-cli', 'c3', undefined)).toThrow(DeviceAuthStoreCapacityError)
    expect(store.getByDeviceCode(first.device_code)).toBeDefined()
    expect(store.size()).toBe(2)
  })

  test('capacity message does not reveal exact global occupancy', () => {
    const store = createDeviceAuthSessionStore(makeConfig(), () => 1_000)
    store.create('pocketctl-cli', 'c1', undefined)
    store.create('pocketctl-cli', 'c2', undefined)
    try {
      store.create('pocketctl-cli', 'c3', undefined)
      throw new Error('expected capacity error')
    } catch (error) {
      expect(error).toBeInstanceOf(DeviceAuthStoreCapacityError)
      const message = (error as Error).message
      expect(message).not.toMatch(/\d{2,}/)
    }
  })

  test('create GCs expired sessions first, so expired slots are reused', () => {
    let now = 1_000
    const store = createDeviceAuthSessionStore(makeConfig(), () => now)
    const first = store.create('pocketctl-cli', 'c1', undefined)
    store.create('pocketctl-cli', 'c2', undefined)
    now += 601_000
    const third = store.create('pocketctl-cli', 'c3', undefined)
    expect(third.device_code).toBeTruthy()
    expect(store.getByDeviceCode(first.device_code)).toBeUndefined()
    expect(store.size()).toBe(1)
    // GC removes the userCodeIndex entry as well — no orphan index rows.
    expect(store.userCodeIndexSize()).toBe(store.size())
  })

  test('deleteSession removes the session and its user-code index and recovers capacity', () => {
    const store = createDeviceAuthSessionStore(makeConfig(), () => 1_000)
    const first = store.create('pocketctl-cli', 'c1', undefined)
    store.create('pocketctl-cli', 'c2', undefined)
    store.deleteSession(first.device_code)
    expect(store.userCodeIndexSize()).toBe(store.size())
    expect(() => store.create('pocketctl-cli', 'c3', undefined)).not.toThrow()
  })

  test('random-code collisions retry a bounded number of times and never overwrite', () => {
    let call = 0
    const collidingThenUnique = (length: number) => {
      call += 1
      // First generation collides with an existing session's code, then diverges.
      if (call === 1) return Buffer.alloc(length, 0x61)
      if (call === 2) return Buffer.alloc(length, 0x61) // collide again
      return Buffer.alloc(length, 0x62)
    }
    const store = createDeviceAuthSessionStore(
      makeConfig({ maxSessions: 10 }),
      () => 1_000,
      collidingThenUnique,
    )
    const first = store.create('pocketctl-cli', 'c1', undefined)
    const second = store.create('pocketctl-cli', 'c2', undefined)
    expect(second.device_code).not.toBe(first.device_code)
    expect(store.getByDeviceCode(first.device_code)!.code_challenge).toBe('c1')
    expect(store.size()).toBe(2)
  })
})

describe('device auth polling state machine (RFC 8628)', () => {
  test('first poll registers the timestamp and is allowed', () => {
    let now = 10_000
    const store = createDeviceAuthSessionStore(makeConfig(), () => now)
    const { device_code } = store.create('pocketctl-cli', 'c1', undefined)
    expect(store.registerPoll(device_code)).toEqual({ action: 'poll', intervalSeconds: 5 })
    expect(store.getByDeviceCode(device_code)!.last_poll_at).toBe(10_000)
  })

  test('polling faster than the interval returns slow_down and increases the interval by 5s', () => {
    let now = 10_000
    const store = createDeviceAuthSessionStore(makeConfig(), () => now)
    const { device_code } = store.create('pocketctl-cli', 'c1', undefined)
    store.registerPoll(device_code)
    now += 2_000
    expect(store.registerPoll(device_code)).toEqual({ action: 'slow_down', intervalSeconds: 10 })
    // Even after the original 5s interval has elapsed, the increased interval applies.
    now += 4_000
    expect(store.registerPoll(device_code)).toEqual({ action: 'slow_down', intervalSeconds: 15 })
    // Once the enlarged interval has elapsed, polling is allowed again.
    now += 16_000
    expect(store.registerPoll(device_code)).toEqual({ action: 'poll', intervalSeconds: 15 })
  })

  test('allowed polls refresh the timestamp used by later checks', () => {
    let now = 10_000
    const store = createDeviceAuthSessionStore(makeConfig(), () => now)
    const { device_code } = store.create('pocketctl-cli', 'c1', undefined)
    store.registerPoll(device_code)
    now += 6_000
    store.registerPoll(device_code) // allowed
    now += 3_000
    expect(store.registerPoll(device_code).action).toBe('slow_down')
  })

  test('unknown or expired device codes never create polling state', () => {
    let now = 10_000
    const store = createDeviceAuthSessionStore(makeConfig(), () => now)
    expect(store.registerPoll('unknown-code')).toEqual({ action: 'poll', intervalSeconds: 5 })
    expect(store.size()).toBe(0)
    const { device_code } = store.create('pocketctl-cli', 'c1', undefined)
    now += 601_000
    expect(store.registerPoll(device_code).action).toBe('poll')
    expect(store.size()).toBe(0) // expired session dropped, nothing retained for polling
  })

  test('authorizeSession only resolves known user codes and stores the user', () => {
    const store = createDeviceAuthSessionStore(makeConfig(), () => 1_000)
    const { user_code } = store.create('pocketctl-cli', 'c1', undefined)
    expect(store.authorize(user_code, 7)).toBe(true)
    expect(store.getByUserCode(user_code)!.user_id).toBe(7)
    expect(store.authorize('ZZZZ-ZZZZ', 7)).toBe(false)
  })
})
