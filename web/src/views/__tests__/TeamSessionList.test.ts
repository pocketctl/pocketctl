import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const api = vi.hoisted(() => ({ updateTeamSession:vi.fn(),getTeamSession:vi.fn(),getTeamContext:vi.fn(async()=>null),createTeamContext:vi.fn(async()=>({})),listTeamTasks:vi.fn(async()=>[]),listTeamMembers:vi.fn(async()=>[]),listTeamAgentCandidates: vi.fn(), listTeams: vi.fn(), listTeamAgentOffers: vi.fn(), listTeamSessions: vi.fn(), createTeamSession: vi.fn() }))
vi.mock('../../services/teamClient', () => api)

vi.mock('../../composables/useAuth', async()=>{const {ref}=await import('vue');return {useAuth:()=>({user:ref({id:7}),accessToken:ref('token')})}})
let writesEnabled = true
vi.mock('../../composables/useTeamAccess', async()=>{const {ref}=await import('vue');return {useTeamAccess:()=>({capabilities:ref({writes_enabled:writesEnabled})})}})

const session = {
  id: 'css_1', team_id: 'ctm_1', creator_user_id: 7, task_id: null, title: 'Joint review', state: 'active', revision: 1,
  latest_event_seq: 3, current_context_version: 1, created_at: '', updated_at: '2026-09-25T00:00:00Z',
  participants: [{ id: 'p1', user_id: 7, state: 'active', revision: 1 }],
  agent_bindings: [{ id: 'b1', offer_id: 'offer-1', owner_user_id: 7, daemon_id: 'd1', provider: 'codex', state: 'active', revision: 1, native_session_id: null, availability: 'online' }],
}

async function render() {
  const View = (await import('../TeamSessionListView.vue')).default
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/team/:teamId/sessions', name: 'team-sessions', component: View },
    { path: '/team/:teamId/session/:id', name: 'team-session', component: { template: '<div />' } },
    { path: '/sessions', component: { template: '<div />' } },
  ] })
  await router.push('/team/ctm_1/sessions'); await router.isReady()
  const wrapper = mount(View, { global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, router }
}

beforeEach(() => {
  writesEnabled = true
  vi.clearAllMocks()
  api.listTeams.mockResolvedValue([{ id: 'ctm_1', name: 'Alpha' }, { id: 'ctm_2', name: 'Beta' }])
  api.listTeamAgentCandidates.mockResolvedValue([{daemon_id:'d1',hostname:'Host One',online:true},{daemon_id:'d2',hostname:'Host Two',online:true}])
  api.listTeamAgentOffers.mockResolvedValue([{ id: 'offer-1', state:'active', daemon_id: 'd1', provider: 'codex', managed_callable: true, online:true, availability: 'online' }, {id:'offer-2',state:'active',daemon_id:'d2',provider:'claude-code',managed_callable:false,online:true,availability:'unmanaged'}])
  api.listTeamSessions.mockResolvedValue([session])
  api.createTeamSession.mockResolvedValue(session)
  api.getTeamSession.mockResolvedValue(session)
  api.getTeamContext.mockResolvedValue(null)
  api.createTeamContext.mockResolvedValue({})
})

describe('team session list', () => {
  test('archives using the current revision after bindings changed outside the sidebar', async () => {
    const current = { ...session, revision: 4 }
    api.getTeamSession.mockResolvedValue(current)
    api.updateTeamSession.mockResolvedValue({ ...current, state: 'archived', revision: 5 })
    const { wrapper } = await render()
    await wrapper.get('.row-more').trigger('click')
    await wrapper.findAll('[role="menuitem"]').find(button => button.text() === '归档会话')!.trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '确认归档')!.trigger('click')
    await flushPromises()
    expect(api.getTeamSession).toHaveBeenCalledWith(session.id)
    expect(api.updateTeamSession).toHaveBeenCalledWith(current, { state: 'archived' })
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'TeamSessionBrowser' }).emitted('updated')?.[0]?.[0]).toMatchObject({ state: 'archived', revision: 5 })
    wrapper.unmount()
  })

  test('keeps copy available to readers without exposing creator write actions', async () => {
    writesEnabled = false
    const { wrapper } = await render()
    await wrapper.get('.row-more').trigger('click')
    expect(wrapper.get('[role="menu"]').text()).toContain('复制会话 ID')
    expect(wrapper.get('[role="menu"]').text()).not.toContain('重命名')
    expect(wrapper.get('[role="menu"]').text()).not.toContain('归档会话')
    wrapper.unmount()
  })
  test('requires daemon and provider to match the same binding when filtering', async () => {
    const { wrapper } = await render()
    api.listTeamSessions.mockResolvedValue([session, {...session,id:'css_2',title:'Cross binding',agent_bindings:[{...session.agent_bindings[0],provider:'claude-code'},{...session.agent_bindings[0],id:'b2',daemon_id:'d2',provider:'codex'}]}])
    // Reload through a fresh mount so the fixture contains both combinations.
    wrapper.unmount()
    const {wrapper: filtered} = await render()
    await filtered.get('.host-trigger').trigger('click')
    await filtered.findAll('.filter-menu button').find(button=>button.text().includes('Host One'))!.trigger('click')
    await filtered.findAll('.filter-trigger')[1].trigger('click')
    await filtered.findAll('[role="menuitemradio"]').find(button=>button.text().includes('Codex'))!.trigger('click')
    expect(filtered.text()).toContain('Joint review')
    expect(filtered.text()).not.toContain('Cross binding')
    expect(api.listTeamSessions).toHaveBeenCalledWith('ctm_1')

  })

  test('creates with selected callable offers and opens the independent route', async () => {
    const { wrapper, router } = await render()
    await wrapper.get('button[aria-label="新建共享会话"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="team-session-title"]').setValue('Joint review')
    await wrapper.get('[data-testid="team-session-goal"]').setValue('Review our next steps')
    await wrapper.get('.offer-choice input:not(:disabled)').setValue(true)
    await wrapper.get('[data-testid="team-session-create"]').trigger('submit')
    await flushPromises()
    expect(api.createTeamSession).toHaveBeenCalledWith('ctm_1', { title: 'Joint review', offerIDs: ['offer-1'], taskID: undefined })
    expect(router.currentRoute.value.name).toBe('team-session')
  })
  test('retries unfinished Context setup without creating a duplicate session', async () => {
    api.createTeamContext.mockRejectedValueOnce(new Error('temporary failure'))
    const {wrapper,router}=await render()
    await wrapper.get('button[aria-label="新建共享会话"]').trigger('click');await flushPromises()
    await wrapper.get('[data-testid="team-session-title"]').setValue('Recover setup')
    await wrapper.get('[data-testid="team-session-goal"]').setValue('Shared goal')
    await wrapper.get('.offer-choice input:not(:disabled)').setValue(true)
    await wrapper.get('[data-testid="team-session-create"]').trigger('submit');await flushPromises()
    expect(wrapper.text()).toContain('重试剩余设置')
    expect(router.currentRoute.value.name).toBe('team-sessions')
    await wrapper.get('[data-testid="team-session-create"]').trigger('submit');await flushPromises()
    expect(api.createTeamSession).toHaveBeenCalledTimes(1)
    expect(api.getTeamContext).toHaveBeenCalledWith('css_1')
    expect(api.createTeamContext).toHaveBeenCalledTimes(2)
    expect(router.currentRoute.value.name).toBe('team-session')
  })

})
