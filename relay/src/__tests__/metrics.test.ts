import Fastify from 'fastify'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

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
