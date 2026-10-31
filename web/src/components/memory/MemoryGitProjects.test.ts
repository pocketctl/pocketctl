import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import { ref } from 'vue'
import MemoryGitProjects from './MemoryGitProjects.vue'
import zh from '../../i18n/zh.json'

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }))
vi.mock('../../services/memoryGitProjects', () => ({ memoryGitProjects: api }))
const user = ref({ id: 3 })
vi.mock('../../composables/useAuth', () => ({ useAuth: () => ({ user }) }))
vi.mock('../../composables/useEnv', () => ({ getRelayOrigin: () => '' }))
vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => (zh as Record<string, string>)[key] ?? key }) }))
const team = { id: 'ctm_team', name: 'PocketCTL', can_create: true }
const project = (request_id = '') => ({ id: 'project', team_id: team.id, team_name: team.name, name: 'PocketCTL code', repository_url: 'https://github.com/pocketctl/pocketctl', branch: 'main', provider: 'github', setup: 'memory_required', request_id })
beforeEach(() => { vi.resetAllMocks(); user.value = { id: 3 }; api.list.mockResolvedValue({ teams: [team], projects: [] }) })
async function panel() { const w = mount(MemoryGitProjects, { global: { stubs: { RouterLink: { template: '<a><slot /></a>' } } } }); await flushPromises(); return w }
async function fill(w: Awaited<ReturnType<typeof panel>>) {
  await w.get('[data-testid="git-project-create"]').trigger('click')
  await w.get('[data-testid="git-project-name"]').setValue('PocketCTL code')
  await w.get('[data-testid="git-project-url"]').setValue('https://github.com/pocketctl/pocketctl')
}
test('creation is available before any shared Memory scope exists and preserves the pending setup status', async () => {
  api.create.mockImplementation(async (_team, input) => ({ project: project(input.request_id) }))
  const w = await panel(); await fill(w)
  expect(w.get('[data-testid="git-project-team"]').text()).toContain('PocketCTL')
  await w.get('form').trigger('submit'); await flushPromises()
  expect(api.create).toHaveBeenCalledWith(team.id, expect.objectContaining({ name: 'PocketCTL code', branch: 'main' }), expect.objectContaining({ userId: 3 }))
  expect(w.get('[data-testid="git-project-card"]').text()).toContain('待初始化团队记忆')
  expect(w.get('[data-testid="git-project-created"]').text()).toContain('尚未连接仓库')
  expect(w.find('form').exists()).toBe(false); w.unmount()
})
test('viewers can read but do not get an enabled create action', async () => {
  api.list.mockResolvedValue({ teams: [{ ...team, can_create: false }], projects: [project()] })
  const w = await panel()
  expect(w.get('[data-testid="git-project-create"]').attributes('disabled')).toBeDefined()
  expect(w.text()).toContain('只有团队创建者或管理员'); expect(w.find('[data-testid="git-project-card"]').exists()).toBe(true)
  w.unmount()
})
test('a lost response freezes the original inputs and retry uses the same creation key', async () => {
  api.create.mockRejectedValueOnce(Object.assign(new Error('response lost'), { status: 0 }))
    .mockImplementationOnce(async (_team, input) => ({ project: project(input.request_id) }))
  const w = await panel(); await fill(w); await w.get('form').trigger('submit'); await flushPromises()
  const first = api.create.mock.calls[0]
  expect(w.get('fieldset').attributes('disabled')).toBeDefined()
  expect(w.text()).toContain('创建结果尚未确认')
  await w.get('form').trigger('submit'); await flushPromises()
  expect(api.create.mock.calls[1].slice(0, 2)).toEqual(first.slice(0, 2))
  expect(w.findAll('[data-testid="git-project-card"]')).toHaveLength(1); w.unmount()
})
test('refresh reconciles a committed request without a second create', async () => {
  api.create.mockRejectedValueOnce(Object.assign(new Error('response lost'), { status: 0 }))
  const w = await panel(); await fill(w); await w.get('form').trigger('submit'); await flushPromises()
  api.list.mockResolvedValue({ teams: [team], projects: [project(api.create.mock.calls[0][1].request_id)] })
  await w.findAll('button').find(button => button.text() === '刷新')!.trigger('click'); await flushPromises()
  expect(api.create).toHaveBeenCalledTimes(1); expect(w.find('form').exists()).toBe(false)
  expect(w.find('[data-testid="git-project-created"]').exists()).toBe(true)
  const previousKey = api.create.mock.calls[0][1].request_id
  await fill(w)
  api.create.mockImplementation(async (_team, input) => ({ project: project(input.request_id) }))
  await w.get('form').trigger('submit'); await flushPromises()
  expect(api.create.mock.calls[1][1].request_id).not.toBe(previousKey)
  w.unmount()
})
test('an account switch clears previous project data and discards a late create response', async () => {
  let finish!: (value: unknown) => void
  api.create.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const w = await panel(); await fill(w); await w.get('form').trigger('submit')
  api.list.mockResolvedValue({ teams: [], projects: [] }); user.value = { id: 9 }; await flushPromises()
  finish({ project: project() }); await flushPromises()
  expect(w.text()).not.toContain('PocketCTL code'); expect(w.find('[data-testid="git-project-created"]').exists()).toBe(false)
  expect(w.find('form').exists()).toBe(false); w.unmount()
})
test('permission loss during creation removes the old Team data and disables creation', async () => {
  api.list.mockResolvedValue({ teams: [team], projects: [project()] })
  api.create.mockRejectedValue(Object.assign(new Error('removed'), { status: 403, code: 'team_access_denied' }))
  const w = await panel(); await fill(w); await w.get('form').trigger('submit'); await flushPromises()
  expect(w.find('[data-testid="git-project-card"]').exists()).toBe(false)
  expect(w.get('[data-testid="git-project-create"]').attributes('disabled')).toBeDefined()
  expect(w.text()).toContain('团队访问权限已变化'); w.unmount()
})
