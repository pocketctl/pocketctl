import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import type { ShareRecord, ShareStore } from '../session-share/store.js'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

const shareTestKey = 'share-test-key'

type ShareClaims = { userId: number; sessionId: string }
function memoryStore(): ShareStore & {rows: Map<string,ShareRecord>} {
  const time=new Date(Math.floor(Date.now()/1000)*1000)
  const row:ShareRecord={id:'11111111-1111-4111-8111-111111111111',user_id:7,session_id:'ses_1',title:'Example',created_at:time,expires_at:new Date(+time+900000),revoked_at:null,server_time:time}
  const rows=new Map([[row.id,row]]),requests=new Map<string,string>()
  const get=async(userId:number,id:string)=>{const r=rows.get(id);return r&&r.user_id===userId?{...r,server_time:new Date()}:null}
  return {rows,get,
    async list(userId,sessionId){return [...rows.values()].filter(r=>r.user_id===userId&&(!sessionId||r.session_id===sessionId)&&!r.revoked_at&&+r.expires_at>Date.now())},
    async create(userId,sessionId,requestId){const key=`${userId}:${requestId}`,id=requests.get(key);if(id)return (await get(userId,id))!;const r={...row,id:randomUUID(),user_id:userId,session_id:sessionId};rows.set(r.id,r);requests.set(key,r.id);return r},
    async revoke(userId,id){const r=await get(userId,id);if(!r)return null;r.revoked_at??=new Date();rows.set(id,r);return r}
  }
}

