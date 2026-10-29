import { describe, expect, test, vi } from 'vitest'
import { TeamStepWorker } from '../team/step-worker.js'
import { StepWakeupLeaseLost } from '../team/step-wakeup-repository.js'

const claim = { task_id: 'task', generation: '1', lease_token: '1', lease_owner: '00000000-0000-4000-8000-000000000001' }
const setup = () => {
  const repository = { claim: vi.fn(async () => claim), retry: vi.fn(async () => true) }
  const scheduler = { process: vi.fn(async () => ({ state: 'reserved' as const, call_id: 'call' })) }
  const onCall = vi.fn(), onError = vi.fn()
  const options = { repository, scheduler, onCall, onError, teamIds: () => ['team'] }
  return { ...options, worker: new TeamStepWorker(options) }
}

describe('persistent step worker', () => {
  test('off allowlist performs no claim or work', async () => {
    const s = setup()
    expect(await new TeamStepWorker({ ...s, teamIds: () => [] }).runOnce()).toBe(false)
    expect(s.repository.claim).not.toHaveBeenCalled()
  })
  test('coalesces concurrent passes and notifies only committed calls', async () => {
    const s = setup()
    let finish!: () => void
    s.scheduler.process.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve }); return { state: 'reserved', call_id: 'call' } })
    const first = s.worker.runOnce(), second = s.worker.runOnce()
    await vi.waitFor(() => expect(s.scheduler.process).toHaveBeenCalledTimes(1))
    expect(s.onCall).not.toHaveBeenCalled()
    finish()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(s.repository.claim).toHaveBeenCalledWith(['team'])
    expect(s.onCall).toHaveBeenCalledExactlyOnceWith('call')
  })
  test.each([
    ['budget_exhausted', 'budget_exhausted', 30000],
    ['creator_required', 'authorization_changed', 30000],
    ['artifact_unavailable', 'dependency_unavailable', 30000],
    ['source_busy', 'retry_pending', 1000],
    ['unknown_sensitive_error', 'retry_pending', 1000],
  ])('retries the same claim for %s without dispatching', async (code, mapped, delay) => {
    const s = setup()
    s.scheduler.process.mockRejectedValue(Object.assign(new Error('private details'), { code }))
    await s.worker.runOnce()
    expect(s.repository.retry).toHaveBeenCalledWith(claim, mapped, delay)
    expect(s.onError).toHaveBeenCalledWith(mapped)
    expect(s.onCall).not.toHaveBeenCalled()
  })
  test('stale lease does not alter its successor', async () => {
    const s = setup()
    s.scheduler.process.mockRejectedValue(new StepWakeupLeaseLost())
    await s.worker.runOnce()
    expect(s.repository.retry).not.toHaveBeenCalled()
    expect(s.onCall).not.toHaveBeenCalled()
  })
  test('notification failure leaves durable dispatch recovery in charge', async () => {
    const s = setup()
    s.onCall.mockImplementation(() => { throw new Error('notification unavailable') })
    await s.worker.runOnce()
    expect(s.repository.retry).not.toHaveBeenCalled()
    expect(s.onError).toHaveBeenCalledWith('dispatch_notification_failed')
  })
  test('stop awaits the active transaction and prevents another timer', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      let finish!: () => void
      s.scheduler.process.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve }); return { state: 'reserved', call_id: 'call' } })
      s.worker.start()
      await vi.advanceTimersByTimeAsync(0)
      let stopped = false
      const stopping = s.worker.stop().then(() => { stopped = true })
      await Promise.resolve()
      expect(stopped).toBe(false)
      finish()
      await stopping
      await vi.advanceTimersByTimeAsync(10000)
      expect(s.scheduler.process).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
})
