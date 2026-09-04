import Fastify from 'fastify'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createInboxWorker } from '../inbox-worker.js'
import {
  registry,
  extensionSourceBacklog,
  extensionFeedProjected,
  extensionProjectorBatchSize,
  extensionProjectorLagSeconds,
  extensionProjectorRetries,
  boundedProviderLabel,
} from '../metrics.js'
import type { InboxRow } from '../ingress/inbox-repository.js'

type MetricsRoute = (
  app: ReturnType<typeof Fastify>,
  dependencies: { verifyAccessToken(token: string): Promise<unknown>; metrics: () => Promise<string> },
) => void

type MetricsRegistry = { metrics(): Promise<string> }

describe('protected aggregate relay metrics', () => {
  const apps: Array<ReturnType<typeof Fastify>> = []

  beforeAll(() => {
    vi.stubEnv('JWT_SECRET', 'metrics-test-secret')
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  test('metrics route rejects an unauthenticated request without a metrics body', async () => {
    const { registerRelayMetricsRoute } = await import('../relay-metrics-route.js') as { registerRelayMetricsRoute?: MetricsRoute }
    expect(registerRelayMetricsRoute).toBeTypeOf('function')
    const app = Fastify()
    apps.push(app)
    registerRelayMetricsRoute!(app, {
      verifyAccessToken: vi.fn(async () => ({ userId: 1 })),
      metrics: vi.fn(async () => 'pocketctl_relay_ingress_events_total 1\n'),
    })

    const response = await app.inject({ method: 'GET', url: '/internal/metrics' })

    expect(response.statusCode).toBe(401)
    expect(response.body).not.toContain('pocketctl_')
  })

  test('metrics route rejects an invalid Bearer token without a metrics body', async () => {
    const { registerRelayMetricsRoute } = await import('../relay-metrics-route.js') as { registerRelayMetricsRoute?: MetricsRoute }
    expect(registerRelayMetricsRoute).toBeTypeOf('function')
    const app = Fastify()
    apps.push(app)
    registerRelayMetricsRoute!(app, {
      verifyAccessToken: vi.fn(async () => null),
      metrics: vi.fn(async () => 'pocketctl_relay_ingress_events_total 1\n'),
    })

    const response = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { authorization: 'Bearer invalid' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.body).not.toContain('pocketctl_')
  })

  test('aggregate registry never exposes daemon or session identifiers as labels', async () => {
    const { registry: relayMetricsRegistry } = await import('../metrics.js') as { registry?: MetricsRegistry }
    expect(relayMetricsRegistry).toBeDefined()

    const text = await relayMetricsRegistry!.metrics()

    expect(text).not.toContain('daemon_id=')
    expect(text).not.toContain('session_id=')
    expect(text).not.toContain('token=')
    expect(text).toContain('pocketctl_relay_ingress_events_total')
    expect(text).toContain('pocketctl_inbox_oldest_seconds')
    expect(text).toContain('pocketctl_token_usage_shadow_comparisons_total')
    expect(text).toContain('pocketctl_token_usage_day_closures_total')
  })
})

function drainRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    inboxId: 1, userId: 1, daemonId: 'd1', daemonGeneration: 1, seq: 1,
    dedupKey: 'event-1', sessionId: 'session-1', eventType: 'agent_text', priorityClass: 1,
    schemaVersion: 1, occurredAt: null, receivedAt: new Date(0), payload: { type: 'agent_text' },
    materializationContext: {},
    status: 1, attempts: 1, availableAt: new Date(0), claimedAt: new Date(0), claimedBy: 'worker',
    completedAt: null, materializedEventId: null, lastError: null,
    ...overrides,
  }
}

function orderedRowsRepository(total: number) {
  const rows: InboxRow[] = Array.from({ length: total }, (_, index) => drainRow({
    inboxId: index + 1,
    seq: index + 1,
    dedupKey: `event-${index + 1}`,
  }))
  let next = 0
  return {
    resetStaleClaims: vi.fn().mockResolvedValue(0),
    claimBatch: vi.fn(async () => {
      if (next >= rows.length) return []
      const claimed = [rows[next]]
      next += 1
      return claimed
    }),
    renewClaims: vi.fn().mockResolvedValue(new Set<number>()),
    complete: vi.fn().mockResolvedValue(undefined),
    reschedule: vi.fn().mockResolvedValue(undefined),
    deadLetter: vi.fn().mockResolvedValue(undefined),
  }
}

function sampleLine(metricsText: string, name: string): string {
  return metricsText
    .split('\n')
    .find(line => line.startsWith(`${name} `)) ?? ''
}

async function claimedRowsValue(): Promise<number> {
  const text = await registry.metrics()
  return Number(sampleLine(text, 'pocketctl_inbox_worker_claimed_rows_total').split(' ')[1] ?? 0)
}

async function drainPassesValue(suffix: 'sum' | 'count'): Promise<number> {
  const metric = (await registry.getMetricsAsJSON())
    .find(entry => entry.name === 'pocketctl_inbox_worker_drain_passes')
  return (metric?.values as Array<{ metricName?: string; value: number }> | undefined)
    ?.find(value => value.metricName === `pocketctl_inbox_worker_drain_passes_${suffix}`)?.value ?? 0
}

async function claimSecondsValue(suffix: 'sum' | 'count'): Promise<number> {
  const metric = (await registry.getMetricsAsJSON())
    .find(entry => entry.name === 'pocketctl_inbox_claim_seconds')
  return (metric?.values as Array<{ metricName?: string; value: number }> | undefined)
    ?.find(value => value.metricName === `pocketctl_inbox_claim_seconds_${suffix}`)?.value ?? 0
}

