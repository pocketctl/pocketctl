import { afterEach, describe, expect, test, vi } from 'vitest'
import { Router } from '../router.js'
// Match the ownership lookup itself, not nested session checks performed by
// the native history reader while hydrating already-selected event heads.
const isOwnershipLookup = (sql: string) => /^\s*(?:SELECT\s+1\s+FROM\s+sessions(?:\s|$)|WITH\s+owned_session\s+AS)/i.test(sql)
function fixture(options: any = {}) {
  let taskRead = async (): Promise<any> => ({ rows: [] })
  const query = vi.fn(async (sql: string, parameters: any[] = []) => {
    if (sql.includes('SELECT e.id::text FROM events') && sql.includes('id=ANY($1::bigint[])')) {
      return { rows: parameters[0].map((id: string) => ({ id: String(id) })) }
    }
    if (isOwnershipLookup(sql)) return { rows: [{}], rowCount: 1 }
    if (sql.includes('FROM sessions')) return { rows: [{ status: 'completed' }], rowCount: 1 }
    if (sql.includes('DISTINCT ON')) return taskRead()
    if (sql.includes('SELECT 1 FROM events')) return { rows: [] }
    if (sql.includes('FROM events')) return { rows: [{ id: 100, payload: { type: 'agent_text', text: 'body' } }] }
    return { rows: [] }
  })
  const pool = { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } as any
  const router = new Router(pool, options)
  const socket = (owner = 1) => {
    const sent: any[] = []
    const ws = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)), close: vi.fn(), sent } as any
    router.registerClient(ws, owner)
    return ws
  }
  return { pool, router, socket, taskRead: (read: () => Promise<any>) => { taskRead = read } }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 20))
