import { describe, expect, test } from 'vitest'
import {
  ERROR_CODE_ALLOWLIST,
  isAllowedErrorCode,
  redactSensitive,
  structuredLogLine,
} from '../logging.js'
import { createMemoryMetrics } from '../metrics.js'

describe('log redaction', () => {
  test('masks bearer tokens, jwt material and long opaque strings', () => {
    expect(redactSensitive('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'))
      .not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig')
    expect(redactSensitive('cursor=abc123def456abc123def456abc123def456'))
      .not.toContain('abc123def456abc123def456abc123def456')
  })

  test('masks absolute paths but keeps relative references', () => {
    expect(redactSensitive('failed reading /Users/alice/secret/repo')).toBe(
      'failed reading [path]',
    )
    expect(redactSensitive('module relay/http-client failed')).toBe(
      'module relay/http-client failed',
    )
  })

  test('drops known-sensitive field names entirely', () => {
    const line = structuredLogLine('info', 'feed_pulled', {
      installation_id: '11111111-1111-1111-1111-111111111111',
      session_id: 'ses-secret',
      lease_token: 'lease-secret-0123456789',
      cursor: 'opaque-cursor-material',
      body: 'user prompt text',
      detail: 'snapshot session pagination incomplete for ses-secret-detail',
      count: 5,
    })
    expect(line).not.toContain('ses-secret')
    expect(line).not.toContain('lease-secret')
    expect(line).not.toContain('opaque-cursor')
    expect(line).not.toContain('user prompt')
    expect(line).not.toContain('ses-secret-detail')
    expect(line).toContain('"count":5')
  })

  test('bounds every value length', () => {
    const long = 'x'.repeat(5000)
    expect(redactSensitive(long).length).toBeLessThanOrEqual(256)
  })

  test('exposes a frozen error-code allowlist', () => {
    for (const code of ['relay_unavailable', 'provider_auth_failed', 'cursor_expired', 'feed_integrity', 'projection_backlog', 'purge_failed']) {
      expect(isAllowedErrorCode(code), code).toBe(true)
    }
    expect(isAllowedErrorCode('something arbitrary')).toBe(false)
    expect(isAllowedErrorCode('')).toBe(false)
    expect(Object.isFrozen(ERROR_CODE_ALLOWLIST)).toBe(true)
  })
})

describe('bounded metrics registry', () => {
  test('registers exactly the frozen memory metrics', async () => {
    const { registry } = createMemoryMetrics()
    const names = (await registry.getMetricsAsArray()).map(metric => metric.name)
    for (const expected of [
      'pocketctl_memory_installations',
      'pocketctl_memory_feed_pulls_total',
      'pocketctl_memory_feed_acks_total',
      'pocketctl_memory_feed_lag_seconds',
      'pocketctl_memory_inbox_rows',
      'pocketctl_memory_projection_total',
      'pocketctl_memory_jobs',
      'pocketctl_memory_snapshot_total',
      'pocketctl_memory_purge_total',
      'pocketctl_memory_relay_requests_total',
      'pocketctl_memory_relay_request_duration_seconds',
      'pocketctl_memory_usage_outbox_rows',
    ]) {
      expect(names, expected).toContain(expected)
    }
  })

  test('label names stay on fixed low-cardinality allowlists', async () => {
    const { registry, feedPulls } = createMemoryMetrics()
    feedPulls.inc({ result: 'delivered' })
    feedPulls.inc({ result: 'stale_lease' })
    const text = await registry.metrics()
    expect(text).not.toContain('installation_id')
    expect(text).not.toContain('session_id')
    expect(text).toContain('result="delivered"')
    // The exposition only ever shows the frozen label dimensions.
    const exposition = text.split('\n')
      .filter(line => line.startsWith('pocketctl_memory_feed_pulls_total'))
    for (const line of exposition) {
      const labels = [...line.matchAll(/([a-z_]+)=/g)].map(match => match[1])
      expect(labels.every(label => label === 'result')).toBe(true)
    }
  })

  test('job and relay metrics use fixed label sets', async () => {
    const { registry, jobs, relayRequests } = createMemoryMetrics()
    jobs.set({ type: 'project_feed', state: 'pending' }, 3)
    relayRequests.inc({ operation: 'pull_feed', result: 'ok' }, 1)
    const text = await registry.metrics()
    expect(text).toContain('type="project_feed"')
    expect(text).toContain('operation="pull_feed"')
  })
})
