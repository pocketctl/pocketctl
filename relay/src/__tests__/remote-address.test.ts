import { expect, test } from 'vitest'
import { resolveAdmissionAddress } from '../remote-address.js'

test('ignores spoofed forwarded addresses for a direct peer by default', () => {
  expect(resolveAdmissionAddress({ transportAddress: '10.0.0.9', frameworkClientAddress: '198.51.100.8', trustProxy: false })).toBe('10.0.0.9')
})

test('uses framework resolved client address only with explicit proxy trust', () => {
  expect(resolveAdmissionAddress({ transportAddress: '10.0.0.9', frameworkClientAddress: '198.51.100.8', trustProxy: true })).toBe('198.51.100.8')
})

test('normalizes IPv4-mapped IPv6 and canonical IPv6 keys', () => {
  expect(resolveAdmissionAddress({ transportAddress: '::ffff:192.0.2.9', trustProxy: false })).toBe('192.0.2.9')
  expect(resolveAdmissionAddress({ transportAddress: '2001:0DB8:0:0:0:0:0:1', trustProxy: false })).toBe('2001:db8::1')
})
