import { describe, expect, test, vi } from 'vitest'
import {
  RealtimeOutboxConsumer,
  RealtimeOutboxWriter,
  type RealtimeOutboxClaim,
  type RealtimeOutboxRow,
} from '../materialization/realtime-outbox.js'

function row(overrides: Partial<RealtimeOutboxRow> = {}): RealtimeOutboxRow {
  return {
    outboxId: 11,
    inboxId: 7,
    daemonId: 'daemon-1',
    eventId: 41,
    userId: 9,
    audience: 'session',
    sessionId: 'session-1',
    requestId: null,
    ordinal: 0,
    deliveryKey: 'event:41:session:-:0',
    type: 'agent_text',
    payload: { type: 'agent_text', session_id: 'session-1', text: 'hello' },
    ...overrides,
  }
}

function claim(rows: RealtimeOutboxRow[]) {
  const value: RealtimeOutboxClaim = {
    rows,
    markDelivered: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
  }
  return value
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('realtime outbox consumer', () => {
  test('polls undelivered rows even when no notification arrives', async () => {
    const pending = claim([row()])
    const repository = { claimUndelivered: vi.fn().mockResolvedValue(pending) }
    const deliver = vi.fn()
    const consumer = new RealtimeOutboxConsumer({ repository, deliver })

    await consumer.runOnce()

    expect(deliver).toHaveBeenCalledOnce()
    expect(pending.markDelivered).toHaveBeenCalledWith(11)
    expect(pending.commit).toHaveBeenCalledOnce()
    expect(pending.rollback).not.toHaveBeenCalled()
  })

  test('keeps a delivery pending when no eligible recipient exists', async () => {
    const pending = claim([row({ audience: 'interaction-origin' })])
    const repository = { claimUndelivered: vi.fn().mockResolvedValue(pending) }
    const consumer = new RealtimeOutboxConsumer({
      repository,
      deliver: vi.fn(() => false),
    })

    await consumer.runOnce()

    expect(pending.markDelivered).not.toHaveBeenCalled()
    expect(pending.commit).toHaveBeenCalledOnce()
  })

  test('crash after send rolls back and replays the same stable identity and payload', async () => {
    const delivery = row()
    const first = claim([delivery])
    const second = claim([delivery])
    const repository = {
      claimUndelivered: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    }
    const sent: RealtimeOutboxRow[] = []
    const deliver = vi.fn((value: RealtimeOutboxRow) => {
      sent.push(value)
      if (sent.length === 1) throw new Error('relay crashed after send')
    })
    const consumer = new RealtimeOutboxConsumer({ repository, deliver })

    await expect(consumer.runOnce()).rejects.toThrow('relay crashed after send')
    await consumer.runOnce()

    expect(first.rollback).toHaveBeenCalledOnce()
    expect(first.markDelivered).not.toHaveBeenCalled()
    expect(sent.map(({ eventId, deliveryKey, payload }) => ({ eventId, deliveryKey, payload }))).toEqual([
      { eventId: 41, deliveryKey: 'event:41:session:-:0', payload: delivery.payload },
      { eventId: 41, deliveryKey: 'event:41:session:-:0', payload: delivery.payload },
    ])
  })

  test('notification preempts the fallback poll timer', async () => {
    let wake: (() => void) | undefined
    const timers: Array<() => void> = []
    const clearTimer = vi.fn()
    const repository = {
      claimUndelivered: vi.fn().mockResolvedValue(claim([])),
      subscribe: vi.fn(async (callback: () => void) => {
        wake = callback
        return vi.fn()
      }),
    }
    const consumer = new RealtimeOutboxConsumer({
      repository,
      deliver: vi.fn(),
      setTimer: (callback) => {
        timers.push(callback)
        return { unref: vi.fn() } as any
      },
      clearTimer,
    })

    await consumer.start()
    expect(timers).toHaveLength(1)
    wake?.()

    expect(clearTimer).toHaveBeenCalledOnce()
    expect(timers).toHaveLength(2)
  })

  test('stop unsubscribes even when the active delivery batch fails', async () => {
    let rejectMark: ((error: Error) => void) | undefined
    const pending = claim([row()])
    pending.markDelivered = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectMark = reject
    }))
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    const repository = {
      claimUndelivered: vi.fn().mockResolvedValue(pending),
      subscribe: vi.fn().mockResolvedValue(unsubscribe),
    }
    const consumer = new RealtimeOutboxConsumer({
      repository,
      deliver: vi.fn(),
      setTimer: () => ({ unref: vi.fn() }) as any,
      clearTimer: vi.fn(),
    })
    await consumer.start()
    const running = consumer.runOnce()
    await vi.waitFor(() => expect(pending.markDelivered).toHaveBeenCalledOnce())
    const stopping = consumer.stop()
    rejectMark?.(new Error('mark failed'))

    await expect(running).rejects.toThrow('mark failed')
    await expect(stopping).rejects.toThrow('mark failed')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  test('stop during pending subscribe disposes the late listener and never schedules', async () => {
    let finishSubscribe!: (unsubscribe: () => Promise<void>) => void
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    const repository = {
      claimUndelivered: vi.fn(),
      subscribe: vi.fn(() => new Promise<() => Promise<void>>((resolve) => {
        finishSubscribe = resolve
      })),
    }
    const setTimer = vi.fn(() => ({ unref: vi.fn() }) as any)
    const consumer = new RealtimeOutboxConsumer({ repository, deliver: vi.fn(), setTimer })

    const starting = consumer.start()
    const stopping = consumer.stop()
    finishSubscribe(unsubscribe)

    await Promise.all([starting, stopping])
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(setTimer).not.toHaveBeenCalled()
  })

  test('failed subscribe leaves the consumer stopped and cleaned up', async () => {
    const repository = {
      claimUndelivered: vi.fn(),
      subscribe: vi.fn().mockRejectedValue(new Error('listen failed')),
    }
    const setTimer = vi.fn(() => ({ unref: vi.fn() }) as any)
    const consumer = new RealtimeOutboxConsumer({ repository, deliver: vi.fn(), setTimer })

    await expect(consumer.start()).rejects.toThrow('listen failed')
    await consumer.stop()
    expect(setTimer).not.toHaveBeenCalled()
  })

  test('start A, stop, start B keeps only B when B subscription resolves first', async () => {
    const subscriptions = [deferred<() => Promise<void>>(), deferred<() => Promise<void>>()]
    const unsubscribeA = vi.fn().mockResolvedValue(undefined)
    const unsubscribeB = vi.fn().mockResolvedValue(undefined)
    const timers: Array<() => void> = []
    const clearTimer = vi.fn()
    const repository = {
      claimUndelivered: vi.fn().mockResolvedValue(claim([])),
      subscribe: vi.fn()
        .mockImplementationOnce(() => subscriptions[0].promise)
        .mockImplementationOnce(() => subscriptions[1].promise),
    }
    const consumer = new RealtimeOutboxConsumer({
      repository,
      deliver: vi.fn(),
      setTimer: (callback) => {
        timers.push(callback)
        return { unref: vi.fn() } as any
      },
      clearTimer,
    })

    const startA = consumer.start()
    const stopped = consumer.stop()
    const startB = consumer.start()
    subscriptions[1].resolve(unsubscribeB)
    await startB
    subscriptions[0].resolve(unsubscribeA)
    await Promise.all([startA, stopped])

    expect(unsubscribeA).toHaveBeenCalledOnce()
    expect(unsubscribeB).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)
    await consumer.stop()
    expect(unsubscribeB).toHaveBeenCalledOnce()
    expect(clearTimer).toHaveBeenCalledOnce()
  })

  test('start A, stop, start B releases A first and later runs/stops B cleanly', async () => {
    const subscriptions = [deferred<() => Promise<void>>(), deferred<() => Promise<void>>()]
    const unsubscribeA = vi.fn().mockResolvedValue(undefined)
    const unsubscribeB = vi.fn().mockResolvedValue(undefined)
    const setTimer = vi.fn(() => ({ unref: vi.fn() }) as any)
    const clearTimer = vi.fn()
    const repository = {
      claimUndelivered: vi.fn().mockResolvedValue(claim([])),
      subscribe: vi.fn()
        .mockImplementationOnce(() => subscriptions[0].promise)
        .mockImplementationOnce(() => subscriptions[1].promise),
    }
    const consumer = new RealtimeOutboxConsumer({
      repository, deliver: vi.fn(), setTimer, clearTimer,
    })

    const startA = consumer.start()
    const stopped = consumer.stop()
    const startB = consumer.start()
    subscriptions[0].resolve(unsubscribeA)
    await Promise.all([startA, stopped])
    expect(unsubscribeA).toHaveBeenCalledOnce()
    expect(setTimer).not.toHaveBeenCalled()
    subscriptions[1].resolve(unsubscribeB)
    await startB
    expect(setTimer).toHaveBeenCalledOnce()

    await consumer.stop()
    expect(unsubscribeB).toHaveBeenCalledOnce()
    expect(clearTimer).toHaveBeenCalledOnce()
  })
})

describe('realtime outbox writer', () => {
  test('keeps non-event event_id null and uses the inbox-scoped delivery key', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) } as any
    const writer = new RealtimeOutboxWriter({} as any)

    await writer.enqueue(client, [{
      inboxId: 7,
      daemonId: 'daemon-1',
      eventId: null,
      userId: 9,
      audience: 'interaction-origin',
      sessionId: 'session-1',
      requestId: 'request-1',
      ordinal: 0,
      deliveryKey: 'inbox:7:interaction-origin:request-1:0',
      type: 'interaction_result',
      payload: { type: 'interaction_result', request_id: 'request-1' },
    }])

    const insert = client.query.mock.calls[0]
    expect(insert[0]).toMatch(/INSERT INTO realtime_outbox/)
    expect(insert[1]).toEqual([
      7,
      'inbox:7:interaction-origin:request-1:0',
      null,
      9,
      'session-1',
      'interaction_result',
      'interaction-origin',
      'request-1',
      expect.any(String),
    ])
    expect(insert[1]).not.toContain(0)
  })
})
