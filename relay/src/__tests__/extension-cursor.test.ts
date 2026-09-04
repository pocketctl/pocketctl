import { describe, expect, test } from 'vitest'
import {
  decodeFeedCursor,
  encodeFeedCursor,
  filterHashForInstallation,
  leaseBindingHash,
  newLeaseToken,
  type FeedCursorV1,
} from '../extensions/cursor.js'

const SECRET = 'cursor-secret-0123456789abcdef0123456789'

function cursor(overrides: Partial<FeedCursorV1> = {}): FeedCursorV1 {
  return {
    v: 1,
    installation_id: '11111111-1111-1111-1111-111111111111',
    feed_id: '183921',
    lease_epoch: '4',
    config_version: '2',
    filter_hash: filterHashForInstallation({}),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }
}

describe('feed cursor codec', () => {
  test('round-trips a valid cursor', () => {
    const token = encodeFeedCursor(cursor(), SECRET)
    const decoded = decodeFeedCursor(token, SECRET)
    expect(decoded).toEqual(cursor())
  })

  test('rejects a tampered payload or signature', () => {
    const token = encodeFeedCursor(cursor(), SECRET)
    const parts = token.split('.')
    const payload = Buffer.from(parts[0], 'base64url').toString('utf8').replace('183921', '999999')
    const tampered = `${Buffer.from(payload).toString('base64url')}.${parts[1]}`
    expect(decodeFeedCursor(tampered, SECRET)).toBeNull()
    expect(decodeFeedCursor(`${parts[0]}.${'A'.repeat(parts[1].length)}`, SECRET)).toBeNull()
  })

  test('rejects the wrong secret and malformed tokens', () => {
    const token = encodeFeedCursor(cursor(), SECRET)
    expect(decodeFeedCursor(token, 'other-secret')).toBeNull()
    expect(decodeFeedCursor('', SECRET)).toBeNull()
    expect(decodeFeedCursor('noseparator', SECRET)).toBeNull()
    expect(decodeFeedCursor(`${'A'.repeat(5000)}.sig`, SECRET)).toBeNull()
    expect(decodeFeedCursor('e30.sig', SECRET)).toBeNull()
  })

  test('rejects expired cursors', () => {
    const expired = encodeFeedCursor(cursor({ exp: Math.floor(Date.now() / 1000) - 1 }), SECRET)
    expect(decodeFeedCursor(expired, SECRET)).toBeNull()
    const future = encodeFeedCursor(cursor({ exp: Math.floor(Date.now() / 1000) + 3600 }), SECRET)
    expect(decodeFeedCursor(future, SECRET)).not.toBeNull()
  })

  test('rejects non-numeric positions and wrong versions', () => {
    expect(decodeFeedCursor(encodeFeedCursor(cursor({ feed_id: 'abc' as string }), SECRET), SECRET)).toBeNull()
    expect(decodeFeedCursor(encodeFeedCursor(cursor({ v: 2 as never }), SECRET), SECRET)).toBeNull()
    expect(decodeFeedCursor(encodeFeedCursor(cursor({ lease_epoch: '-1' }), SECRET), SECRET)).toBeNull()
  })
})

describe('installation filter fingerprint', () => {
  test('is order-insensitive and filters out non-strings', () => {
    expect(filterHashForInstallation({ daemon_ids: ['b', 'a'] }))
      .toBe(filterHashForInstallation({ daemon_ids: ['a', 'b'] }))
    expect(filterHashForInstallation({ daemon_ids: ['a'] }))
      .not.toBe(filterHashForInstallation({ daemon_ids: ['b'] }))
    expect(filterHashForInstallation({}))
      .toBe(filterHashForInstallation({ daemon_ids: [], agent_types: [] }))
    expect(filterHashForInstallation({ daemon_ids: ['a'] }))
      .toBe(filterHashForInstallation({ daemon_ids: ['a'], agent_types: undefined }))
  })
})

describe('lease binding', () => {
  test('lease tokens are unique and bound to the issued position', () => {
    expect(newLeaseToken()).not.toBe(newLeaseToken())
    const base = {
      installationId: '11111111-1111-1111-1111-111111111111',
      leaseEpoch: 3,
      leaseToken: 'token-a',
      cursorFeedId: 100,
    }
    expect(leaseBindingHash(base)).toEqual(leaseBindingHash({ ...base }))
    expect(leaseBindingHash(base)).not.toEqual(leaseBindingHash({ ...base, cursorFeedId: 105 }))
    expect(leaseBindingHash(base)).not.toEqual(leaseBindingHash({ ...base, leaseToken: 'token-b' }))
    expect(leaseBindingHash(base)).not.toEqual(leaseBindingHash({ ...base, leaseEpoch: 4 }))
  })
})
