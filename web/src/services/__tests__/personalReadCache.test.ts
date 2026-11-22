import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { PersonalReadCache, type CacheKeyGrant } from '../personalReadCache'
import { historyPreview, navigationSessions } from '../sessionCacheProjection'
const grant = (user = 7, key = 'a'): CacheKeyGrant => ({ user_id: user, key: btoa(key.repeat(32)), key_id: key, expires_at: Date.now() + 900_000 })
let cache: PersonalReadCache
const name = 'personal-cache-test'
const activate = (user = 7, origin = 'https://relay.example') => cache.activate({ user, origin }, async () => grant(user))
async function rows(): Promise<any[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  return new Promise(resolve => { const r = db.transaction('snapshots').objectStore('snapshots').getAll(); r.onsuccess = () => { db.close(); resolve(r.result) } })
}
beforeEach(() => {
  localStorage.clear(); vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('crypto', webcrypto)
  cache = new PersonalReadCache(name, false)
})
afterEach(() => { cache.invalidate(false); vi.unstubAllGlobals(); vi.useRealTimers() })
describe('encrypted personal previews', () => {
  test('never unlocks from local identity; stores ciphertext and opaque keys only', async () => {
    localStorage.setItem('pocketctl_user', '{"id":7}')
    await cache.write('history:private-session', [{ content: 'Secret question' }])
    expect(await cache.read('history:private-session')).toBeNull()
    activate()
    await cache.write('history:private-session', [{ content: 'Secret question' }])
    expect(await cache.read('history:private-session')).toEqual([{ content: 'Secret question' }])
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(JSON.stringify(stored)).not.toMatch(/Secret question|private-session|relay.example/)
    expect(new TextDecoder().decode(stored[0].body)).not.toContain('Secret question')
    expect(localStorage.getItem('a')).toBeNull()
  })
  test('account, origin, key rotation and logout isolate reads', async () => {
    activate(); await cache.write('sessions', ['private'])
    activate(8); expect(await cache.read('sessions')).toBeNull()
    activate(7, 'https://other.example'); expect(await cache.read('sessions')).toBeNull()
    activate(); await cache.write('sessions', ['again'])
    cache.activate({ user: 7, origin: 'https://relay.example' }, async () => grant(7, 'b'))
    expect(await cache.read('sessions')).toBeNull()
    cache.invalidate(); activate(); expect(await cache.read('sessions')).toBeNull()
  })
  test('reload can decrypt only after fresh authentication', async () => {
    activate(); await cache.write('sessions', ['private'])
    const reload = new PersonalReadCache(name, false)
    expect(await reload.read('sessions')).toBeNull()
    reload.activate({ user: 7, origin: 'https://relay.example' }, async () => grant())
    expect(await reload.read('sessions')).toEqual(['private'])
    reload.invalidate(false)
  })
  test('pending unlock/read/write cannot resurrect after logout', async () => {
    let resolve!: (g: CacheKeyGrant) => void
    cache.activate({ user: 7, origin: 'https://relay.example' }, () => new Promise(r => { resolve = r }))
    const ticket = cache.ticket(), write = cache.write('sessions', ['secret'], ticket), read = cache.read('sessions', ticket)
    const invalidated = vi.fn(); cache.onInvalidate(invalidated)
    await Promise.resolve()
    cache.invalidate(); resolve(grant()); await write
    expect(await read).toBeNull(); expect(invalidated).toHaveBeenCalledOnce()
    activate(); expect(await cache.read('sessions')).toBeNull()
  })
  test('tampered ciphertext and authenticated metadata fail closed', async () => {
    activate(); await cache.write('sessions', ['secret'])
    const [row] = await rows(); row.at -= 1
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result) })
    await new Promise<void>(resolve => { const tx = db.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').put(row); tx.oncomplete = () => resolve() }); db.close()
    expect(await cache.read('sessions')).toBeNull()
  })
  test('bounded history and quota failures never prevent normal operation', async () => {
    activate()
    for (let i = 0; i < 25; i++) await cache.write('history:' + i, [i])
    expect((await rows()).filter(row => row.kind === 'history')).toHaveLength(20)
    expect(cache.evictions.histories).toBe(5)
    await cache.write('huge', 'x'.repeat(2 * 1024 * 1024)); expect(await cache.read('huge')).toBeNull()
  })
  test('expired grant and stale cross-tab barrier block decryption', async () => {
    activate(); await cache.write('sessions', ['secret'])
    localStorage.setItem('pocketctl-personal-cache-invalidation', 'other-tab-logout')
    expect(await cache.read('sessions')).toBeNull()
    cache.invalidate(false)
    cache.activate({ user: 7, origin: 'https://relay.example' }, async () => ({ ...grant(), expires_at: Date.now() - 1 }))
    expect(await cache.read('sessions')).toBeNull()
  })
  test('projections exclude credentials, runtime, approvals, shared records and pending input', () => {
    expect(navigationSessions([{ session_id: 's', title: 'title', capabilities: ['write'], status: 'running', token: 'secret' }, { session_id: 'team', team_id: 't' }])).toEqual([{ session_id: 's', title: 'title', status: 'unknown', daemon_online: false, __cached: true }])
    const projected = historyPreview([{ id: 'q', role: 'user', content: 'accepted' }, { __msg_id: 'pending', role: 'user', content: 'pending' }, { type: 'approval', content: 'approval' }, { type: 'tool_call', tool: 'AskUserQuestion', status: 'completed' }, { id: 'a', type: 'agent_text', content: 'text', token: 'secret' }])
    expect(projected).toHaveLength(2); expect(JSON.stringify(projected)).not.toMatch(/pending|approval|secret/)
  })
})

