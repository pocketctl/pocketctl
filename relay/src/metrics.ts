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

export const inboxClaimSeconds = new Histogram({
  name: 'pocketctl_inbox_claim_seconds',
  help: 'Inbox claim statement latency',
  buckets: [.001, .0025, .005, .01, .025, .05, .1, .25, .5, 1, 2, 5],
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

export const workerClaimedRows = new Counter({
  name: 'pocketctl_inbox_worker_claimed_rows_total',
  help: 'Inbox rows claimed by the worker across bounded drain passes',
  registers: [registry],
})

export const workerDrainPasses = new Histogram({
  name: 'pocketctl_inbox_worker_drain_passes',
  help: 'Productive claim passes per inbox worker drain run',
  buckets: [0, 1, 2, 4, 8, 16, 32],
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

export const attentionRecoveryTransitions = new Counter({
  name: 'pocketctl_attention_recovery_transitions_total',
  help: 'Recovery projection transitions by bounded outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

export const attentionRecoveryQuickResolutions = new Counter({
  name: 'pocketctl_attention_recovery_quick_resolutions_total',
  help: 'Recovery items resolved within 60 seconds, used as a false-positive proxy',
  registers: [registry],
})

export const attentionRecoveryOpen = new Gauge({
  name: 'pocketctl_attention_recovery_open',
  help: 'Current number of open recovery items observed by maintenance',
  registers: [registry],
})

// ADR-0003 extension platform projector metrics. Labels stay bounded: topics
// come from the frozen allowlist and outcomes from a closed set. No user,
// session, installation, provider version, or feed identifiers appear here.
export const extensionSourceBacklog = new Gauge({
  name: 'pocketctl_extension_source_backlog',
  help: 'Unprojected extension source journal rows',
  registers: [registry],
})

export const extensionFeedProjected = new Counter({
  name: 'pocketctl_extension_feed_projected_total',
  help: 'Extension feed rows projected by bounded topic and result',
  labelNames: ['topic', 'result'] as const,
  registers: [registry],
})

export const extensionProjectorBatchSize = new Histogram({
  name: 'pocketctl_extension_projector_batch_size',
  help: 'Extension projector batch size',
  buckets: [1, 4, 16, 32, 64, 128, 256, 500],
  registers: [registry],
})

export const extensionProjectorLagSeconds = new Gauge({
  name: 'pocketctl_extension_projector_lag_seconds',
  help: 'Age of the oldest unprojected extension source row in seconds',
  registers: [registry],
})

export const extensionProjectorRetries = new Counter({
  name: 'pocketctl_extension_projector_retries_total',
  help: 'Extension projector batch retries by bounded outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
})

// ADR-0003 provider control-plane metrics. The provider label only ever
// carries catalog allowlist ids (unknown ids collapse to 'unknown').
export function boundedProviderLabel(providerId: string | undefined | null): string {
  const ALLOWED = new Set(['pocketctl-memory'])
  return ALLOWED.has(providerId ?? '') ? (providerId as string) : 'unknown'
}

export const extensionProviderStatusReports = new Counter({
  name: 'pocketctl_extension_provider_status_reports_total',
  help: 'Provider status reports by bounded provider and result',
  labelNames: ['provider', 'result'] as const,
  registers: [registry],
})

export const extensionFeedPulls = new Counter({
  name: 'pocketctl_extension_feed_pull_total',
  help: 'Extension feed pulls by bounded provider and result',
  labelNames: ['provider', 'result'] as const,
  registers: [registry],
})

export const extensionFeedAcks = new Counter({
  name: 'pocketctl_extension_feed_ack_total',
  help: 'Extension feed acks by bounded provider and result',
  labelNames: ['provider', 'result'] as const,
  registers: [registry],
})

export const extensionPurgePending = new Gauge({
  name: 'pocketctl_extension_purge_pending',
  help: 'Pending provider purge requests',
  registers: [registry],
})

export const extensionUsageIngested = new Counter({
  name: 'pocketctl_extension_usage_ingested_total',
  help: 'Provider usage facts ingested by allowlisted operation and result',
  labelNames: ['operation', 'result'] as const,
  registers: [registry],
})

// Emit zero-value gauges immediately so a freshly started Relay has a stable
// diagnostic surface before the first ingress event or worker poll.
ingressQueueDepth.set(0)
inboxOldestSeconds.set(0)
workerBacklog.set(0)
attentionRecoveryOpen.set(0)
extensionSourceBacklog.set(0)
extensionProjectorLagSeconds.set(0)
extensionPurgePending.set(0)

export function observeInboxOldest(rows: ReadonlyArray<{ receivedAt: Date }>, now: Date): void {
  if (rows.length === 0) {
    inboxOldestSeconds.set(0)
    return
  }
  const oldest = Math.min(...rows.map((row) => row.receivedAt.getTime()))
  inboxOldestSeconds.set(Math.max(0, (now.getTime() - oldest) / 1000))
}