describe('inbox worker drain metrics', () => {
  test('counts claimed rows and drain passes as label-free aggregates', async () => {
    const repository = orderedRowsRepository(200)
    const worker = createInboxWorker({
      repository,
      materializer: { materialize: vi.fn().mockResolvedValue({ eventId: 1, deliveries: [] }) } as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      maxDrainPasses: 32,
      pollIntervalMs: 50,
    })
    const claimedBefore = await claimedRowsValue()
    const countBefore = await drainPassesValue('count')
    const sumBefore = await drainPassesValue('sum')

    await worker.runOnce()

    const metricsText = await registry.metrics()
    const claimedLine = sampleLine(metricsText, 'pocketctl_inbox_worker_claimed_rows_total')
    expect(claimedLine).toMatch(/^pocketctl_inbox_worker_claimed_rows_total \d+$/)
    expect(claimedLine.includes('{')).toBe(false)
    expect(await claimedRowsValue() - claimedBefore).toBe(32)
    expect(await drainPassesValue('count') - countBefore).toBe(1)
    expect(await drainPassesValue('sum') - sumBefore).toBe(32)
  })

  test('does not count rows for an empty drain probe', async () => {
    const repository = orderedRowsRepository(1)
    const worker = createInboxWorker({
      repository,
      materializer: { materialize: vi.fn().mockResolvedValue({ eventId: 1, deliveries: [] }) } as never,
      workerId: 'worker',
      shardCount: 1,
      shardIndex: 0,
      maxDrainPasses: 32,
      pollIntervalMs: 50,
    })
    const claimedBefore = await claimedRowsValue()

    await worker.runOnce()

    expect(await claimedRowsValue() - claimedBefore).toBe(1)
    // The empty probe neither claims rows nor observes a productive pass.
    const repositoryAfterDrain = repository.claimBatch.mock.calls.length
    expect(repositoryAfterDrain).toBe(2)
  })
})

describe('inbox claim latency histogram', () => {
  test('observes claim statement duration with no identity labels, including failures', async () => {
    const { InboxRepository } = await import('../ingress/inbox-repository.js')
    const countBefore = await claimSecondsValue('count')

    const repo = new InboxRepository({
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as never)
    await repo.claimBatch({ workerId: 'worker', limit: 5, shardCount: 1, shardIndex: 0 })

    const failing = new InboxRepository({
      query: vi.fn(async () => { throw new Error('injected claim statement failure') }),
    } as never)
    await expect(failing.claimBatch({ workerId: 'worker', limit: 5, shardCount: 1, shardIndex: 0 }))
      .rejects.toThrow('injected claim statement failure')

    expect(await claimSecondsValue('count') - countBefore).toBe(2)
    expect(await claimSecondsValue('sum')).toBeGreaterThan(0)

    const text = await registry.metrics()
    expect(text).toContain('pocketctl_inbox_claim_seconds_bucket{le="0.001"}')
    expect(text).toContain('pocketctl_inbox_claim_seconds_bucket{le="5"}')
    expect(text).toContain('pocketctl_inbox_claim_seconds_sum')
    expect(text).toContain('pocketctl_inbox_claim_seconds_count')
    for (const forbidden of [
      'daemon_id=', 'daemon_generation=', 'generation=', 'session_id=',
      'user_id=', 'request_id=', 'token=', 'event_id=', 'claimed_by=',
    ]) {
      expect(text).not.toContain(`pocketctl_inbox_claim_seconds_bucket{le="0.001", ${forbidden}`)
      expect(text).not.toContain(`pocketctl_inbox_claim_seconds_bucket{${forbidden}`)
    }
  })
})


describe('extension platform metrics registration', () => {
  test('registers every projector metric under its frozen name', async () => {
    const metrics = await registry.getMetricsAsJSON()
    const names = new Set(metrics.map((family: { name: string }) => family.name))
    expect(names.has('pocketctl_extension_source_backlog')).toBe(true)
    expect(names.has('pocketctl_extension_feed_projected_total')).toBe(true)
    expect(names.has('pocketctl_extension_projector_batch_size')).toBe(true)
    expect(names.has('pocketctl_extension_projector_lag_seconds')).toBe(true)
    expect(names.has('pocketctl_extension_projector_retries_total')).toBe(true)
    expect(names.has('pocketctl_extension_purge_pending')).toBe(true)
    expect(names.has('pocketctl_extension_feed_pull_total')).toBe(true)
    expect(names.has('pocketctl_extension_feed_ack_total')).toBe(true)
    expect(names.has('pocketctl_extension_usage_ingested_total')).toBe(true)
    expect(names.has('pocketctl_extension_provider_status_reports_total')).toBe(true)
  })

  test('provider labels collapse to the allowlist; topic boundedness stays call-site enforced', () => {
    extensionFeedProjected.inc({ topic: 'session.event.v1', result: 'projected' })
    extensionProjectorRetries.inc({ outcome: 'connection_error' })
    expect(() => extensionFeedProjected.inc({ topic: 'not-a-topic' as never, result: 'projected' }))
      .not.toThrow() // counter labels are strings; boundedness is enforced at call sites
    expect(boundedProviderLabel('pocketctl-memory')).toBe('pocketctl-memory')
    expect(boundedProviderLabel('evil-provider')).toBe('unknown')
    expect(boundedProviderLabel(undefined)).toBe('unknown')
    expect(boundedProviderLabel('')).toBe('unknown')
  })

  test('gauges and histograms observe without label cardinality', async () => {
    extensionSourceBacklog.set(3)
    extensionProjectorLagSeconds.set(12)
    extensionProjectorBatchSize.observe(42)
    const snapshot = await extensionSourceBacklog.get()
    expect(snapshot.values[0].value).toBe(3)
  })
})
