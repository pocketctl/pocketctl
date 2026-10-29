import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { validateDeliveryWithdrawalBatch } from '../relay/delivery-withdrawal-client.js'
const consumer = randomUUID()
const fixture = () => ({ version: 1, consumer_id: consumer, items: [{ sequence: '1', team_id: 'team', team_session_id: 'session',
  submission_id: randomUUID(), decision_id: randomUUID(), recorded_at: '2026-10-25T00:00:00.000Z' }],
  through_sequence: '1', next_cursor: 'signed-cursor', lease_token: 'lease', lease_expires_at: '2099-10-25T00:00:00.000Z' })
describe('strict provider delivery invalidation contract', () => {
  test('retains only the complete exact control contract', () => { const f = fixture(); expect(validateDeliveryWithdrawalBatch(f, consumer)).toEqual(f) })
  test.each(['foreign-consumer','extra-body','extra-item','body-content','wrong-version','missing-identity','bad-uuid','invalid-time','string-version',
    'negative-position','numeric-position','overflow-position','unordered','duplicate','mismatched-watermark','oversized','zero-sequence'])('%s fails closed', change => {
    const f: any = fixture()
    if (change === 'foreign-consumer') f.consumer_id = randomUUID()
    if (change === 'extra-body') f.text = 'private content'
    if (change === 'extra-item') f.items[0].extra = true
    if (change === 'body-content') f.items[0].text = 'private content'
    if (change === 'wrong-version') f.version = 2
    if (change === 'missing-identity') delete f.items[0].submission_id
    if (change === 'bad-uuid') f.items[0].decision_id = 'not-a-uuid'
    if (change === 'invalid-time') f.items[0].recorded_at = 'invalid'
    if (change === 'string-version') f.version = '1'
    if (change === 'negative-position') f.through_sequence = '-1'
    if (change === 'numeric-position') f.items[0].sequence = 1
    if (change === 'overflow-position') f.through_sequence = '9223372036854775808'
    if (change === 'unordered') f.items = [{ ...f.items[0], sequence: '2' }, f.items[0]]
    if (change === 'duplicate') f.items.push(f.items[0])
    if (change === 'mismatched-watermark') f.through_sequence = '2'
    if (change === 'oversized') f.items = Array.from({ length: 101 }, (_, i) => ({ ...f.items[0], sequence: String(i+1) }))
    if (change === 'zero-sequence') f.items[0].sequence = f.through_sequence = '0'
    expect(() => validateDeliveryWithdrawalBatch(f, consumer)).toThrow('invalid delivery withdrawal batch')
  })
})
