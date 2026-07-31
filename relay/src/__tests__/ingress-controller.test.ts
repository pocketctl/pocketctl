import { expect, test, vi } from 'vitest'
import { IngressController, checkpointKey, type IngressConnection } from '../ingress/controller.js'
import { FairIngressQueue } from '../ingress/fair-queue.js'
import type { AckCheckpoint, IngressEnvelope } from '../ingress/types.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

const connection: IngressConnection = {
  daemonId: 'd1', registrationId: 'r1', userId: 1, daemonGeneration: 17,
}

function payload(seq: number) {
  return { type: 'session_status', session_id: 's1', seq, event_id: `e-${seq}` }
}

function checkpoint(seq: number): Map<string, AckCheckpoint> {
  return new Map([[checkpointKey('d1', 17), { daemonId: 'd1', daemonGeneration: 17, ackSeq: seq }]])
}

test('sends one contiguous ack only after repository commit', async () => {
  const persisted = deferred<Map<string, AckCheckpoint>>()
  const sendAck = vi.fn()
  const controller = new IngressController({
    repository: { persistBatch: () => persisted.promise }, sendAck, disconnectRetryable: vi.fn(),
  })
  expect(controller.accept(connection, payload(1))).toEqual({ kind: 'accepted' })
  const flushing = controller.flushNow()
  expect(sendAck).not.toHaveBeenCalled()
  persisted.resolve(checkpoint(1))
  await flushing
  expect(sendAck).toHaveBeenCalledWith('d1', expect.objectContaining({ ackSeq: 1 }), 128)
})

test('persists sequenced ephemeral events as receipt-only ACK members', async () => {
  const persistBatch = vi.fn(async (events: IngressEnvelope[]) => checkpoint(events.at(-1)!.seq))
  const sendAck = vi.fn()
  const controller = new IngressController({
    repository: { persistBatch }, sendAck, disconnectRetryable: vi.fn(),
  })

  expect(controller.accept(connection, {
    type: 'generate_subagent_title_request',
    session_id: 's1',
    seq: 1,
    event_id: 'jsonl:source:3:0:title',
  })).toEqual({ kind: 'accepted' })
  await controller.flushNow()

  expect(persistBatch).toHaveBeenCalledWith([
    expect.objectContaining({
      seq: 1,
      eventType: 'generate_subagent_title_request',
      priority: 'aggregate',
      receiptOnly: true,
    }),
  ])
  expect(sendAck).toHaveBeenCalledWith('d1', expect.objectContaining({ ackSeq: 1 }), 128)
})

test('does not ack a failed batch and retries it from the queue front', async () => {
  vi.useFakeTimers()
  const persistBatch = vi.fn<(_: IngressEnvelope[]) => Promise<Map<string, AckCheckpoint>>>()
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValueOnce(checkpoint(2))
  const sendAck = vi.fn()
  const sendFlowControl = vi.fn()
  const controller = new IngressController({ repository: { persistBatch }, sendAck, sendFlowControl, disconnectRetryable: vi.fn() })
  controller.accept(connection, payload(1))
  controller.accept(connection, payload(2))
  await controller.flushNow()
  expect(sendAck).not.toHaveBeenCalled()
  expect(sendFlowControl).toHaveBeenCalledWith(connection, expect.objectContaining({ window: 1, reason: 'ingest_backpressure' }))
  await vi.advanceTimersByTimeAsync(25)
  expect(persistBatch.mock.calls.map(([batch]) => batch.map((event) => event.seq))).toEqual([[1, 2], [1, 2]])
  expect(sendAck).toHaveBeenCalledWith('d1', expect.objectContaining({ ackSeq: 2 }), 128)
  vi.useRealTimers()
})

test('automatically drains 257 events as two serial batches', async () => {
  const persistBatch = vi.fn(async (events: IngressEnvelope[]) => checkpoint(events.at(-1)!.seq))
  const sendAck = vi.fn()
  const controller = new IngressController({
    repository: { persistBatch }, sendAck, disconnectRetryable: vi.fn(),
  })
  for (let seq = 1; seq <= 257; seq++) controller.accept(connection, payload(seq))

  await controller.flushNow()
  expect(persistBatch.mock.calls.map(([batch]) => batch.length)).toEqual([256, 1])
  expect(sendAck.mock.calls.map(([, value]) => value.ackSeq)).toEqual([256, 257])
})

