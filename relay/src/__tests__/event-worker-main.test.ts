import { describe, expect, test, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubEnv('JWT_SECRET', 'event-worker-main-test-secret')
})

import {
  assertDurableIngressSchema,
  createStandaloneMaterializationHooks,
  createRetentionLoop,
  createWorkerRuntime,
} from '../event-worker-main.js'
import { startRelayBackgroundWorkers } from '../server.js'

describe('standalone event worker runtime', () => {
  test('does not install process-local push dedup in the restartable Worker', () => {
    const hooks = createStandaloneMaterializationHooks()

    expect(hooks.shouldPush).toBeUndefined()
    expect(hooks.forgetPush).toBeUndefined()
  })

  test('fails schema readiness when any required durable contract is absent', async () => {
    const ready = { query: vi.fn().mockResolvedValue({ rows: [{ ready: true }] }) }
    const stale = { query: vi.fn().mockResolvedValue({ rows: [{ ready: false }] }) }

    await expect(assertDurableIngressSchema(ready as any)).resolves.toBeUndefined()
    await expect(assertDurableIngressSchema(stale as any)).rejects.toThrow('durable ingress schema not ready')
  })

  test('starts only after schema readiness and drains before closing the pool', async () => {
    const order: string[] = []
    const deps = {
      assertSchemaReady: vi.fn(async () => { order.push('schema') }),
      worker: {
        start: vi.fn(() => { order.push('worker-start') }),
        stop: vi.fn(async () => { order.push('worker-stop') }),
      },
      retention: {
        start: vi.fn(() => { order.push('retention-start') }),
        stop: vi.fn(async () => { order.push('retention-stop') }),
      },
      pool: {
        end: vi.fn(async () => { order.push('pool-end') }),
      },
    }
    const runtime = createWorkerRuntime(deps)

    await runtime.start()
    await runtime.stop('SIGTERM')

    expect(order.slice(0, 3)).toEqual(['schema', 'worker-start', 'retention-start'])
    expect(order.indexOf('pool-end')).toBeGreaterThan(order.indexOf('worker-stop'))
    expect(order.indexOf('pool-end')).toBeGreaterThan(order.indexOf('retention-stop'))
    expect(deps.pool.end).toHaveBeenCalledOnce()
  })

  test('fails closed and releases the pool when durable ingress schema is not ready', async () => {
    const failure = new Error('durable ingress schema not ready')
    const deps = {
      assertSchemaReady: vi.fn().mockRejectedValue(failure),
      worker: { start: vi.fn(), stop: vi.fn() },
      retention: { start: vi.fn(), stop: vi.fn() },
      pool: { end: vi.fn().mockResolvedValue(undefined) },
    }
    const runtime = createWorkerRuntime(deps)

    await expect(runtime.start()).rejects.toBe(failure)

    expect(deps.worker.start).not.toHaveBeenCalled()
    expect(deps.retention.start).not.toHaveBeenCalled()
    expect(deps.pool.end).toHaveBeenCalledOnce()
  })

  test('drains a partially started worker when retention startup fails', async () => {
    const failure = new Error('retention startup failed')
    const deps = {
      assertSchemaReady: vi.fn().mockResolvedValue(undefined),
      worker: { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) },
      retention: { start: vi.fn(() => { throw failure }), stop: vi.fn() },
      pool: { end: vi.fn().mockResolvedValue(undefined) },
    }
    const runtime = createWorkerRuntime(deps)

    await expect(runtime.start()).rejects.toBe(failure)

    expect(deps.worker.stop).toHaveBeenCalledOnce()
    expect(deps.pool.end).toHaveBeenCalledOnce()
  })

  test('retention loop never overlaps and stop waits for the active batch', async () => {
    let timerCallback: (() => void) | undefined
    let finish: (() => void) | undefined
    const retention = {
      runOnce: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })),
    }
    const loop = createRetentionLoop({
      retention,
      intervalMs: 60_000,
      setTimer: (callback) => {
        timerCallback = callback
        return { unref: vi.fn() } as any
      },
      clearTimer: vi.fn(),
    })

    loop.start()
    timerCallback?.()
    timerCallback?.()
    expect(retention.runOnce).toHaveBeenCalledOnce()
    const stopped = loop.stop()
    let drained = false
    void stopped.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    finish?.()
    await stopped
    expect(drained).toBe(true)
  })
})

describe('relay background runtime', () => {
  test('does not embed-start the Inbox Worker', async () => {
    const deps = {
      welcome: { start: vi.fn() },
      realtimeOutboxConsumer: { start: vi.fn().mockResolvedValue(undefined) },
      startInboxWorker: vi.fn(),
    }

    await startRelayBackgroundWorkers(deps)

    expect(deps.welcome.start).toHaveBeenCalledOnce()
    expect(deps.realtimeOutboxConsumer.start).toHaveBeenCalledOnce()
    expect(deps.startInboxWorker).not.toHaveBeenCalled()
  })

  test('rolls back a partial startup when the realtime consumer fails', async () => {
    const failure = new Error('listen unavailable')
    const deps = {
      welcome: { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) },
      realtimeOutboxConsumer: { start: vi.fn().mockRejectedValue(failure) },
    }

    await expect(startRelayBackgroundWorkers(deps)).rejects.toBe(failure)
    expect(deps.welcome.stop).toHaveBeenCalledOnce()
  })
})
