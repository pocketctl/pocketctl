import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WelcomeEmailJob } from '../db.js'
import { createWelcomeEmailWorker, retryDelayMs } from '../welcome-email-worker.js'

const job = (overrides: Partial<WelcomeEmailJob> = {}): WelcomeEmailJob => ({
  id: '11',
  userId: 7,
  recipientEmail: 'person@example.com',
  locale: 'en',
  attemptCount: 2,
  ...overrides,
})

describe('welcome email worker', () => {
  afterEach(() => vi.useRealTimers())

  test('uses the bounded retry schedule', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryDelayMs)).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000, 86_400_000,
    ])
  })

  test('sends claimed jobs, fences completion by attempt generation, and continues after failures', async () => {
    const now = new Date('2026-07-13T01:00:00Z')
    const jobs = [job(), job({ id: '12', userId: 8, locale: 'zh', attemptCount: 4 }), job({ id: '13', userId: 9 })]
    const claim = vi.fn().mockResolvedValue(jobs)
    const send = vi.fn()
      .mockResolvedValueOnce('message-11')
      .mockRejectedValueOnce(new Error('SES unavailable'))
      .mockResolvedValueOnce('message-13')
    const markSent = vi.fn().mockResolvedValue(undefined)
    const reschedule = vi.fn().mockResolvedValue(undefined)
    const workerLogger = { info: vi.fn(), error: vi.fn() }
    const worker = createWelcomeEmailWorker({
      pool: {} as any, now: () => now, send, claim, markSent, reschedule, logger: workerLogger,
    })

    await expect(worker.runOnce()).resolves.toBeUndefined()

    expect(claim).toHaveBeenCalledWith(expect.anything(), 1, new Date('2026-07-13T00:50:00Z'))
    expect(send).toHaveBeenCalledTimes(3)
    expect(markSent).toHaveBeenNthCalledWith(1, expect.anything(), '11', 2, 'message-11')
    expect(markSent).toHaveBeenNthCalledWith(2, expect.anything(), '13', 2, 'message-13')
    expect(reschedule).toHaveBeenCalledWith(
      expect.anything(), '12', 4, new Date('2026-07-13T03:00:00Z'), 'SES unavailable',
    )
    expect(workerLogger.info).toHaveBeenCalledWith('[welcome-email] processed', expect.objectContaining({
      jobId: '11', templateId: 204008, messageId: 'message-11',
    }))
    expect(workerLogger.error).toHaveBeenCalledWith('[welcome-email] processed', expect.objectContaining({
      jobId: '12', templateId: 204007, templateOutcome: 'failed',
    }))
  })

  test('contains reschedule and logger failures, bounds errors, and continues the batch', async () => {
    const hugeError = `secret\u0000${'x'.repeat(1_500)}`
    const jobs = [job({ id: '21', attemptCount: 5 }), job({ id: '22', attemptCount: 6 })]
    const send = vi.fn().mockRejectedValueOnce(new Error(hugeError)).mockResolvedValueOnce('message-22')
    const markSent = vi.fn().mockResolvedValue(undefined)
    const reschedule = vi.fn().mockRejectedValue(new Error(`db\n${'y'.repeat(1_500)}`))
    const logger = {
      info: vi.fn((..._args: any[]) => { throw new Error('logger info failed') }),
      error: vi.fn((..._args: any[]) => { throw new Error('logger error failed') }),
    }
    const worker = createWelcomeEmailWorker({ pool: {} as any, send, claim: vi.fn().mockResolvedValue(jobs), markSent, reschedule, logger })

    await expect(worker.runOnce()).resolves.toBeUndefined()

    expect(send).toHaveBeenCalledTimes(2)
    expect(markSent).toHaveBeenCalledWith(expect.anything(), '22', 6, 'message-22')
    const persistedError = reschedule.mock.calls[0][4]
    expect(persistedError).not.toMatch(/[\u0000\n]/)
    expect(persistedError.length).toBeLessThanOrEqual(1_000)
    const loggedFailure = logger.error.mock.calls.find(call => call[1]?.templateOutcome === 'reschedule_failed')
    expect(loggedFailure?.[1].error).toEqual(expect.any(String))
    expect(loggedFailure?.[1].error).not.toBeInstanceOf(Error)
    expect(loggedFailure?.[1].error.length).toBeLessThanOrEqual(1_000)
  })

  test('redacts credentials and URLs before persisting or logging failures', async () => {
    const unsafe = 'POST ftp://files.example.com/x https://user:pass@example.com/send?token=abc Bearer eyJ.secret authorization=Basic-Zm9v token: tok secret=s3 password=p4 access_key_id=AKIA123 credential=cred {"refresh_token":"refresh123","secret_access_key":"awsSecret"}'
    const reschedule = vi.fn().mockResolvedValue(undefined)
    const logger = { info: vi.fn(), error: vi.fn() }
    const worker = createWelcomeEmailWorker({
      pool: {} as any,
      claim: vi.fn().mockResolvedValue([job()]),
      send: vi.fn().mockRejectedValue(new Error(unsafe)),
      reschedule,
      logger,
    })

    await worker.runOnce()

    const persisted = reschedule.mock.calls[0][4] as string
    const logged = logger.error.mock.calls[0][1].error as string
    for (const sanitized of [persisted, logged]) {
      expect(sanitized).not.toContain('example.com')
      for (const secret of ['files.example.com', 'eyJ.secret', 'Basic-Zm9v', 'token: tok', 'secret=s3', 'password=p4', 'AKIA123', 'credential=cred', 'refresh123', 'awsSecret']) {
        expect(sanitized).not.toContain(secret)
      }
      expect(sanitized).toContain('[REDACTED]')
    }
  })

  test('default one-at-a-time leases do not let a slow worker pre-claim a later job', async () => {
    const pending = [job({ id: '31' }), job({ id: '32' })]
    const leased = new Set<string>()
    const claim = vi.fn(async (_pool, limit: number) => pending.filter(item => !leased.has(item.id)).slice(0, limit).map(item => (leased.add(item.id), item)))
    let releaseFirst!: (id: string) => void
    const slowSend = vi.fn(() => new Promise<string>(resolve => { releaseFirst = resolve }))
    const first = createWelcomeEmailWorker({ pool: {} as any, claim, send: slowSend, markSent: vi.fn(), logger: { info: vi.fn(), error: vi.fn() } })
    const secondSend = vi.fn().mockResolvedValue('message-32')
    const second = createWelcomeEmailWorker({ pool: {} as any, claim, send: secondSend, markSent: vi.fn(), logger: { info: vi.fn(), error: vi.fn() } })

    const firstRun = first.runOnce()
    await vi.waitFor(() => expect(slowSend).toHaveBeenCalledOnce())
    await second.runOnce()

    expect(claim.mock.calls.map(call => call[1])).toEqual([1, 1])
    expect(secondSend).toHaveBeenCalledOnce()
    expect(secondSend).toHaveBeenCalledWith('person@example.com', 'en')
    await second.runOnce()
    expect(secondSend).toHaveBeenCalledOnce()
    releaseFirst('message-31')
    await firstRun
  })

  test('sanitizes scheduled top-level errors before logging', async () => {
    vi.useFakeTimers()
    const logger = { info: vi.fn(), error: vi.fn() }
    const worker = createWelcomeEmailWorker({
      pool: {} as any,
      claim: vi.fn().mockRejectedValue(new Error(`claim\n${'z'.repeat(1_500)}`)),
      logger,
    })

    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    await worker.stop()

    expect(logger.error).toHaveBeenCalledWith('[welcome-email] worker run failed', expect.any(String))
    const logged = logger.error.mock.calls[0][1]
    expect(logged).not.toMatch(/\n/)
    expect(logged.length).toBeLessThanOrEqual(1_000)
  })

  test('prevents overlapping runs', async () => {
    let release!: (jobs: WelcomeEmailJob[]) => void
    const claim = vi.fn(() => new Promise<WelcomeEmailJob[]>(resolve => { release = resolve }))
    const worker = createWelcomeEmailWorker({ pool: {} as any, claim, logger: { info: vi.fn(), error: vi.fn() } })

    const first = worker.runOnce()
    const overlapping = worker.runOnce()
    expect(claim).toHaveBeenCalledOnce()
    await expect(overlapping).resolves.toBeUndefined()
    release([])
    await first
  })

  test('stop drains an in-flight send and its completion persistence', async () => {
    let releaseSend!: (messageId: string) => void
    let releaseMark!: () => void
    const send = vi.fn(() => new Promise<string>(resolve => { releaseSend = resolve }))
    const markSent = vi.fn(() => new Promise<void>(resolve => { releaseMark = resolve }))
    const worker = createWelcomeEmailWorker({
      pool: {} as any,
      claim: vi.fn().mockResolvedValue([job()]),
      send,
      markSent,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    worker.start()
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    let stopped = false
    const stopping = Promise.resolve(worker.stop()).then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)

    releaseSend('message-11')
    await vi.waitFor(() => expect(markSent).toHaveBeenCalledOnce())
    expect(stopped).toBe(false)

    releaseMark()
    await stopping
    expect(stopped).toBe(true)
  })

  test('stop drains retry persistence after an in-flight send fails', async () => {
    let rejectSend!: (error: Error) => void
    let releaseReschedule!: () => void
    const send = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectSend = reject }))
    const reschedule = vi.fn(() => new Promise<void>(resolve => { releaseReschedule = resolve }))
    const worker = createWelcomeEmailWorker({
      pool: {} as any,
      claim: vi.fn().mockResolvedValue([job()]),
      send,
      reschedule,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    worker.start()
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    rejectSend(new Error('SES unavailable'))
    await vi.waitFor(() => expect(reschedule).toHaveBeenCalledOnce())

    let stopped = false
    const stopping = worker.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)

    releaseReschedule()
    await stopping
    expect(stopped).toBe(true)
  })

  test('stop returns after the default bounded drain when SES never resolves', async () => {
    vi.useFakeTimers()
    const send = vi.fn(() => new Promise<string>(() => {}))
    const worker = createWelcomeEmailWorker({
      pool: {} as any,
      claim: vi.fn().mockResolvedValue([job()]),
      send,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    void worker.runOnce()
    await Promise.resolve()
    await Promise.resolve()
    expect(send).toHaveBeenCalledOnce()
    const stopping = worker.stop()
    await vi.advanceTimersByTimeAsync(499)
    let stopped = false
    void stopping.then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(stopping).resolves.toBeUndefined()
  })

  test('starts immediately with one interval and stops cleanly', async () => {
    vi.useFakeTimers()
    const claim = vi.fn().mockResolvedValue([])
    const worker = createWelcomeEmailWorker({
      pool: {} as any, claim, intervalMs: 5_000, logger: { info: vi.fn(), error: vi.fn() },
    })

    worker.start()
    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(claim).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(claim).toHaveBeenCalledTimes(2)
    await worker.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
