import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client'

// This registry is intentionally process-local and only records bounded,
// aggregate dimensions. Do not add daemon, user, session, request, event, or
// host identifiers as labels.
export const registry = new Registry()
collectDefaultMetrics({ register: registry, prefix: 'pocketctl_' })

export const ingressEvents = new Counter({
  name: 'pocketctl_relay_ingress_events_total',
  help: 'Durable ingress events by bounded priority and result',
  labelNames: ['priority', 'result'] as const,
  registers: [registry],
})

export const ackLatency = new Histogram({
  name: 'pocketctl_relay_ack_latency_seconds',
  help: 'Ingress receive to durable ACK latency',
  buckets: [.01, .025, .05, .1, .25, .5, 1, 2, 5],
  registers: [registry],
})

export const ingressQueueDepth = new Gauge({
  name: 'pocketctl_relay_ingress_queue_depth',
  help: 'Current in-process durable ingress queue depth',
  registers: [registry],
})

export const ingressBatchSize = new Histogram({
  name: 'pocketctl_relay_ingress_batch_size',
  help: 'Durable ingress batch size',
  buckets: [1, 4, 16, 32, 64, 128, 256],
  registers: [registry],
})

export const inboxPoolWait = new Histogram({
  name: 'pocketctl_inbox_pool_wait_seconds',
  help: 'Time waiting for an inbox database pool client',
  buckets: [.001, .005, .01, .025, .05, .1, .25, .5, 1, 2, 5],
  registers: [registry],
})

export const inboxOldestSeconds = new Gauge({
  name: 'pocketctl_inbox_oldest_seconds',
  help: 'Age of the oldest claimed or pending inbox row observed by a worker',
  registers: [registry],
})

export const workerBacklog = new Gauge({
  name: 'pocketctl_inbox_worker_backlog',
  help: 'Rows claimed by the inbox worker in its most recent batch',
  registers: [registry],
})

export const workerBatchSize = new Histogram({
  name: 'pocketctl_inbox_worker_batch_size',
  help: 'Inbox worker claimed batch size',
  buckets: [1, 4, 16, 32, 64, 128, 256],
  registers: [registry],
})

export const workerRetries = new Counter({
  name: 'pocketctl_inbox_worker_retries_total',
  help: 'Inbox worker retry and dead-letter outcomes by bounded category',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export const tokenUsageShadowComparisons = new Counter({
  name: 'pocketctl_token_usage_shadow_comparisons_total',
  help: 'Token dashboard shadow comparisons by aggregate result',
  labelNames: ['result'] as const,
  registers: [registry],
})

export const tokenUsageDayClosures = new Counter({
  name: 'pocketctl_token_usage_day_closures_total',
  help: 'UTC token accounting day closure attempts by bounded result',
  labelNames: ['result'] as const,
  registers: [registry],
})

// Emit zero-value gauges immediately so a freshly started Relay has a stable
// diagnostic surface before the first ingress event or worker poll.
ingressQueueDepth.set(0)
inboxOldestSeconds.set(0)
workerBacklog.set(0)

export function observeInboxOldest(rows: ReadonlyArray<{ receivedAt: Date }>, now: Date): void {
  if (rows.length === 0) {
    inboxOldestSeconds.set(0)
    return
  }
  const oldest = Math.min(...rows.map((row) => row.receivedAt.getTime()))
  inboxOldestSeconds.set(Math.max(0, (now.getTime() - oldest) / 1000))
}
