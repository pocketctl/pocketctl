import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ref } from 'vue'

const accessToken = ref('access-1')
const doRefreshToken = vi.fn(async () => false)

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ accessToken, doRefreshToken }),
}))
vi.mock('../../composables/useEnv', () => ({ getRelayOrigin: () => 'https://relay.test' }))

import { appendTeamMessage, createTeamSession, createTeamWorkspace, getTeamCapabilities, listTeamSessions, respondToTeamInvitation } from '../teamClient'

describe('teamClient', () => {
  beforeEach(() => {
    accessToken.value = 'access-1'
    doRefreshToken.mockReset()
    doRefreshToken.mockResolvedValue(false)
    vi.unstubAllGlobals()
  })

  test('loads server capabilities with the current access token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      schema_version: 1,
      contract_version: 'team-collaboration.v1',
      collaboration: false,
      autorun: false,
      memory_bridge: false,
      writes_enabled: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getTeamCapabilities()).resolves.toMatchObject({ collaboration: false })
    expect(fetchMock).toHaveBeenCalledWith('https://relay.test/api/team/capabilities', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer access-1' }),
    }))
  })

  test('refreshes once after an unauthorized response', async () => {
    doRefreshToken.mockImplementation(async () => {
      accessToken.value = 'access-2'
      return true
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: 1,
        contract_version: 'team-collaboration.v1',
        collaboration: true,
        autorun: false,
        memory_bridge: false,
        writes_enabled: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getTeamCapabilities()).resolves.toMatchObject({ collaboration: true })
    expect(doRefreshToken).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer access-2' })
  })

  test('returns a typed error for server failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'team_feature_disabled', message: 'disabled', retryable: true },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })))

    await expect(getTeamCapabilities()).rejects.toMatchObject({
      status: 503,
      code: 'team_feature_disabled',
      retryable: true,
    })
  })

  test('sends revision-checked invitation responses without daemon data', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await respondToTeamInvitation({
      id: 'cin_1', team_id: 'ctm_1', invited_by_user_id: 2, recipient_user_id: 1,
      recipient_email: 'member@example.test', state: 'pending', revision: 4,
      expires_at: '2026-10-01T00:00:00Z', created_at: '2026-09-25T00:00:00Z',
    }, 'accept')

    expect(fetchMock).toHaveBeenCalledWith('https://relay.test/api/team/invitations/cin_1/accept', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"expected_revision":4'),
    }))
  })

  test('creates a team then applies invitations and selected agents in revision order', async () => {
    const requests: Array<{ url: string; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.endsWith('/api/team/teams')) return new Response(JSON.stringify({ team: {
        id: 'ctm_1', name: 'Research', creator_user_id: 1, state: 'active', revision: 1,
        member_count: 1, created_at: '', updated_at: '',
      } }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/invitations')) return new Response(JSON.stringify({ invitation: {} }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ offer: {} }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }))

    const result = await createTeamWorkspace({
      name: 'Research', invitationEmails: ['a@example.test'],
      agents: [{ daemon_id: 'daemon-1', hostname: 'Mac mini', provider: 'codex', installed: true,
        online: false, managed_callable: false, dispatch_supported: true, availability: 'offline', occupied_team_id: null }],
    })

    expect(result.team.revision).toBe(3)
    expect(requests[1]?.body.expected_revision).toBe(1)
    expect(requests[2]?.body.expected_revision).toBe(2)
  })

  test('uses joint session filters and sends real targeted event payloads', async () => {
    const requests: Array<{ url: string; method?: string; body?: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.includes('/events')) return new Response(JSON.stringify({ event: { id: 'e1' }, call_ids: ['c1'] }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      if (init?.method === 'POST') return new Response(JSON.stringify({ session: { id: 'css_1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await listTeamSessions('ctm_1', { daemonID: 'daemon 1', provider: 'codex' })
    await createTeamSession('ctm_1', { title: 'Review', offerIDs: ['offer-1'] })
    await appendTeamMessage('css_1', { content: 'hello', targetMode: 'offers', targetOfferIDs: ['offer-1'], referenceEventID: 'e0' })

    expect(requests[0].url).toContain('daemon_id=daemon+1&provider=codex')
    expect(requests[1].body).toMatchObject({ title: 'Review', offer_ids: ['offer-1'] })
    expect(requests[2].body).toMatchObject({ content: 'hello', target_mode: 'offers', target_offer_ids: ['offer-1'], reference_event_id: 'e0' })
  })
})
