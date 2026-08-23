import { beforeAll, describe, expect, test, vi } from 'vitest'

// M-3: before authentication resolves, a connection may only buffer a bounded
// number of early messages and a bounded number of total bytes. Any overflow
// closes the socket immediately (1009), clears the buffered references, and
// the connection never reaches the Router even if authentication later
// succeeds.

let createRelayWebSocketHandler: (dependencies: any) => (socket: any, req: any) => void
let resolveRelayRuntimeConfig: (env?: Record<string, string | undefined>) => any

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'preauth-buffer-test-secret')
  const server = await import('../server.js')
  createRelayWebSocketHandler = (server as any).createRelayWebSocketHandler
  resolveRelayRuntimeConfig = (server as any).resolveRelayRuntimeConfig
})

class FakeSocket {
  readyState = 1
  sent: any[] = []
  closed: { code: number; reason: string }[] = []
  listeners = new Map<string, ((raw: Buffer) => void)[]>()

  on(event: string, handler: (raw: Buffer) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(handler)
    this.listeners.set(event, list)
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close(code: number, reason: string) {
    this.closed.push({ code, reason })
    this.readyState = 3
  }

  emitMessage(raw: Buffer) {
    for (const handler of this.listeners.get('message') ?? []) handler(raw)
  }

  emitClose() {
    this.readyState = 3
    for (const handler of this.listeners.get('close') ?? []) handler(Buffer.alloc(0))
  }
}

function makeHandler(overrides: Record<string, unknown> = {}) {
  const socket = new FakeSocket()
  let resolveAuth: ((value: any) => void) | undefined
  const authGate = new Promise<any>((resolve) => { resolveAuth = resolve })
  const dependencies: any = {
    getDatabaseReady: () => true,
    maxMessageSize: 1024,
    preAuthMaxMessages: 2,
    preAuthMaxBytes: 1024,
    random: () => 1,
    rateLimiter: {
      check: () => ({ allowed: true }),
      gc: vi.fn(),
      recordAuthFailure: vi.fn(() => 0),
      clearAuthFailure: vi.fn(),
    },
    connectionAdmission: {
      tryAcquire: () => ({ admitted: true, release: vi.fn() }),
    },
    // Authentication stays pending until the test resolves the gate.
    verifyAccessToken: () => authGate,
    consumeTicket: vi.fn(async () => ({ userId: 7, jti: 'jti-2', machine_id: 'm-2' })),
    decodeToken: vi.fn(() => null),
    registerDaemon: vi.fn(async () => true),
    createRegistrationDeadline: () => ({ complete: vi.fn(() => true), isActive: vi.fn(() => true) }),
    router: {
      unregisterDaemon: vi.fn(),
      unregisterClient: vi.fn(),
      registerClient: vi.fn(),
      handleClientMessage: vi.fn(),
    },
    wsDaemonMap: new Map(),
    ...overrides,
  }
  const handler = createRelayWebSocketHandler(dependencies)
  return { socket, dependencies, handler, resolveAuth: resolveAuth! }
}

function connect(handler: (socket: any, req: any) => void, socket: FakeSocket) {
  handler(socket, {
    query: { type: 'client' },
    headers: { authorization: 'Bearer pending-token' },
    socket: { remoteAddress: '203.0.113.9' },
    ip: '203.0.113.9',
  })
}

function jsonOfExactLength(len: number): Buffer {
  // {"pad":"…"} frames the payload; pad with 'x' so the buffer is exactly len.
  const buf = Buffer.from(JSON.stringify({ pad: 'x'.repeat(Math.max(0, len - 10)) }))
  if (buf.length !== len) throw new Error(`fixture length ${buf.length} != ${len}`)
  return buf
}

describe('pre-authentication buffer limits (M-3)', () => {
  test('a single oversized frame closes with 1009 before auth completes', async () => {
    const { socket, dependencies, handler } = makeHandler()
    connect(handler, socket)
    socket.emitMessage(Buffer.alloc(1025))
    await new Promise((r) => setTimeout(r, 10))

    expect(socket.closed).toEqual([{ code: 1009, reason: 'message too large' }])
    expect(dependencies.router.registerClient).not.toHaveBeenCalled()
  })

  test('exceeding the message-count cap closes with 1009', async () => {
    const { socket, dependencies, handler } = makeHandler()
    connect(handler, socket)
    socket.emitMessage(Buffer.alloc(10))
    socket.emitMessage(Buffer.alloc(10))
    socket.emitMessage(Buffer.alloc(10)) // third message exceeds preAuthMaxMessages=2
    await new Promise((r) => setTimeout(r, 10))

    expect(socket.closed).toEqual([{ code: 1009, reason: 'message too large' }])
    expect(dependencies.router.registerClient).not.toHaveBeenCalled()
  })

  test('exceeding the total byte cap closes with 1009', async () => {
    const { socket, dependencies, handler } = makeHandler()
    connect(handler, socket)
    socket.emitMessage(Buffer.alloc(600))
    socket.emitMessage(Buffer.alloc(600)) // total 1200 > 1024
    await new Promise((r) => setTimeout(r, 10))

    expect(socket.closed).toEqual([{ code: 1009, reason: 'message too large' }])
    expect(dependencies.router.registerClient).not.toHaveBeenCalled()
  })

  test('overflow clears buffered messages: late auth success never reaches the Router', async () => {
    const { socket, dependencies, handler, resolveAuth } = makeHandler()
    connect(handler, socket)
    socket.emitMessage(Buffer.alloc(100))
    socket.emitMessage(Buffer.alloc(100))
    socket.emitMessage(Buffer.alloc(100)) // overflow
    expect(socket.closed).toHaveLength(1)
    resolveAuth({ userId: 42, jti: 'jti-1', machine_id: 'm-1' })
    await new Promise((r) => setTimeout(r, 20))

    expect(dependencies.router.registerClient).not.toHaveBeenCalled()
    expect(dependencies.router.handleClientMessage).not.toHaveBeenCalled()
  })

  test('peer close clears buffered messages and late auth success never reaches the Router', async () => {
    const { socket, dependencies, handler, resolveAuth } = makeHandler()
    connect(handler, socket)
    socket.emitMessage(Buffer.from(JSON.stringify({ type: 'list_sessions' })))
    socket.emitClose()

    resolveAuth({ userId: 42, jti: 'jti-1', machine_id: 'm-1' })
    await new Promise((r) => setTimeout(r, 20))

    expect(dependencies.router.registerClient).not.toHaveBeenCalled()
    expect(dependencies.router.handleClientMessage).not.toHaveBeenCalled()
    expect(dependencies.rateLimiter.clearAuthFailure).not.toHaveBeenCalled()
  })

  test('releaseAdmission runs exactly once across overflow, close and auth-failure paths', async () => {
    const release = vi.fn()
    const { socket, handler, resolveAuth } = makeHandler({
      connectionAdmission: { tryAcquire: () => ({ admitted: true, release }) },
      verifyAccessToken: vi.fn(async () => null),
    })
    connect(handler, socket)
    socket.emitMessage(Buffer.alloc(2000)) // overflow releases once
    resolveAuth(null) // auth failure path also tries
    socket.listeners.get('close')?.forEach(fn => (fn as any)(undefined))
    await new Promise((r) => setTimeout(r, 20))

    expect(release).toHaveBeenCalledTimes(1)
  })

  test('boundary values are allowed: exactly max messages and exactly max bytes', async () => {
    const { socket, dependencies, handler, resolveAuth } = makeHandler()
    connect(handler, socket)
    socket.emitMessage(jsonOfExactLength(512))
    socket.emitMessage(jsonOfExactLength(512)) // exactly 2 messages, exactly 1024 bytes
    await new Promise((r) => setTimeout(r, 5))
    expect(socket.closed).toHaveLength(0)

    resolveAuth({ userId: 42, jti: 'jti-1', machine_id: 'm-1' })
    await new Promise((r) => setTimeout(r, 20))
    expect(dependencies.router.registerClient).toHaveBeenCalledWith(socket, 42)
    expect(dependencies.router.handleClientMessage).toHaveBeenCalledTimes(2)
  })

  test('a normal daemon register message arrives in order after authentication', async () => {
    const { socket, dependencies, handler, resolveAuth } = makeHandler()
    const daemonHandler = makeHandler({
      registerDaemon: vi.fn(async () => true),
    })
    void daemonHandler
    connect(handler, socket)
    const early = Buffer.from(JSON.stringify({ type: 'register', daemon_id: 'd-1' }))
    socket.emitMessage(early)
    resolveAuth({ userId: 42, jti: 'jti-1', machine_id: 'm-1' })
    await new Promise((r) => setTimeout(r, 20))

    expect(dependencies.router.registerClient).toHaveBeenCalledWith(socket, 42)
    expect(dependencies.router.handleClientMessage).toHaveBeenCalledTimes(1)
  })
})

describe('pre-auth buffer runtime configuration (M-3)', () => {
  test('defaults bound the queue to 4 messages and 2 MiB', () => {
    const config = resolveRelayRuntimeConfig({})
    expect(config.preAuthMaxMessages).toBe(4)
    expect(config.preAuthMaxBytes).toBe(2 * 1_048_576)
  })

  test('strict positive env overrides apply with an upper bound of 2x max message size', () => {
    const config = resolveRelayRuntimeConfig({
      RELAY_PREAUTH_MAX_MESSAGES: '8',
      RELAY_PREAUTH_MAX_BYTES: '1048576',
    })
    expect(config.preAuthMaxMessages).toBe(8)
    expect(config.preAuthMaxBytes).toBe(1_048_576)
    expect(() => resolveRelayRuntimeConfig({
      MAX_WS_MESSAGE_SIZE: '1024',
      MAX_CHUNK_BYTES: '512',
      REPLAY_BATCH_MAX_BYTES: '512',
      RELAY_PREAUTH_MAX_BYTES: '999999',
    })).toThrow('RELAY_PREAUTH_MAX_BYTES')
    expect(() => resolveRelayRuntimeConfig({
      RELAY_PREAUTH_MAX_MESSAGES: '0',
    })).toThrow('RELAY_PREAUTH_MAX_MESSAGES')
  })
})
