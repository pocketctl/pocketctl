import { beforeAll, describe, test, expect, vi } from 'vitest'

// The legacy global API key identity (POCKETCTL_API_KEY) must be gone: even a
// relay whose environment still carries the variable refuses every api_key
// handshake, and no credential at all never yields an anonymous session.

let createRelayWebSocketHandler: (dependencies: any) => (socket: any, req: any) => void

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'ws-auth-test-secret')
  const server = await import('../server.js')
  createRelayWebSocketHandler = (server as any).createRelayWebSocketHandler
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

  emitMessage(raw: string) {
    for (const handler of this.listeners.get('message') ?? []) handler(Buffer.from(raw))
  }
}

function makeHandler(overrides: Record<string, unknown> = {}) {
  const socket = new FakeSocket()
  const dependencies: any = {
    getDatabaseReady: () => true,
    maxMessageSize: 1_048_576,
    // Simulate a residual production env var: the handler must ignore it.
    apiKey: 'residual-legacy-key',
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
    verifyAccessToken: vi.fn(async () => ({ userId: 42, jti: 'jti-1', machine_id: 'm-1' })),
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
  return { socket, dependencies, handler }
}

function connect(handler: (socket: any, req: any) => void, socket: FakeSocket, query: Record<string, string>, headers: Record<string, string> = {}) {
  handler(socket, {
    query,
    headers,
    socket: { remoteAddress: '203.0.113.9' },
    ip: '203.0.113.9',
  })
}

describe('WebSocket authentication without the legacy API key identity', () => {
  test('rejects an api_key handshake even when the env var is still set', async () => {
    const { socket, dependencies, handler } = makeHandler()
    connect(handler, socket, { type: 'client', api_key: 'residual-legacy-key' })
    await new Promise((r) => setTimeout(r, 20))

    expect(socket.closed).toEqual([{ code: 4001, reason: 'authentication required' }])
    expect(dependencies.rateLimiter.recordAuthFailure).toHaveBeenCalledWith('203.0.113.9')
    expect(dependencies.router.registerClient).not.toHaveBeenCalled()
  })

  test('rejects a daemon api_key handshake', async () => {
    const { socket, dependencies, handler } = makeHandler()
    connect(handler, socket, { type: 'daemon', api_key: 'residual-legacy-key' })
    await new Promise((r) => setTimeout(r, 20))

    expect(socket.closed).toEqual([{ code: 4001, reason: 'authentication required' }])
    expect(dependencies.registerDaemon).not.toHaveBeenCalled()
  })

  test('rejects connections with no credentials at all', async () => {
    const { socket, handler } = makeHandler()
    connect(handler, socket, { type: 'client' })
    await new Promise((r) => setTimeout(r, 20))

    expect(socket.closed).toEqual([{ code: 4001, reason: 'authentication required' }])
  })

  test('still accepts a valid Bearer token', async () => {
    const { socket, dependencies, handler } = makeHandler()
    connect(handler, socket, { type: 'client' }, { authorization: 'Bearer valid-token' })
    await new Promise((r) => setTimeout(r, 20))

    expect(socket.closed).toHaveLength(0)
    expect(dependencies.router.registerClient).toHaveBeenCalledWith(socket, 42)
  })

  test('still accepts a one-time ticket', async () => {
    const { socket, dependencies, handler } = makeHandler()
    connect(handler, socket, { type: 'client', ticket: 'one-time-ticket' })
    await new Promise((r) => setTimeout(r, 20))

    expect(socket.closed).toHaveLength(0)
    expect(dependencies.router.registerClient).toHaveBeenCalledWith(socket, 7)
  })

  test('never produces a null-user client registration', async () => {
    const { socket, dependencies, handler } = makeHandler({
      verifyAccessToken: vi.fn(async () => null),
    })
    connect(handler, socket, { type: 'client' }, { authorization: 'Bearer bad-token' })
    await new Promise((r) => setTimeout(r, 20))

    expect(socket.closed).toEqual([{ code: 4001, reason: 'invalid token' }])
    expect(dependencies.router.registerClient).not.toHaveBeenCalled()
  })
})

test('registered sockets refresh inventory after admission deadline without reactivating identity', async () => {
  let active = true
  const {socket, dependencies, handler} = makeHandler({createRegistrationDeadline:()=>({isActive:()=>active,complete:()=>{const previous=active;active=false;return previous}})})
  dependencies.registerDaemon.mockImplementation(async (_router:any, identities:Map<any,any>, ws:any, msg:any)=>{
    identities.set(ws,{daemonId:msg.daemon_id,startedAt:msg.started_at});return true
  })
  dependencies.router.refreshDaemonAgents=vi.fn(async()=>true)
  connect(handler,socket,{type:'daemon'},{authorization:'Bearer valid-token'})
  socket.emitMessage(JSON.stringify({type:'register',daemon_id:'host',started_at:123,agents:['codex']}))
  await vi.waitFor(()=>expect(dependencies.registerDaemon).toHaveBeenCalledTimes(1))
  const refreshed={type:'register',daemon_id:'host',started_at:123,agents:['codex','dsh']}
  socket.emitMessage(JSON.stringify(refreshed))
  await vi.waitFor(()=>expect(dependencies.router.refreshDaemonAgents).toHaveBeenCalledWith(socket,refreshed,42))
  expect(dependencies.registerDaemon).toHaveBeenCalledTimes(1)
  socket.emitMessage(JSON.stringify({...refreshed,daemon_id:'foreign'}))
  socket.emitMessage(JSON.stringify({...refreshed,started_at:456}))
  await new Promise(resolve=>setTimeout(resolve,20))
  expect(dependencies.router.refreshDaemonAgents).toHaveBeenCalledTimes(1)
})

test('an expired initial registration cannot use the inventory refresh path', async()=>{
 const {socket,dependencies,handler}=makeHandler({createRegistrationDeadline:()=>({isActive:()=>false,complete:()=>false})})
 dependencies.router.refreshDaemonAgents=vi.fn()
 connect(handler,socket,{type:'daemon'},{authorization:'Bearer valid-token'})
 socket.emitMessage(JSON.stringify({type:'register',daemon_id:'host',started_at:123,agents:['dsh']}))
 await new Promise(resolve=>setTimeout(resolve,20))
 expect(dependencies.registerDaemon).not.toHaveBeenCalled()
 expect(dependencies.router.refreshDaemonAgents).not.toHaveBeenCalled()
})
