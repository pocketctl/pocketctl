import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { initDB, renameOwnedDaemonSession, deleteSession } from '../db.js'
import { MessageQueueService } from '../session-message-queue/service.js'
import { type QueueItem } from '../session-message-queue/state.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { Router } from '../router.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && process.env.TEST_DATABASE_URL
const suite = enabled ? describe : describe.skip
suite('personal message queue PostgreSQL', () => {
  let pool: pg.Pool, userId: number
  let online: boolean, sent: QueueItem[], service: MessageQueueService
  const makeService = (dispatch = async (_user: number, _session: string, item: QueueItem) => { sent.push(item); return undefined as string | undefined }) =>
    new MessageQueueService(pool, () => online, dispatch, () => {})
  const command = (action: string, extra = {}) => service.command(userId, 'queue-session', { action, ...extra })
  const enqueue = (id: string) => command('enqueue', { item_id: id, content: `task ${id}` })
  const event = async (type: string, payload: object) => {
    await pool.query('INSERT INTO events(session_id,event_type,payload) VALUES($1,$2,$3)', ['queue-session', type, payload])
  }
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
    const db = await pool.query('SELECT current_database() AS name')
    if (!/test/i.test(db.rows[0].name)) throw Error('test database required')
    await initDB(pool)
  }, 30000)
  afterAll(async () => { await pool?.end() })
  beforeEach(async () => {
    await pool.query('TRUNCATE deleted_sessions, users, daemons, sessions, events RESTART IDENTITY CASCADE')
    userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES('queue@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query("INSERT INTO daemons(daemon_id,hostname,status,user_id) VALUES('queue-daemon','test','online',$1)", [userId])
    await pool.query(`INSERT INTO sessions(session_id,daemon_id,agent_type,cwd,source,status,user_id,control_mode,capabilities)
      VALUES('queue-session','queue-daemon','codex','/repo','daemon','idle',$1,'managed','["message_queue_v1","message_acceptance_receipt"]')`, [userId])
    online = true; sent = []; service = makeService()
  })
  test('owner and runtime capability authorize every queue operation', async () => {
    await expect(service.command(userId + 1, 'queue-session', { action: 'read' })).rejects.toThrow('queue_unavailable')
    for (const agent of ['zcode-managed', 'codex-desktop', 'unknown']) {
      await pool.query('UPDATE sessions SET agent_type=$1', [agent])
      await expect(enqueue(agent)).rejects.toThrow('queue_unavailable')
    }
    await pool.query("UPDATE sessions SET agent_type='codex',capabilities='[]'")
    await expect(enqueue('a')).rejects.toThrow('queue_unavailable')
  })
  test('restarts preserve order and require persisted execution evidence before next dispatch', async () => {
    await enqueue('a'); await enqueue('b')
    await service.tick()
    expect(sent.map(i => i.id)).toEqual(['a'])
    service = makeService()
    await service.tick()
    expect(sent).toHaveLength(1)
    await event('turn_status', { turn_id: 'turn-a', turn_status: 'running' })
    await event('turn_status', { turn_id: 'turn-a', turn_status: 'completed' })
    await service.tick(); expect(sent).toHaveLength(1)
    await new EventMaterializer({ pool }).materialize({ inboxId: 99701, userId, daemonId: 'queue-daemon', sessionId: 'queue-session', eventType: 'queue_dispatch_started', payload: { type: 'queue_dispatch_started', session_id: 'queue-session', request_id: sent[0].request_id } })
    await service.tick()
    expect(sent.map(i => i.id)).toEqual(['a', 'b'])
  })
  test('two scheduler instances and duplicate enqueues dispatch once', async () => {
    await Promise.all([enqueue('a'), enqueue('a')])
    await Promise.all([service.tick(), makeService().tick()])
    expect(sent.map(i => i.id)).toEqual(['a'])
  })
  test('concurrent reorder uses CAS and removed IDs remain idempotent', async () => {
    await enqueue('a'); const before = await enqueue('b')
    const results = await Promise.allSettled([
      command('reorder', { version: before.version, item_ids: ['b', 'a'] }),
      command('cancel', { version: before.version, item_id: 'a' }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    let state = await command('read')
    if (state.items.some(i => i.id === 'a')) state = await command('cancel', { version: state.version, item_id: 'a' })
    await enqueue('a')
    expect((await command('read')).items.map(i => i.id)).toEqual(['b'])
  })
  test('stop holds the queue after an already-started dispatch without losing subsequent items', async () => {
    let release!: () => void, began!: () => void
    const started = new Promise<void>(r => { began = r })
    const barrier = new Promise<void>(r => { release = r })
    service = makeService(async (_user, _session, item) => { sent.push(item); began(); await barrier; return undefined })
    await enqueue('a'); await enqueue('b')
    const tick = service.tick(); await started
    const stop = service.hold(userId, 'queue-session')
    release(); await Promise.all([tick, stop])
    await event('turn_status', { turn_id: 'a', turn_status: 'running' })
    await event('queue_dispatch_started', { request_id: sent[0].request_id })
    await event('turn_status', { turn_id: 'a', turn_status: 'completed' })
    await service.tick()
    const state = await command('read')
    expect(state.blocked).toBe('stopped'); expect(state.items.map(i => i.id)).toEqual(['b']); expect(sent).toHaveLength(1)
  })
  test('offline mutations fail and offline scheduler preserves the queue', async () => {
    await enqueue('a'); online = false
    await expect(enqueue('b')).rejects.toThrow('daemon_offline')
    await service.tick(); expect(sent).toHaveLength(0)
    expect((await command('read')).items[0].state).toBe('pending')
    online = true; await service.tick(); expect(sent).toHaveLength(1)
  })
  test('rename cascades queue and deletion removes queued content', async () => {
    await enqueue('a')
    await renameOwnedDaemonSession(pool, { oldSessionId: 'queue-session', newSessionId: 'renamed', daemonId: 'queue-daemon', userId })
    expect((await service.command(userId, 'renamed', { action: 'read' })).items[0].id).toBe('a')
    await deleteSession(pool, 'renamed')
    expect((await pool.query('SELECT * FROM session_message_queues')).rows).toHaveLength(0)
  })
  test('drains more than one event page before deciding that a session is idle', async () => {
    await enqueue('a')
    await pool.query(`INSERT INTO events(session_id,event_type,payload) SELECT 'queue-session','turn_status',
      jsonb_build_object('turn_id','old-'||n,'turn_status','completed') FROM generate_series(1,500) n`)
    await event('turn_status', { turn_id: 'latest', turn_status: 'running' })
    await service.tick(); expect(sent).toHaveLength(0)
  })
  test('failed initial session can resume and removed capability does not prevent stop hold', async () => {
    await pool.query("UPDATE sessions SET status='error'")
    const queued = await enqueue('a')
    expect(queued.busy).toBe(false)
    await command('resume', { version: queued.version })
    await service.tick(); expect(sent).toHaveLength(1)
    await pool.query("UPDATE sessions SET capabilities='[]'")
    await service.hold(userId, 'queue-session')
    expect((await pool.query('SELECT state FROM session_message_queues')).rows[0].state.blocked).toBe('stopped')
  })
  test('router dispatch reuses authorization and admission, forwarding a new-turn flag', async () => {
    const socket = () => { const sent: any[] = []; return { readyState: 1, send: vi.fn((raw: string) => sent.push(JSON.parse(raw))), close: vi.fn(), _sent: sent } }
    const router = new Router(pool), daemon = socket(), client = socket()
    await router.registerDaemon(daemon as any, { type: 'register', daemon_id: 'queue-daemon', hostname: 'test', agents: [], supports_quota_grant: true }, userId)
    router.registerClient(client as any, userId)
    router.startMessageQueue()
    try {
      await router.handleClientMessage(client as any, { type: 'message_queue', session_id: 'queue-session', request_id: 'enqueue', item_id: 'a', action: 'enqueue', content: 'queued prompt' })
      expect(client._sent).toContainEqual(expect.objectContaining({ type: 'message_queue_state', request_id: 'enqueue', items: [expect.objectContaining({ id: 'a' })] }))
      await vi.waitFor(() => expect(daemon._sent.filter(m => m.type === 'user_message')).toHaveLength(1), { timeout: 5000 })
      expect(daemon._sent.find(m => m.type === 'user_message')).toEqual(expect.objectContaining({ queue_dispatch: true, content: 'queued prompt', quota_grant: expect.any(Object) }))
    } finally { router.stop() }
  })
})
