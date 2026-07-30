import { afterEach, describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubEnv('JWT_SECRET', 'durable-ingress-feature-flag-test-secret')
})

import {
  Router,
  parseDurableIngressFlag,
  resolveDurableIngressFlag,
  type FlagConfig,
} from '../router.js'

function pool(): any {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  }
}

describe('strict durable-ingress feature flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('rejects an unknown RELAY_DURABLE_INGRESS mode instead of silently enabling or disabling it', () => {
    vi.stubEnv('RELAY_DURABLE_INGRESS', 'sometimes')

    expect(() => new Router(pool())).toThrow('invalid RELAY_DURABLE_INGRESS')
  })

  test.each([
    ['off', '', 'd1', false],
    ['canary', 'd1,d2', 'd1', true],
    ['canary', 'd1,d2', 'd3', false],
    ['on', '', 'd3', true],
  ] as const)('mode=%s ids=%s daemon=%s enabled=%s', (mode, ids, daemonId, expected) => {
    const config: FlagConfig = {
      mode,
      daemonIds: new Set(ids === '' ? [] : ids.split(',')),
    }

    expect(resolveDurableIngressFlag(config, daemonId)).toBe(expected)
  })

  test('normalizes and deduplicates a canary allowlist without changing daemon ids', () => {
    expect(parseDurableIngressFlag({
      RELAY_DURABLE_INGRESS: 'canary',
      RELAY_DURABLE_INGRESS_DAEMONS: ' daemon-a,daemon-b,daemon-a,, ',
    })).toEqual({
      mode: 'canary',
      daemonIds: new Set(['daemon-a', 'daemon-b']),
    })
  })

  test('strict runtime config rejects invalid materialization, pool, and event-window values', async () => {
    const server = await import('../server.js') as unknown as {
      resolveRelayRuntimeConfig?: (env: Record<string, string | undefined>) => unknown;
    }
    expect(server.resolveRelayRuntimeConfig).toBeTypeOf('function')
    const resolve = server.resolveRelayRuntimeConfig!

    expect(() => resolve({ RELAY_MATERIALIZATION_MODE: 'sometimes' }))
      .toThrow('invalid RELAY_MATERIALIZATION_MODE')
    expect(() => resolve({ DB_INGEST_POOL_MAX: '0' }))
      .toThrow('DB_INGEST_POOL_MAX must be a positive decimal integer')
    expect(() => resolve({ RELAY_DURABLE_INGRESS_WINDOW: '128events' }))
      .toThrow('RELAY_DURABLE_INGRESS_WINDOW must be a positive decimal integer')
  })

  test('worker materialization fails closed when the durable schema is unavailable', async () => {
    const server = await import('../server.js') as unknown as {
      assertRelayMaterializationReady?: (
        mode: 'inline' | 'worker',
        database: { query(sql: string): Promise<{ rows: Array<{ ready: boolean }> }> },
      ) => Promise<void>;
    }
    expect(server.assertRelayMaterializationReady).toBeTypeOf('function')
    const database = {
      query: vi.fn().mockResolvedValue({ rows: [{ ready: false }] }),
    }

    await expect(server.assertRelayMaterializationReady!('worker', database))
      .rejects.toThrow('durable ingress schema not ready')
    expect(database.query).toHaveBeenCalledOnce()
  })
})
