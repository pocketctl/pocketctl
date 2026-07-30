import Fastify from 'fastify'
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

type RegisterReadinessRoute = (
  app: ReturnType<typeof Fastify>,
  getDatabaseReady: () => boolean,
  pool: { query(sql: string): Promise<unknown> },
  buildInfo: Record<string, unknown>,
) => void

type CreateRelayWebSocketHandler = (dependencies: Record<string, unknown>) =>
  (socket: TestSocket, request: Record<string, unknown>) => void

let registerDurableIngressReadinessRoute: RegisterReadinessRoute
let createRelayWebSocketHandler: CreateRelayWebSocketHandler

class TestSocket extends EventEmitter {
  readyState = 1
  readonly sent: unknown[] = []
  readonly closed: Array<{ code: number; reason: string }> = []

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close(code: number, reason: string) {
    this.closed.push({ code, reason })
    this.readyState = 3
  }
}

function websocketDependencies(databaseReady: boolean, order: string[] = []) {
  const releaseAdmission = vi.fn()
  const dependencies = {
    getDatabaseReady: () => databaseReady,
    maxMessageSize: 1_048_576,
    apiKey: '',
    trustProxy: false,
    random: () => 1,
    rateLimiter: {
      check: vi.fn(() => {
        order.push('rate')
        return { allowed: true }
      }),
      gc: vi.fn(),
      recordAuthFailure: vi.fn(() => 0),
      clearAuthFailure: vi.fn(),
    },
    connectionAdmission: {
      tryAcquire: vi.fn(() => {
        order.push('admission')
        return { admitted: true, release: releaseAdmission }
      }),
    },
    verifyAccessToken: vi.fn(async () => {
      order.push('auth')
      return { userId: 42, jti: 'jti-1', machine_id: 'machine-1' }
    }),
    consumeTicket: vi.fn(async () => null),
    decodeToken: vi.fn(() => null),
    registerDaemon: vi.fn(async () => {
      order.push('daemon-register')
      return true
    }),
    createRegistrationDeadline: vi.fn(() => ({
      complete: vi.fn(() => true),
      isActive: vi.fn(() => true),
    })),
    pool: {},
    wsTickets: {},
    wsDaemonMap: new Map(),
    router: {
      unregisterDaemon: vi.fn(),
      handleDaemonMessage: vi.fn(),
      registerClient: vi.fn(() => {
        order.push('client-register')
      }),
      unregisterClient: vi.fn(),
      handleClientMessage: vi.fn(),
    },
  }
  return { dependencies, releaseAdmission }
}

function request(type: 'daemon' | 'client') {
  return {
    query: { type },
    headers: { authorization: 'Bearer live-token' },
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
  }
}

describe('durable ingress readiness', () => {
  const apps: Array<ReturnType<typeof Fastify>> = []

  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET', 'durable-ingress-readiness-test-secret')
    const server = await import('../server.js')
    registerDurableIngressReadinessRoute = (server as unknown as {
      registerDurableIngressReadinessRoute: RegisterReadinessRoute;
    }).registerDurableIngressReadinessRoute
    createRelayWebSocketHandler = (server as unknown as {
      createRelayWebSocketHandler: CreateRelayWebSocketHandler;
    }).createRelayWebSocketHandler
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  test('serves /health/ready as 503 without querying the database until schema initialization completes', async () => {
    let queryCalls = 0
    const app = Fastify()
    apps.push(app)
    registerDurableIngressReadinessRoute(
      app,
      () => false,
      {
        async query() {
          queryCalls += 1
          throw new Error('database must not be queried before readiness')
        },
      },
      { version: 'test-build' },
    )

    const response = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      status: 'not_ready',
      version: 'test-build',
      error: 'database schema initializing',
    })
    expect(queryCalls).toBe(0)
  })

  test('serves /health/ready as ready only after a live database probe', async () => {
    let queryCalls = 0
    const app = Fastify()
    apps.push(app)
    registerDurableIngressReadinessRoute(
      app,
      () => true,
      {
        async query() {
          queryCalls += 1
          return { rows: [{ '?column?': 1 }] }
        },
      },
      { version: 'test-build' },
    )

    const response = await app.inject({ method: 'GET', url: '/health/ready' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', version: 'test-build' })
    expect(queryCalls).toBe(1)
  })

  test('rejects a pre-ready daemon on the real handler path before downstream dependencies', () => {
    const { dependencies } = websocketDependencies(false)
    const socket = new TestSocket()
    const handler = createRelayWebSocketHandler(dependencies)

    handler(socket, request('daemon'))

    expect(socket.sent).toEqual([{ type: 'relay_restarting', retryable: true }])
    expect(socket.closed).toEqual([{ code: 1013, reason: 'relay restarting' }])
    expect(dependencies.rateLimiter.check).not.toHaveBeenCalled()
    expect(dependencies.connectionAdmission.tryAcquire).not.toHaveBeenCalled()
    expect(dependencies.verifyAccessToken).not.toHaveBeenCalled()
    expect(dependencies.registerDaemon).not.toHaveBeenCalled()
    expect(dependencies.router.registerClient).not.toHaveBeenCalled()
    expect(dependencies.rateLimiter.recordAuthFailure).not.toHaveBeenCalled()
  })

  test('keeps ready daemon rate, admission, DB auth, and registration order', async () => {
    const order: string[] = []
    const { dependencies } = websocketDependencies(true, order)
    const socket = new TestSocket()
    const handler = createRelayWebSocketHandler(dependencies)

    handler(socket, request('daemon'))
    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'register',
      daemon_id: 'ready-daemon',
      hostname: 'ready',
      agents: [],
    })))

    await vi.waitFor(() => expect(dependencies.registerDaemon).toHaveBeenCalledOnce())
    expect(order).toEqual(['rate', 'admission', 'auth', 'daemon-register'])
    expect(socket.closed).toEqual([])
  })

  test('keeps non-daemon clients on the existing auth and client registration path while not ready', async () => {
    const order: string[] = []
    const { dependencies, releaseAdmission } = websocketDependencies(false, order)
    const socket = new TestSocket()
    const handler = createRelayWebSocketHandler(dependencies)

    handler(socket, request('client'))

    await vi.waitFor(() => expect(dependencies.router.registerClient).toHaveBeenCalledOnce())
    expect(order).toEqual(['rate', 'admission', 'auth', 'client-register'])
    expect(releaseAdmission).toHaveBeenCalledOnce()
    expect(socket.closed).toEqual([])
  })
})
