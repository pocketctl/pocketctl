import { expect, test } from 'vitest'
import { FairIngressQueue } from '../ingress/fair-queue.js'
import type { IngressEnvelope, PriorityClass } from '../ingress/types.js'

function eventFor(
  daemonId: string,
  seq: number,
  priority: PriorityClass = 'live',
  payload: Record<string, unknown> = { type: priority, seq },
): IngressEnvelope {
  return {
    userId: 1,
    daemonId,
    registrationId: `${daemonId}-registration`,
    daemonGeneration: 1,
    seq,
    dedupKey: `${daemonId}:${seq}`,
    sessionId: 's1',
    eventType: priority,
    priority,
    payload,
    materializationContext: {},
    receivedAt: new Date(0),
  }
}

test('rejects per-daemon and global capacity before enqueueing', () => {
  const queue = new FairIngressQueue({
    maxEventsPerDaemon: 1,
    maxBytesPerDaemon: 1024,
    maxEvents: 2,
    maxBytes: 2048,
  })

  expect(queue.enqueue(eventFor('d1', 1)).kind).toBe('accepted')
  expect(queue.enqueue(eventFor('d1', 2))).toMatchObject({ kind: 'backpressured', state: { reason: 'ingest_backpressure' } })
  expect(queue.enqueue(eventFor('d2', 1)).kind).toBe('accepted')
  expect(queue.enqueue(eventFor('d3', 1))).toMatchObject({ kind: 'backpressured' })
})

test('no daemon contributes more than 25 percent while peers are ready', () => {
  const queue = new FairIngressQueue()
  for (let i = 0; i < 1000; i++) queue.enqueue(eventFor('noisy', i))
  for (const id of ['d2', 'd3', 'd4']) {
    for (let i = 0; i < 100; i++) queue.enqueue(eventFor(id, i))
  }

  const batch = queue.takeBatch({ maxRows: 256, maxBytes: 1 << 20, maxPerDaemonFraction: 0.25 })
  expect(batch.filter((item) => item.daemonId === 'noisy')).toHaveLength(64)
})

test('control and live win without starving replay and aggregate', () => {
  const queue = new FairIngressQueue()
  for (let i = 0; i < 100; i++) {
    queue.enqueue(eventFor('d1', i * 4 + 1, 'control'))
    queue.enqueue(eventFor('d1', i * 4 + 2, 'live'))
    queue.enqueue(eventFor('d1', i * 4 + 3, 'replay'))
    queue.enqueue(eventFor('d1', i * 4 + 4, 'aggregate'))
  }

  const priorities: PriorityClass[] = []
  for (let i = 0; i < 9; i++) {
    const batch = queue.takeBatch({ maxRows: 10, maxBytes: 1 << 20, maxPerDaemonFraction: 1 })
    priorities.push(...batch.map((item) => item.priority))
    queue.commitBatch(batch)
  }
  const counts = priorities.reduce<Record<PriorityClass, number>>((result, priority) => {
    result[priority]++
    return result
  }, { control: 0, live: 0, replay: 0, aggregate: 0 })
  expect(counts.control + counts.live).toBeGreaterThan(counts.replay + counts.aggregate)
  expect(counts.replay).toBeGreaterThanOrEqual(9)
  expect(counts.aggregate).toBeGreaterThanOrEqual(9)
  expect(priorities.slice(0, 4)).toEqual(['control', 'control', 'control', 'control'])
})

test('returns a batch promptly from 50,000 queued events', () => {
  const queue = new FairIngressQueue({ maxEvents: 50_000, maxBytes: 64 << 20 })
  let accepted = 0
  for (let i = 0; i < 50_000; i++) {
    if (queue.enqueue(eventFor(`d${i % 50}`, i)).kind === 'accepted') accepted++
  }
  expect(accepted).toBe(50_000)
  expect(queue.size).toBe(50_000)

  const started = performance.now()
  const batch = queue.takeBatch({ maxRows: 256, maxBytes: 1 << 20, maxPerDaemonFraction: 1 })
  expect(batch).toHaveLength(256)
  expect(performance.now() - started).toBeLessThan(1_000)
})

test('requeues a failed batch at the front without reordering', () => {
  const queue = new FairIngressQueue()
  queue.enqueue(eventFor('d1', 1))
  queue.enqueue(eventFor('d1', 2))
  queue.enqueue(eventFor('d1', 3))
  const first = queue.takeBatch({ maxRows: 2, maxBytes: 1 << 20, maxPerDaemonFraction: 1 })
  queue.requeueFront(first)
  expect(queue.takeBatch({ maxRows: 3, maxBytes: 1 << 20, maxPerDaemonFraction: 1 }).map((item) => item.seq)).toEqual([1, 2, 3])
})

test('reserves in-flight capacity until commit and repeated requeue does not grow accounting', () => {
  const queue = new FairIngressQueue({
    maxEventsPerDaemon: 2, maxBytesPerDaemon: 4096, maxEvents: 2, maxBytes: 4096,
  })
  queue.enqueue(eventFor('d1', 1))
  queue.enqueue(eventFor('d1', 2))
  let batch = queue.takeBatch({ maxRows: 2, maxBytes: 4096, maxPerDaemonFraction: 1 })
  expect(queue.size).toBe(0)
  expect(queue.enqueue(eventFor('d1', 3)).kind).toBe('backpressured')

  for (let attempt = 0; attempt < 3; attempt++) {
    queue.requeueFront(batch)
    expect(queue.size).toBe(2)
    expect(queue.enqueue(eventFor('d1', 3)).kind).toBe('backpressured')
    batch = queue.takeBatch({ maxRows: 2, maxBytes: 4096, maxPerDaemonFraction: 1 })
  }
  queue.commitBatch(batch)
  expect(queue.enqueue(eventFor('d1', 3)).kind).toBe('accepted')
})

test('rejects an event above the hard byte limit and never returns a batch over maxBytes', () => {
  const queue = new FairIngressQueue()
  expect(queue.enqueue(eventFor('d1', 1, 'live', { data: 'x'.repeat((1 << 20) + 1) }))).toMatchObject({
    kind: 'backpressured',
    state: { reason: 'event_too_large', blockedSeq: 1 },
  })
  expect(queue.size).toBe(0)

  queue.enqueue(eventFor('d1', 2, 'live', { data: 'x'.repeat(600_000) }))
  queue.enqueue(eventFor('d2', 3, 'live', { data: 'x'.repeat(600_000) }))
  const batch = queue.takeBatch({ maxRows: 2, maxBytes: 1 << 20, maxPerDaemonFraction: 1 })
  const bytes = batch.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event.payload)), 0)
  expect(bytes).toBeLessThanOrEqual(1 << 20)
})

test('taking a batch does not scan historical empty daemon ids', () => {
  const queue = new FairIngressQueue({ maxEvents: 10_000, maxBytes: 64 << 20 })
  for (let i = 0; i < 5_000; i++) queue.enqueue(eventFor(`old-${i}`, 1))
  while (queue.size > 0) {
    const batch = queue.takeBatch({ maxRows: 256, maxBytes: 1 << 20, maxPerDaemonFraction: 1 })
    queue.commitBatch(batch)
  }
  queue.enqueue(eventFor('active', 1))
  const started = performance.now()
  expect(queue.takeBatch({ maxRows: 1, maxBytes: 1 << 20, maxPerDaemonFraction: 1 })).toHaveLength(1)
  expect(performance.now() - started).toBeLessThan(100)
})