test('same-account auth refresh cannot extend an existing visible preview lease without a new grant', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  activate(); await cache.write('sessions', ['secret'])
  const onLock = vi.fn(); cache.onInvalidate(onLock)
  await vi.advanceTimersByTimeAsync(60_000)
  activate() // lazy renewal; no cache operation follows
  await vi.advanceTimersByTimeAsync(840_001)
  expect(onLock).toHaveBeenCalledOnce()
})

test('eviction invalidates tickets for plaintext reads already returned to a waiting consumer', async () => {
  activate(); await cache.write('sessions', ['private'])
  const ticket = cache.ticket()
  const alreadyDecrypted = await cache.read('sessions', ticket)
  expect(alreadyDecrypted).toEqual(['private'])
  await cache.evict('navigation', ticket)
  expect(cache.valid(ticket)).toBe(false)
  expect(await cache.read('sessions')).toBeNull()
})

test('collapsed tool density never consumes the visible-text preview budget', () => {
  const rows = []
  for (let q = 0; q < 45; q++) {
    rows.push({ id:'q'+q, role:'user', type:'user_text', content:'question '+q })
    for (let call = 0; call < 100; call++) rows.push({ id:`${q}-${call}`, type:'tool_call',tool:'Read',status:'completed',input:'sensitive raw arguments',output:'x'.repeat(10000) })
    rows.push({ id:'a'+q, type:'agent_text',content:'answer '+q })
  }
  const projection = historyPreview(rows)
  expect(projection.filter(row=>row.type !== 'cached_tool_group')).toHaveLength(80)
  expect(projection.filter(row=>row.type === 'cached_tool_group')).toHaveLength(40)
  expect(projection.find(row=>row.type === 'cached_tool_group')).toMatchObject({count:100,tools:['Read']})
  expect(JSON.stringify(projection)).not.toContain('sensitive raw arguments')
  expect(historyPreview(projection)).toEqual(projection)
  expect(new TextEncoder().encode(JSON.stringify(projection)).byteLength).toBeLessThan(768*1024)
})

test('unavailable browser storage degrades to a cache miss without plaintext fallback', async () => {
  vi.stubGlobal('indexedDB', undefined)
  activate(); await cache.write('sessions',['secret'])
  expect(await cache.read('sessions')).toBeNull()
  expect(JSON.stringify(localStorage)).not.toContain('secret')
})

test('an authenticated reload does not revive snapshots older than seven days', async () => {
  activate(); await cache.write('sessions',['old'])
  const now=Date.now()
  vi.spyOn(Date,'now').mockReturnValue(now+8*86400_000)
  activate(); expect(await cache.read('sessions')).toBeNull()
  vi.mocked(Date.now).mockRestore()
})

test('same-tab relay changes deny reads even before focus or storage events arrive', async () => {
  let sameRelay=true
  cache.activate({user:7,origin:'relay',current:()=>sameRelay},async()=>grant())
  await cache.write('sessions',['private'])
  sameRelay=false
  expect(await cache.read('sessions')).toBeNull()
})

test('denial eviction remains effective across an overlapping auth refresh', async () => {
  activate(); await cache.write('sessions',['private'])
  const oldRequest=cache.ticket()
  activate() // a 401 retry renewed auth while the original request was in flight
  await cache.evict('navigation',oldRequest)
  expect(await cache.read('sessions')).toBeNull()
})