test('stop drains multiple batches before its deadline', async () => {
  const persistBatch = vi.fn(async (events: IngressEnvelope[]) => checkpoint(events.at(-1)!.seq))
  const sendAck = vi.fn()
  const controller = new IngressController({
    repository: { persistBatch }, sendAck, disconnectRetryable: vi.fn(),
  })
  for (let seq = 1; seq <= 513; seq++) controller.accept(connection, payload(seq))

  await controller.stop({ flushDeadlineMs: 1_500 })
  expect(persistBatch.mock.calls.map(([batch]) => batch.length)).toEqual([256, 256, 1])
  expect(sendAck).toHaveBeenCalledTimes(3)
})

test('shutdown deadline acks committed batches but not a later commit', async () => {
  vi.useFakeTimers()
  const second = deferred<Map<string, AckCheckpoint>>()
  const persistBatch = vi.fn<(_: IngressEnvelope[]) => Promise<Map<string, AckCheckpoint>>>()
    .mockResolvedValueOnce(checkpoint(256))
    .mockReturnValueOnce(second.promise)
  const sendAck = vi.fn()
  const controller = new IngressController({
    repository: { persistBatch }, sendAck, disconnectRetryable: vi.fn(),
  })
  for (let seq = 1; seq <= 513; seq++) controller.accept(connection, payload(seq))
  const stopped = controller.stop({ flushDeadlineMs: 100 })
  for (let turn = 0; turn < 10 && persistBatch.mock.calls.length < 2; turn++) await Promise.resolve()
  expect(sendAck.mock.calls.map(([, value]) => value.ackSeq)).toEqual([256])

  await vi.advanceTimersByTimeAsync(100)
  await stopped
  second.resolve(checkpoint(257))
  await vi.advanceTimersByTimeAsync(0)
  expect(sendAck.mock.calls.map(([, value]) => value.ackSeq)).toEqual([256])
  expect(persistBatch).toHaveBeenCalledTimes(2)
  vi.useRealTimers()
})

test('isolates sendAck exceptions after commit without requeueing or blocking peers', async () => {
  const queue = new FairIngressQueue({
    maxEventsPerDaemon: 2, maxEvents: 2, maxBytesPerDaemon: 4096, maxBytes: 4096,
  })
  const persistBatch = vi.fn(async (events: IngressEnvelope[]) => new Map(
    events.map((event) => [checkpointKey(event.daemonId, event.daemonGeneration), {
      daemonId: event.daemonId, daemonGeneration: event.daemonGeneration, ackSeq: event.seq,
    }]),
  ))
  const ackAttempts: string[] = []
  const sendAck = vi.fn((daemonId: string) => {
    ackAttempts.push(daemonId)
    if (daemonId === 'd1') throw new Error('socket callback failed')
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const controller = new IngressController({
    repository: { persistBatch }, queue, sendAck, disconnectRetryable: vi.fn(),
  })
  const d2 = { ...connection, daemonId: 'd2', registrationId: 'r2' }
  controller.accept(connection, payload(1))
  controller.accept(d2, payload(1))

  await expect(controller.flushNow()).resolves.toBeUndefined()
  expect(persistBatch).toHaveBeenCalledTimes(1)
  expect(ackAttempts).toEqual(['d1', 'd2'])
  expect(error).toHaveBeenCalledWith(
    'durable ingress ack callback failed',
    expect.objectContaining({ daemonId: 'd1', daemonGeneration: 17 }),
  )

  expect(controller.accept(connection, payload(2)).kind).toBe('accepted')
  expect(controller.accept(d2, payload(2)).kind).toBe('accepted')
  await controller.flushNow()
  expect(persistBatch).toHaveBeenCalledTimes(2)
  expect(persistBatch.mock.calls.map(([batch]) => batch.map((event) => `${event.daemonId}:${event.seq}`))).toEqual([
    ['d1:1', 'd2:1'],
    ['d1:2', 'd2:2'],
  ])
  error.mockRestore()
})
