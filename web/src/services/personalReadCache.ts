/** Private read previews only. No credentials, permissions, commands or mutation journal. */
export interface CacheKeyGrant { key: string; key_id: string; user_id: number; expires_at: number }
export interface CacheScope { origin: string; user: number; current?: () => boolean }
interface Envelope { id: string; scope: string; keyId: string; kind: string; barrier: string; at: number; iv: Uint8Array; body: ArrayBuffer }
export interface CacheTicket { revision: number; generation: number; scope: string; barrier: string }
const DB = 'pocketctl-personal-read-v1'
const BARRIER = 'pocketctl-personal-cache-invalidation'
const TTL = 7 * 86400_000
const MAX_BYTES = 20 * 1024 * 1024
const enc = new TextEncoder()
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))), n => n.toString(16).padStart(2, '0')).join('')

export class PersonalReadCache {
  private coordinationAvailable = true
  private generation = 0
  private revision = 0
  private eviction: Promise<void> = Promise.resolve()
  private scope = ''
  private scopeCurrent: () => boolean = () => true
  private key?: CryptoKey
  private keyId = ''
  private expires = 0
  private pending: Promise<void> = Promise.resolve()
  private unlock?: () => Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private listeners = new Set<() => void>()
  private barrier = ''
  private channel?: BroadcastChannel
  private db?: Promise<IDBDatabase>
  constructor(private dbName = DB, crossTab = true) {
    this.barrier = this.readBarrier()
    try {
      const probe = 'pocketctl-cache-probe-' + Math.random()
      localStorage.setItem(probe, '1'); localStorage.removeItem(probe)
    } catch { this.coordinationAvailable = false }
    if (crossTab && typeof window !== 'undefined') {
      window.addEventListener('storage', e => { if (e.key === BARRIER && e.newValue !== this.barrier) this.invalidate(false) })
      if (typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel(BARRIER)
        this.channel.onmessage = event => {
          const barrier = event.data?.barrier
          if (typeof barrier === 'string' && barrier !== this.barrier && barrier === this.readBarrier()) this.invalidate(false)
        }
      }
    }
  }
  private readBarrier() { try { return localStorage.getItem(BARRIER) || '' } catch { return this.barrier || '' } }
  onInvalidate(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  ticket(): CacheTicket { return { revision: this.revision, generation: this.generation, scope: this.scope, barrier: this.barrier } }
  valid(ticket: CacheTicket) { return ticket.revision === this.revision && this.authorized(ticket) }
  private authorized(ticket: CacheTicket) {
    let current = false
    try { current = this.scopeCurrent() } catch {}
    return current && !!ticket.scope && ticket.generation === this.generation && ticket.scope === this.scope
      && ticket.barrier === this.barrier && ticket.barrier === this.readBarrier()
  }
  activate(scope: CacheScope, getGrant: () => Promise<CacheKeyGrant | null>) {
    if (!this.coordinationAvailable) return
    const identity = JSON.stringify([scope.origin, scope.user])
    if (this.scope && this.scope !== identity) this.invalidate()
    this.generation++
    this.scope = identity
    this.scopeCurrent = scope.current || (() => true)
    const ticket = this.ticket()
    // Renew on auth refresh, and at lease expiry. A locally restored user never calls activate.
    this.unlock = () => {
      this.unlock = undefined
      this.pending = (async () => {
      try {
        const grant = await getGrant()
        if (!this.authorized(ticket)) return
        if (!grant || grant.user_id !== scope.user || grant.expires_at <= Date.now() || grant.expires_at > Date.now() + 16 * 60_000) {
          this.lock(); return
        }
        const bytes = Uint8Array.from(atob(grant.key), c => c.charCodeAt(0))
        if (bytes.length !== 32) { this.lock(); return }
        const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
        bytes.fill(0)
        if (!this.authorized(ticket)) return
        if (this.keyId && this.keyId !== grant.key_id) this.listeners.forEach(listener => listener())
        this.key = key; this.keyId = grant.key_id; this.expires = grant.expires_at
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.lock()
          if (this.authorized(ticket)) this.activate(scope, getGrant)
        }, Math.max(1, this.expires - Date.now()))
      } catch { if (this.authorized(ticket)) this.lock() }
      })()
      return this.pending
    }
  }
  private lock() {
    this.key = undefined; this.keyId = ''; this.expires = 0
    this.listeners.forEach(listener => listener())
  }
  invalidate(broadcast = true) {
    this.generation++
    this.scope = ''
    this.unlock = undefined
    if (this.timer) clearTimeout(this.timer)
    this.lock()
    if (broadcast) {
      this.barrier = `${Date.now()}:${Math.random()}`
      try { localStorage.setItem(BARRIER, this.barrier) } catch {}
      this.channel?.postMessage({ barrier: this.barrier })
    } else { this.barrier = this.readBarrier(); return }
    const generation = this.generation
    void this.open().then(db => {
      // Do not clear a new login's rows after a delayed database open.
      if (generation !== this.generation || this.scope) return
      const tx = db.transaction('snapshots', 'readwrite'); tx.objectStore('snapshots').clear()
    }).catch(() => {})
  }
  private open(): Promise<IDBDatabase> {
    if (!this.db) this.db = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('snapshots', { keyPath: 'id' })
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('cache blocked'))
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    }).catch(error => { this.db = undefined; throw error })
    return this.db
  }
  private async context(name: string, ticket: CacheTicket) {
    const revision = this.revision
    await this.eviction
    await (this.unlock ? this.unlock() : this.pending)
    if (revision !== this.revision || !this.valid(ticket) || !this.key || this.expires <= Date.now()) return null
    const key = this.key, keyId = this.keyId
    const scope = await digest(ticket.scope)
    const id = await digest(JSON.stringify([scope, keyId, name]))
    if (!this.valid(ticket) || key !== this.key) return null
    return { key, keyId, scope, id, revision }
  }
  async read<T>(name: string, ticket = this.ticket()): Promise<T | null> {
    try {
      const context = await this.context(name, ticket)
      if (!context) return null
      const db = await this.open()
      const row = await new Promise<Envelope | undefined>((resolve, reject) => {
        const req = db.transaction('snapshots').objectStore('snapshots').get(context.id)
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error)
      })
      if (!row || row.barrier !== ticket.barrier || row.scope !== context.scope || row.keyId !== context.keyId || Date.now() - row.at > TTL || row.at > Date.now()) return null
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv as Uint8Array<ArrayBuffer>, additionalData: enc.encode(JSON.stringify([1, row.id, row.scope, row.keyId, row.kind, row.barrier, row.at])) }, context.key, row.body)
      if (context.revision !== this.revision || !this.valid(ticket) || context.key !== this.key || this.expires <= Date.now()) return null
      return JSON.parse(new TextDecoder().decode(plain)) as T
    } catch { return null }
  }
  async write(name: string, value: unknown, ticket = this.ticket()): Promise<void> {
    try {
      // Serialize before awaits: caller may mutate the authoritative objects meanwhile.
      const plain = enc.encode(JSON.stringify(value))
      if (plain.byteLength > 1024 * 1024) return
      const context = await this.context(name, ticket)
      if (!context) return
      const kind = name.startsWith('history:') ? 'history' : 'navigation'
      const row: Envelope = { id: context.id, scope: context.scope, keyId: context.keyId, kind, barrier: ticket.barrier, at: Date.now(), iv: crypto.getRandomValues(new Uint8Array(12)), body: new ArrayBuffer(0) }
      row.body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: row.iv as Uint8Array<ArrayBuffer>, additionalData: enc.encode(JSON.stringify([1, row.id, row.scope, row.keyId, row.kind, row.barrier, row.at])) }, context.key, plain)
      const db = await this.open()
      if (context.revision !== this.revision || !this.valid(ticket) || context.key !== this.key || this.expires <= Date.now()) return
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('snapshots', 'readwrite'), store = tx.objectStore('snapshots')
        // One serialized IDB transaction enforces global bounds across tabs.
        const all = store.getAll()
        all.onsuccess = () => {
          if (context.revision !== this.revision || !this.valid(ticket)) { tx.abort(); return }
          const rows = (all.result as Envelope[]).filter(old => old.id !== row.id)
          rows.push(row); rows.sort((a, b) => b.at - a.at)
          let size = 0, count = 0, history = 0
          for (const item of rows) {
            size += item.body.byteLength; count++; if (item.kind === 'history') history++
            if (item.scope !== row.scope || item.keyId !== row.keyId || Date.now() - item.at > TTL || size > MAX_BYTES || count > 128 || (item.kind === 'history' && history > 20)) store.delete(item.id)
            else if (item.id === row.id) store.put(row)
          }
        }
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error)
      })
    } catch { /* Storage/crypto is optional; never write plaintext as fallback. */ }
  }
  /** Evict the display family on mutation/denial; cancel older in-flight reads and writes. */
  evict(kind: 'navigation' | 'history', ticket = this.ticket()): Promise<void> {
    this.revision++
    this.eviction = this.eviction.then(async () => {
      try {
        if (!ticket.scope) return
        const scope = await digest(ticket.scope)
        const db = await this.open()
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readwrite'), store = tx.objectStore('snapshots'), req = store.getAll()
          req.onsuccess = () => { for (const row of req.result as Envelope[]) if (row.kind === kind && row.scope === scope) store.delete(row.id) }
          tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error)
        })
      } catch {}
    })
    return this.eviction
  }
  remove(name: string, ticket = this.ticket()) {
    return this.evict(name.startsWith('history:') ? 'history' : 'navigation', ticket)
  }

}
export const personalReadCache = new PersonalReadCache()
