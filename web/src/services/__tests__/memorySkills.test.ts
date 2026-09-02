import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ref } from 'vue'
vi.mock('../../composables/useAuth', () => ({ useAuth: () => ({ accessToken: ref('relay-user-token') }) }))
vi.mock('../../composables/useEnv', () => ({ getRelayOrigin: () => 'https://relay.example' }))
const { memorySkills } = await import('../memorySkills')
const { resetMemoryClient } = await import('../memoryClient')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => resetMemoryClient())
afterEach(() => vi.unstubAllGlobals())

test('uses exact scope and read/manage grants, direct provider routing and strict snake_case requests', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.includes('/grants')) return json({ grant: 'scoped-capability', expires_in: 60, provider_public_origin: 'https://memory.example' })
    return json({ items: [] })
  }))
  const signal = new AbortController().signal
  await memorySkills.list('scope-team', { cursor: 'next/page', repository_id: 'repo-1' }, signal)
  await memorySkills.review('scope-team', 'skill-1', 4, 'approve', signal)
  const grants = calls.filter(call => call.url.includes('/grants'))
  expect(grants.map(call => JSON.parse(String(call.init.body)))).toEqual([
    { installation_ids: ['scope-team'], caller_type: 'web', services: ['memory.search'] },
    { installation_ids: ['scope-team'], caller_type: 'web', services: ['memory.manage'] },
  ])
  const reads = calls.find(call => call.url.startsWith('https://memory.example') && !call.init.method)!
  expect(new URL(reads.url).searchParams.get('cursor')).toBe('next/page')
  expect(new URL(reads.url).searchParams.get('limit')).toBe('20')
  const write = calls.find(call => call.url.endsWith('/skill-1/review'))!
  expect(JSON.parse(String(write.init.body))).toEqual({ expected_revision: 4, decision: 'approve' })
  for (const call of calls.filter(call => call.url.startsWith('https://memory.example'))) {
    expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer scoped-capability')
    expect(call.init.redirect).toBe('error'); expect(call.init.signal).toBe(signal)
  }
})

test('refreshes one expired grant then preserves server status/code for UI conflicts', async () => {
  let grants = 0, requests = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/grants')) { grants++; return json({ grant: `grant-${grants}`, expires_in: 60, provider_public_origin: 'https://memory.example' }) }
    requests++
    return requests === 1 ? json({ error: { code: 'expired' } }, 401) : json({ error: { code: 'revision_conflict', message: 'version changed', current_revision: 7 } }, 409)
  }))
  await expect(memorySkills.revoke('scope-a', 'skill-1', 4)).rejects.toMatchObject({ status: 409, code: 'revision_conflict', currentRevision: 7 })
  expect(grants).toBe(2); expect(requests).toBe(2)
})

test('scope changes cannot reuse the previous scope grant and auth reset drops cached v2 grants', async () => {
  const scopes: string[][] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/grants')) { scopes.push(JSON.parse(String(init.body)).installation_ids); return json({ grant: 'grant', expires_in: 60, provider_public_origin: 'https://memory.example' }) }
    return json({ items: [] })
  }))
  await memorySkills.list('scope-a'); await memorySkills.list('scope-b'); resetMemoryClient(); await memorySkills.list('scope-b')
  expect(scopes).toEqual([['scope-a'], ['scope-b'], ['scope-b']])
})

test('sends the explicit reviewer classification only on approval', async () => {
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes('/grants')) return json({ grant: 'grant', expires_in: 60, provider_public_origin: 'https://memory.example' })
    bodies.push(JSON.parse(String(init.body))); return json({ skill_id: 'skill-1' })
  }))
  for (const outcome of ['accepted_as_is', 'light_edit', 'major_edit'] as const) {
    await memorySkills.review('scope-a', 'skill-1', 4, 'approve', undefined, outcome)
  }
  await memorySkills.review('scope-a', 'skill-1', 4, 'reject', undefined, 'light_edit')
  expect(bodies).toEqual([
    { expected_revision: 4, decision: 'approve', review_outcome: 'accepted_as_is' },
    { expected_revision: 4, decision: 'approve', review_outcome: 'light_edit' },
    { expected_revision: 4, decision: 'approve', review_outcome: 'major_edit' },
    { expected_revision: 4, decision: 'reject' },
  ])
})
