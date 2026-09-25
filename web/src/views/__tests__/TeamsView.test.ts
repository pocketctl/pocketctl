import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../composables/useAuth', () => ({ useAuth: () => ({ user: ref({ id: 7 }) }) }))
vi.mock('../../composables/useLocale', async () => {
  const table = (await import('../../i18n/zh.json')).default as Record<string, string>
  return { useLocale: () => ({ t: (key: string, params?: Record<string, string | number>) => {
    let value = table[key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.split(`{{${name}}}`).join(String(replacement))
    return value
  } }) }
})

const api = vi.hoisted(() => ({
  getTeamCapabilities: vi.fn(), listTeams: vi.fn(), getTeam: vi.fn(), listTeamMembers: vi.fn(),
  listTeamAgentOffers: vi.fn(), listTeamInvitations: vi.fn(), listTeamAgentCandidates: vi.fn(),
  listTeamSessions: vi.fn(), listMyTeamAgentCandidates: vi.fn(), createTeamWorkspace: vi.fn(),
}))
vi.mock('../../services/teamClient', () => api)

const teams = [
  { id: 'ctm_a', name: 'Alpha', creator_user_id: 7, state: 'active', revision: 2, member_count: 1, created_at: '', updated_at: '' },
  { id: 'ctm_b', name: 'Beta', creator_user_id: 8, state: 'active', revision: 3, member_count: 2, created_at: '', updated_at: '' },
] as const
const offlineAgent = { daemon_id: 'daemon-offline', hostname: 'Mac mini', provider: 'codex', installed: true, online: false, managed_callable: false, dispatch_supported: true, availability: 'offline', occupied_team_id: null } as const
const occupiedAgent = { ...offlineAgent, daemon_id: 'daemon-used', hostname: 'Studio', online: true, availability: 'occupied', occupied_team_id: 'ctm_other' } as const

async function render() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/teams', component: { template: '<div />' } }] })
  await router.push('/teams'); await router.isReady()
  const View = (await import('../TeamsView.vue')).default
  const wrapper = mount(View, { global: { plugins: [router], stubs: {
    TeamTasksPanel: { props: ['teamId'], template: '<div data-testid="tasks-stub">{{ teamId }}</div>' },
    TeamMembersPanel: { props: ['team'], template: '<div data-testid="members-stub">{{ team.id }}</div>' },
  } } })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getTeamCapabilities.mockResolvedValue({ schema_version: 1, contract_version: 'team-collaboration.v1', collaboration: true, autorun: false, memory_bridge: false, writes_enabled: true })
  api.listTeams.mockResolvedValue([...teams])
  api.getTeam.mockImplementation(async (id: string) => teams.find(team => team.id === id))
  api.listTeamMembers.mockImplementation(async (id: string) => [{ id: `member-${id}`, team_id: id, user_id: 7, display_label: `member-${id}`, state: 'active', revision: 1, joined_at: '', ended_at: null }])
  api.listTeamAgentOffers.mockResolvedValue([]); api.listTeamInvitations.mockResolvedValue([]); api.listTeamAgentCandidates.mockResolvedValue([]); api.listTeamSessions.mockResolvedValue([])
  api.listMyTeamAgentCandidates.mockResolvedValue([offlineAgent, occupiedAgent])
  api.createTeamWorkspace.mockResolvedValue({ team: { ...teams[0], id: 'ctm_new', name: 'New team' }, warnings: [] })
})

describe('TeamsView', () => {
  test('has one workspace with three internal tabs and isolates data while switching teams', async () => {
    const { wrapper } = await render()
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(3)
    expect(wrapper.get('[data-testid="tasks-stub"]').text()).toBe('ctm_a')
    await wrapper.get('[data-team-id="ctm_b"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-testid="team-tab-members"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-testid="members-stub"]').text()).toBe('ctm_b')
    expect(api.listTeamMembers).toHaveBeenLastCalledWith('ctm_b')
  })

  test('creates with optional invitations and an honestly labeled offline agent', async () => {
    const { wrapper } = await render()
    await wrapper.get('[data-testid="team-create-open"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-testid="team-create-dialog"]').text()).toContain('离线')
    expect(wrapper.get('[data-testid="team-create-dialog"]').text()).toContain('已占用')
    expect(wrapper.get('[data-testid="team-agent-daemon-used:codex"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="team-create-name"]').setValue('New team')
    await wrapper.get('[data-testid="team-create-emails"]').setValue('member@example.test')
    await wrapper.get('[data-testid="team-agent-daemon-offline:codex"]').setValue(true)
    await wrapper.get('[data-testid="team-create-dialog"] form').trigger('submit'); await flushPromises()
    expect(api.createTeamWorkspace).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New team', invitationEmails: ['member@example.test'], agents: [offlineAgent],
    }))
    expect(wrapper.find('[data-testid="team-create-dialog"]').exists()).toBe(false)
  })
})
