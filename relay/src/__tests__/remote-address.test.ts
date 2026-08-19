import { expect, test } from 'vitest'
import { canonicalClientAddress } from '../remote-address.js'

// M-1: the transport/framework trust decision now lives in Fastify
// (trustProxy: false | string[]). The relay only canonicalizes whatever
// address the framework already resolved, so REST req.ip and the WS
// admission limiter always observe the same value.
test('canonical address falls back to unknown when the framework has no value', () => {
  expect(canonicalClientAddress(undefined)).toBe('unknown')
  expect(canonicalClientAddress('')).toBe('unknown')
})

test('canonical address passes plain IPv4 through untouched', () => {
  expect(canonicalClientAddress('203.0.113.10')).toBe('203.0.113.10')
})

test('canonical address normalizes IPv4-mapped IPv6 to the IPv4 form', () => {
  expect(canonicalClientAddress('::ffff:198.51.100.8')).toBe('198.51.100.8')
})

test('canonical address canonicalizes long-form IPv6', () => {
  expect(canonicalClientAddress('2001:0DB8:0:0:0:0:0:1')).toBe('2001:db8::1')
  expect(canonicalClientAddress('[2001:0db8::1]')).toBe('2001:db8::1')
})

import Fastify from 'fastify'
import { resolveTrustedProxyConfig } from '../runtime-config.js'
import { afterAll, expect as expectAlias, test as testAlias } from 'vitest'

const servers: Array<{ close: () => Promise<void> }> = []

afterAll(async () => {
  await Promise.all(servers.map(s => s.close()))
})

async function probeReqIp(trustedProxy: false | string[]): Promise<{ ip: string; canonical: string }> {
  const app = Fastify({ logger: false, trustProxy: trustedProxy })
  app.get('/ip', async req => ({ ip: req.ip, canonical: canonicalClientAddress(req.ip) }))
  const port = await new Promise<number>(resolve => {
    app.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = app.server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  servers.push({ close: () => app.close() })
  const res = await fetch(`http://127.0.0.1:${port}/ip`, {
    headers: { 'X-Forwarded-For': '198.51.100.8' },
  })
  return res.json() as any
}

testAlias('spoofed X-Forwarded-For never reaches req.ip without an explicit trust list', async () => {
  const trust = resolveTrustedProxyConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)
  const observed = await probeReqIp(trust)
  expectAlias(observed.ip).toBe('127.0.0.1')
  expectAlias(observed.canonical).toBe('127.0.0.1')
})

testAlias('a transport peer inside the explicit trust list may resolve req.ip from XFF', async () => {
  const trust = resolveTrustedProxyConfig({
    NODE_ENV: 'development',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  } as NodeJS.ProcessEnv)
  const observed = await probeReqIp(trust)
  expectAlias(observed.ip).toBe('198.51.100.8')
  expectAlias(observed.canonical).toBe('198.51.100.8')
})
