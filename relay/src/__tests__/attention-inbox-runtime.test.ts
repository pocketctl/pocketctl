import { describe, expect, test, vi } from 'vitest'

import { createAttentionInboxRuntime } from '../attention-inbox/runtime.js'

describe('Attention Inbox runtime', () => {
  test('off mode starts no worker and no listener', async () => {
    const projection = { runOnce: vi.fn() }
    const maintenance = { runMaintenance: vi.fn() }
    const notifier = { start: vi.fn(), stop: vi.fn() }
    const runtime = createAttentionInboxRuntime({ mode: 'off', projection, maintenance, notifier })
    await runtime.start()
    expect(projection.runOnce).not.toHaveBeenCalled()
    expect(notifier.start).not.toHaveBeenCalled()
  })

  test('runs projection and maintenance serially and stops the notifier', async () => {
    vi.useFakeTimers()
    const projection = { runOnce: vi.fn(async () => 0) }
    const maintenance = { runMaintenance: vi.fn(async () => 0) }
    const notifier = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }
    const runtime = createAttentionInboxRuntime({
      mode: 'observe', projection, maintenance, notifier,
      projectionIntervalMs: 25, maintenanceIntervalMs: 50,
    })
    await runtime.start()
    await vi.advanceTimersByTimeAsync(60)
    expect(notifier.start).toHaveBeenCalledOnce()
    expect(projection.runOnce).toHaveBeenCalled()
    expect(maintenance.runMaintenance).toHaveBeenCalled()
    await runtime.stop()
    expect(notifier.stop).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
