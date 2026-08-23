import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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
  // Some assertions dynamically import server.ts, which imports auth.ts and
  // validates JWT_SECRET at module load. Restore this fixture for every test:
  // afterEach deliberately clears all stubs to keep each flag case isolated.
  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', 'durable-ingress-feature-flag-test-secret')
  })

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

  test('runtime config keeps transport advertisement and replay budgets consistent', async () => {
    const server = await import('../server.js') as unknown as {
      resolveRelayRuntimeConfig?: (
        env: Record<string, string | undefined>,
      ) => {
        maxEventBytes: number;
        maxChunkBytes: number;
        replayBatchMaxEvents: number;
        replayBatchMaxBytes: number;
      };
    }
    const resolve = server.resolveRelayRuntimeConfig!

    expect(resolve({
      MAX_WS_MESSAGE_SIZE: '900000',
      MAX_CHUNK_BYTES: '96000',
      REPLAY_BATCH_MAX_EVENTS: '20',
      REPLAY_BATCH_MAX_BYTES: '400000',
    })).toEqual(expect.objectContaining({
      maxEventBytes: 900_000,
      maxChunkBytes: 96_000,
      replayBatchMaxEvents: 20,
      replayBatchMaxBytes: 400_000,
    }))
    expect(() => resolve({
      MAX_WS_MESSAGE_SIZE: '900000',
      MAX_CHUNK_BYTES: '900001',
    })).toThrow('MAX_CHUNK_BYTES must not exceed MAX_WS_MESSAGE_SIZE')
    expect(() => resolve({
      MAX_WS_MESSAGE_SIZE: '900000',
      REPLAY_BATCH_MAX_BYTES: '900001',
    })).toThrow('REPLAY_BATCH_MAX_BYTES must not exceed MAX_WS_MESSAGE_SIZE')
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