const initial = { type: 'replay', session_id: 's', direction: 'backward', limit: 1, req_id: 1, task_snapshot: true }
afterEach(() => vi.useRealTimers())
describe('independent replay task snapshots', () => {
  test('body finishes while task sources are stalled, preserving body cursors and source clears', async () => {
    const f = fixture(), ws = f.socket()
    let finish!: (value: any) => void
    f.taskRead(() => new Promise(resolve => { finish = resolve }))
    await f.router.handleClientMessage(ws, initial)
    await tick()
    expect(ws.sent.find((m: any) => m.type === 'replay_end')).toMatchObject({ req_id: 1, count: 1, last_seq: 100, newest_seq: 100, task_snapshot_status: 'pending' })
    expect(ws.sent.some((m: any) => m.type === 'task_snapshot')).toBe(false)
    finish({ rows: [{ id: 2, payload: { type: 'agent_plan', part_id: 'a', revision: 9, plan: [] } }, { id: 3, payload: { type: 'agent_todo', part_id: 'b', todos: [] } }] })
    await tick()
    expect(ws.sent.find((m: any) => m.type === 'task_snapshot')).toMatchObject({ req_id: 1, status: 'complete', events: [{ part_id: 'a', revision: 9, plan: [] }, { part_id: 'b', todos: [] }] })
  })
  test('supplement failure is explicit and independently retryable without failing body', async () => {
    const f = fixture(), ws = f.socket()
    f.taskRead(async () => { throw Object.assign(new Error('timeout'), { code: '57014' }) })
    await f.router.handleClientMessage(ws, initial)
    await tick()
    expect(ws.sent.find((m: any) => m.type === 'replay_end')).not.toHaveProperty('error')
    expect(ws.sent.find((m: any) => m.type === 'task_snapshot')).toMatchObject({ req_id: 1, status: 'error', error: 'task_snapshot_unavailable', retryable: true })
    f.taskRead(async () => ({ rows: [] }))
    await f.router.handleClientMessage(ws, { type: 'replay_task_snapshot', session_id: 's', req_id: 2 })
    await tick()
    expect(ws.sent.at(-1)).toMatchObject({ type: 'task_snapshot', req_id: 2, status: 'complete', events: [] })
  })
  test('duplicate initial work coalesces queries while each request retains its ID', async () => {
    const f = fixture(), ws = f.socket()
    let finish!: (value: any) => void
    f.taskRead(() => new Promise(resolve => { finish = resolve }))
    await Promise.all([f.router.handleClientMessage(ws, initial), f.router.handleClientMessage(ws, { ...initial, req_id: 2 })])
    await tick()
    expect(f.pool.query.mock.calls.filter(([sql]: [string]) => sql.includes('DISTINCT ON'))).toHaveLength(1)
    finish({ rows: [] })
    await tick()
    expect(ws.sent.filter((m: any) => m.type === 'task_snapshot').map((m: any) => m.req_id).sort()).toEqual([1, 2])
    expect(ws.sent.filter((m: any) => m.type === 'replay_end').map((m: any) => m.req_id).sort()).toEqual([1, 2])
    expect(f.pool.query.mock.calls.filter(([sql]: [string]) => sql.includes('ORDER BY id DESC LIMIT'))).toHaveLength(1)
  })
  test('repeated identical request IDs emit only one body and snapshot while in flight', async () => {
    const f = fixture(), ws = f.socket()
    let finish!: (value: any) => void
    f.taskRead(() => new Promise(resolve => { finish = resolve }))
    await f.router.handleClientMessage(ws, initial)
    await tick()
    await f.router.handleClientMessage(ws, initial)
    await f.router.handleClientMessage(ws, { type: 'replay_task_snapshot', session_id: 's', req_id: 1 })
    await tick()
    finish({ rows: [] })
    await tick()
    expect(ws.sent.filter((m: any) => m.type === 'replay_end')).toHaveLength(1)
    expect(ws.sent.filter((m: any) => m.type === 'task_snapshot')).toHaveLength(1)
  })
  test('many task sources retain every head in byte-bounded partial snapshot frames', async () => {
    const f = fixture({ transport: { maxEventBytes: 1048576, maxChunkBytes: 131072, replayBatchMaxEvents: 1, replayBatchMaxBytes: 600 } }), ws = f.socket()
    f.taskRead(async () => ({ rows: Array.from({ length: 3 }, (_, index) => ({ id: index + 1, payload: { type: 'agent_plan', part_id: String(index), revision: 1, plan: [{ step: 'x'.repeat(200) }] } })) }))
    await f.router.handleClientMessage(ws, initial)
    await tick()
    const frames=ws.sent.filter((m:any)=>m.type==='task_snapshot')
    expect(frames.map((m:any)=>m.status)).toEqual(['partial','partial','complete'])
    expect(frames.flatMap((m:any)=>m.events).map((e:any)=>e.part_id)).toEqual(['0','1','2'])
    expect(frames.every((m:any)=>Buffer.byteLength(JSON.stringify(m),'utf8')<=600)).toBe(true)
  })
  test('different owners never share work even when the session string matches', async () => {
    const f = fixture(), first = f.socket(1), second = f.socket(2)
    const finishes: ((value: any) => void)[] = []
    f.taskRead(() => new Promise(resolve => { finishes.push(resolve) }))
    await Promise.all([f.router.handleClientMessage(first, initial), f.router.handleClientMessage(second, initial)])
    await tick()
    expect(finishes).toHaveLength(2)
    finishes.forEach(finish => finish({ rows: [] }))
    await tick()
  })
  test('legacy replay emits body early and completes explicitly when task retrieval fails', async () => {
    const f = fixture(), ws = f.socket()
    f.taskRead(async () => { throw new Error('unavailable') })
    await f.router.handleClientMessage(ws, { ...initial, task_snapshot: false })
    await tick()
    expect(ws.sent[0]).toMatchObject({ type: 'replay_batch', events: [{ type: 'agent_text', text: 'body' }] })
    expect(ws.sent.find((m: any) => m.type === 'replay_end')).toMatchObject({ count: 1, task_snapshot_status: 'error', task_snapshot_retryable: true })
    expect(ws.sent.find((m: any) => m.type === 'replay_end')).not.toHaveProperty('error')
  })
  test('a snapshot deadline completes with an error and does not publish late results', async () => {
    vi.useFakeTimers()
    const f = fixture(), ws = f.socket()
    let finish!: (value: any) => void
    f.taskRead(() => new Promise(resolve => { finish = resolve }))
    await f.router.handleClientMessage(ws, initial)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ws.sent.find((m: any) => m.type === 'task_snapshot')).toMatchObject({ status: 'error', retryable: true })
    finish({ rows: [] })
    await vi.advanceTimersByTimeAsync(1)
    expect(ws.sent.filter((m: any) => m.type === 'task_snapshot')).toHaveLength(1)
  })
  test.each([true, false])('hung ownership recheck is inside the total supplement deadline (independent=%s)', async independent => {
    vi.useFakeTimers()
    const f = fixture(), ws = f.socket()
    let finishAuthorization!: (value: any) => void
    const original = f.pool.query.getMockImplementation()!
    let ownershipChecks = 0
    f.pool.query.mockImplementation((sql: string, ...args: any[]) => {
      if (isOwnershipLookup(sql) && ++ownershipChecks > 1) {
        return new Promise(resolve => { finishAuthorization = resolve })
      }
      return original(sql, ...args)
    })
    f.taskRead(async () => ({ rows: [{ id: 2, payload: { type: 'agent_plan', event_id: 'private', part_id: 'p', revision: 1, plan: [{ step: 'Private task', status: 'pending' }] } }] }))
    await f.router.handleClientMessage(ws, { ...initial, task_snapshot: independent })
    await vi.advanceTimersByTimeAsync(1600)
    if (independent) {
      expect(ws.sent.find((m: any) => m.type === 'task_snapshot')).toMatchObject({ status: 'error', error: 'task_snapshot_unavailable', retryable: true })
    } else {
      expect(ws.sent.find((m: any) => m.type === 'replay_end')).toMatchObject({ count: 1, task_snapshot_status: 'error', task_snapshot_retryable: true })
    }
    expect(JSON.stringify(ws.sent)).not.toContain('Private task')
    finishAuthorization({ rows: [{}], rowCount: 1 })
    await vi.advanceTimersByTimeAsync(1)
    expect(ws.sent.filter((m: any) => m.type === 'task_snapshot')).toHaveLength(independent ? 1 : 0)
    expect(ws.sent.filter((m: any) => m.type === 'replay_end')).toHaveLength(1)
  })
  test('denied ownership recheck ends the supplement without publishing task content', async () => {
    const f = fixture(), ws = f.socket()
    const original = f.pool.query.getMockImplementation()!
    let ownershipChecks = 0
    f.pool.query.mockImplementation((sql: string, ...args: any[]) => {
      if (isOwnershipLookup(sql) && ++ownershipChecks > 1) return Promise.resolve({ rows: [], rowCount: 0 })
      return original(sql, ...args)
    })
    f.taskRead(async () => ({ rows: [{ id: 2, payload: { type: 'agent_plan', event_id: 'private', part_id: 'p', revision: 1, plan: [{ step: 'Private task', status: 'pending' }] } }] }))
    await f.router.handleClientMessage(ws, initial)
    await tick()
    expect(ws.sent.find((m: any) => m.type === 'task_snapshot')).toMatchObject({ status: 'error', retryable: true })
    expect(JSON.stringify(ws.sent)).not.toContain('Private task')
  })
  test('snapshot retry denies an unowned session', async () => {
    const f = fixture(), ws = f.socket()
    f.pool.query.mockResolvedValue({ rows: [], rowCount: 0 })
    await f.router.handleClientMessage(ws, { type: 'replay_task_snapshot', session_id: 'other', req_id: 5 })
    await tick()
    expect(ws.sent.at(-1)).toMatchObject({ type: 'error', error: 'session not found or not owned' })
    expect(f.pool.query.mock.calls.some(([sql]: [string]) => sql.includes('DISTINCT ON'))).toBe(false)
  })
})