describe('temporary session share links', () => {
  const apps: Array<ReturnType<typeof Fastify>> = []
  let registerSessionShareRoutes: any
  let signSessionShareToken: (userId: number, sessionId: string) => string
  let verifySessionShareToken: (token: string) => ShareClaims | null

  beforeAll(async () => {
    vi.stubEnv('JWT_SECRET', shareTestKey)
    const auth = await import('../auth.js')
    const routes = await import('../session-share-routes.js')
    signSessionShareToken = (userId,sessionId) => auth.signManagedSessionShareToken({userId,sessionId,shareId:'11111111-1111-4111-8111-111111111111',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+900})
    verifySessionShareToken = auth.verifyManagedSessionShareToken
    registerSessionShareRoutes = routes.registerSessionShareRoutes
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  function makeApp(options: {
    owned?: (userId: number, sessionId: string) => boolean
    events?: any[]
    logger?: any
    store?: ShareStore
    history?: () => Promise<any[]>
  } = {}) {
    const app = Fastify(options.logger)
    apps.push(app)
    registerSessionShareRoutes(app, {
      pool: {},
      store: options.store ?? memoryStore(),
      publicIssuer: 'https://public.example',
      verifyAccessToken: vi.fn(async (token) => token === 'owner-access'
        ? { userId: 7 }
        : null),
      isSessionOwnedByUser: vi.fn(async (_pool, userId, sessionId) =>
        (options.owned ?? ((candidateUserId, candidateSessionId) =>
          candidateUserId === 7 && candidateSessionId === 'ses_1'))(userId, sessionId)),
      getSessionAllEvents: options.history ?? vi.fn(async () => options.events ?? [
        {
          id: 1,
          event_type: 'user_text',
          created_at: '2026-08-06T00:00:00.000Z',
          payload: { type: 'user_text', text: '<script>alert(1)</script>', marker: 'first-event' },
        },
        {
          id: 2,
          event_type: 'tool_result',
          created_at: '2026-08-06T00:00:01.000Z',
          payload: { type: 'tool_result', output: 'second-event' },
        },
      ]),
      verifySessionShareToken,
    })
    return app
  }

  test('authenticated owner receives a 15-minute absolute URL from the configured public issuer', async () => {
    const app = makeApp()
    const before = Date.now()
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/share-link',
      headers: {
        authorization: 'Bearer owner-access',
        host: 'attacker.invalid',
      },
      payload: {request_id:randomUUID()},
    })
    const after = Date.now()

    expect(response.statusCode).toBe(200)
    const body = response.json<{ url: string; expires_at: string }>()
    expect(body.url).toMatch(/^https:\/\/public\.example\/share\/session\/[A-Za-z0-9._-]+$/)
    expect(body.url).not.toContain('attacker.invalid')
    const expiresAt = Date.parse(body.expires_at)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 14 * 60_000 + 50_000)
    expect(expiresAt).toBeLessThanOrEqual(after + 15 * 60_000 + 10_000)
  })

  test('share-link creation rejects missing or invalid authentication and hides unowned sessions', async () => {
    const app = makeApp({ owned: () => false })
    const missing = await app.inject({ method: 'POST', url: '/api/sessions/ses_1/share-link' })
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/share-link',
      headers: { authorization: 'Bearer invalid' },
    })
    const unowned = await app.inject({
      method: 'POST',
      url: '/api/sessions/ses_1/share-link',
      headers: { authorization: 'Bearer owner-access' },
    })

    expect(missing.statusCode).toBe(401)
    expect(invalid.statusCode).toBe(401)
    expect(unowned.statusCode).toBe(404)
  })

  test('public viewer renders every owned event as escaped, non-cacheable HTML', async () => {
    const app = makeApp()
    const token = signSessionShareToken(7, 'ses_1')
    const response = await app.inject({ method: 'GET', url: `/share/session/${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.headers['cache-control']).toBe('no-store, private')
    expect(response.headers.pragma).toBe('no-cache')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.body).toContain('first-event')
    expect(response.body).toContain('second-event')
    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(response.body).not.toContain('<script>alert(1)</script>')
    expect(response.body).not.toMatch(/<script|<form|<iframe/i)
  })

  test('public viewer excludes document protocol events, metadata, and bodies', async () => {
    const app = makeApp({
      events: [
        { event_type: 'user_text', payload: { type: 'user_text', text: 'visible-message' } },
        {
          event_type: 'session_document_begin',
          payload: { type: 'session_document_begin', document_id: 'private-document', display_name: 'private.md' },
        },
        {
          event_type: 'session_document_chunk',
          payload: { type: 'session_document_chunk', chunk_data: 'private-body' },
        },
        {
          event_type: 'session_documents_changed',
          payload: { type: 'session_documents_changed', document_id: 'private-document' },
        },
      ],
    })
    const token = signSessionShareToken(7, 'ses_1')
    const response = await app.inject({ method: 'GET', url: `/share/session/${token}` })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('visible-message')
    expect(response.body).not.toContain('private-document')
    expect(response.body).not.toContain('private.md')
    expect(response.body).not.toContain('private-body')
    expect(response.body).not.toContain('session_document')
  })

  test('all invalid, expired, wrong-type, and mismatched share tokens return one generic unavailable page', async () => {
    const app = makeApp()
    const malformed = await app.inject({ method: 'GET', url: '/share/session/not-a-token' })
    const wrongTypeToken = jwt.sign(
      { type: 'access', userId: 7, email: 'owner@example.com' },
      shareTestKey,
      { expiresIn: '15m' },
    )
    const expiredToken = jwt.sign(
      { type: 'session_share', userId: 7, sessionId: 'ses_1' },
      shareTestKey,
      { expiresIn: -1 },
    )
    const mismatchToken = signSessionShareToken(8, 'ses_1')

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: `/share/session/${wrongTypeToken}` }),
      app.inject({ method: 'GET', url: `/share/session/${expiredToken}` }),
      app.inject({ method: 'GET', url: `/share/session/${mismatchToken}` }),
    ])

    for (const response of [malformed, ...responses]) {
      expect(response.statusCode).toBe(404)
      expect(response.body).toBe(malformed.body)
      expect(response.body).not.toContain('ses_1')
      expect(response.body).not.toContain('first-event')
    }
  })

  test('share token verifier accepts only the dedicated exact claim shape', () => {
    const valid = signSessionShareToken(7, 'ses_1')
    const extraClaim = jwt.sign(
      { ...(jwt.decode(valid) as object), role: 'admin' },
      shareTestKey,
    )

    expect(verifySessionShareToken(valid)).toMatchObject({ userId: 7, sessionId: 'ses_1',shareId:'11111111-1111-4111-8111-111111111111' })
    expect(verifySessionShareToken(extraClaim)).toBeNull()
    expect(verifySessionShareToken('invalid')).toBeNull()
  })

  test('public share route suppresses the bearer token from request logs', async () => {
    let logs = ''
    const app = makeApp({
      logger: {
        logger: {
          level: 'info',
          stream: { write: (message: string) => { logs += message } },
        },
      },
    })
    const token = signSessionShareToken(7, 'ses_1')
    await app.inject({ method: 'GET', url: `/share/session/${token}` })

    expect(logs).not.toContain(token)
  })

  test('reopen and URL retrieval preserve the same grant; revoke invalidates public access and replay', async () => {
    const store=memoryStore(),app=makeApp({store}),headers={authorization:'Bearer owner-access'},payload={request_id:randomUUID()}
    const create=()=>app.inject({method:'POST',url:'/api/sessions/ses_1/share-link',headers,payload})
    const first=(await create()).json(),again=(await create()).json()
    expect(again).toMatchObject({id:first.id,url:first.url,expires_at:first.expires_at})
    const path=new URL(first.url).pathname
    expect((await app.inject(path)).statusCode).toBe(200)
    expect((await app.inject({url:`/api/share-links/${first.id}/url`,headers})).json().url).toBe(first.url)
    const listed=(await app.inject({url:'/api/share-links?session_id=ses_1',headers})).json()
    expect(listed.links.every((r:any)=>!r.url)).toBe(true)
    expect((await app.inject({method:'DELETE',url:`/api/share-links/${first.id}`,headers})).json().status).toBe('revoked')
    expect((await app.inject(path)).statusCode).toBe(404)
    expect((await app.inject({url:`/api/share-links/${first.id}/url`,headers})).statusCode).toBe(410)
    expect((await create()).json()).toMatchObject({id:first.id,status:'revoked',expires_at:first.expires_at})
    expect((await create()).json().url).toBeUndefined()
    expect((await app.inject({method:'DELETE',url:`/api/share-links/${first.id}`,headers})).json().status).toBe('revoked')
  })
  test('unowned management and legacy stateless links are unavailable',async()=>{
    const store=memoryStore(),app=makeApp({store}),headers={authorization:'Bearer owner-access'}
    store.rows.set('22222222-2222-4222-8222-222222222222',{...store.rows.values().next().value!,id:'22222222-2222-4222-8222-222222222222',user_id:8})
    for(const method of ['GET','DELETE'] as const)expect((await app.inject({method,url:'/api/share-links/22222222-2222-4222-8222-222222222222',headers})).statusCode).toBe(404)
    const legacy=jwt.sign({type:'session_share',userId:7,sessionId:'ses_1'},shareTestKey,{expiresIn:'15m'})
    expect((await app.inject(`/share/session/${legacy}`)).statusCode).toBe(404)
  })
  test('revocation during history read and database failure both fail closed',async()=>{
    const store=memoryStore(),token=signSessionShareToken(7,'ses_1')
    const app=makeApp({store,history:async()=>{await store.revoke(7,'11111111-1111-4111-8111-111111111111');return []}})
    expect((await app.inject(`/share/session/${token}`)).statusCode).toBe(404)
    store.get=async()=>{throw new Error('database unavailable')}
    expect((await app.inject(`/share/session/${token}`)).statusCode).toBe(404)
  })

  test('production server registers the route with the resolved public issuer', () => {
    const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { registerSessionShareRoutes } from './session-share-routes.js'")
    expect(source).toContain('registerSessionShareRoutes(app, { pool, publicIssuer })')
  })
})
