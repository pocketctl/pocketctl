import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import MemoryContextSettings from './MemoryContextSettings.vue'
import type { ContextSettings } from '../../types/memory'
import { useLocale } from '../../composables/useLocale'
const api = vi.hoisted(() => ({ listContextSettings: vi.fn(), putContextSetting: vi.fn() }))
vi.mock('../../services/memoryClient', () => api)
const row = (overrides: Partial<ContextSettings> = {}): ContextSettings => ({ settingId: 'first', scopeKind: 'session', scopeKey: 'session-1', agent: null, mode: 'off', maxTokens: null, revision: 2, ...overrides })
beforeEach(() => { vi.resetAllMocks(); useLocale().setLocale('en'); api.listContextSettings.mockResolvedValue({ settings: [] }); api.putContextSetting.mockResolvedValue({ revision: 7 }) })
async function openForm(settings: ContextSettings[] = []) {
  api.listContextSettings.mockResolvedValue({ settings })
  const wrapper = mount(MemoryContextSettings); await flushPromises()
  await wrapper.get('[data-testid="context-settings-add"]').trigger('click'); return wrapper
}
test('failed reads block writes and retry restores add entry', async () => {
  api.listContextSettings.mockRejectedValueOnce(new TypeError('Failed to fetch'))
  const wrapper = mount(MemoryContextSettings); await flushPromises()
  expect(wrapper.find('[data-testid="context-settings-load-error"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="context-settings-add"]').exists()).toBe(false)
  await wrapper.get('[data-testid="context-settings-load-error"] button').trigger('click'); await flushPromises()
  expect(wrapper.find('[data-testid="context-settings-add"]').exists()).toBe(true)
  expect(api.putContextSetting).not.toHaveBeenCalled()
})
test('adds global off with two existing session off rows', async () => {
  const wrapper = await openForm([row(), row({ settingId: 'second', scopeKey: 'session-2' })])
  expect(wrapper.get<HTMLSelectElement>('[data-testid="context-mode"]').element.value).toBe('off')
  expect(wrapper.text()).toContain('not the resolved effective mode')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(api.putContextSetting).toHaveBeenCalledExactlyOnceWith({ scope_kind: 'installation', scope_key: 'global', agent: null, mode: 'off', max_tokens: null, expected_revision: 1, create_only: true })
})
test.each(['repository', 'session'] as const)('creates %s with agent and token limit', async scope => {
  const wrapper = await openForm(), key = scope === 'repository' ? '11111111-1111-4111-8111-111111111111' : 'session-new'
  await wrapper.get('[data-testid="context-scope"]').setValue(scope)
  await wrapper.get('[data-testid="context-key"]').setValue(key)
  await wrapper.get('[data-testid="context-agent"]').setValue('codex')
  await wrapper.get('[data-testid="context-mode"]').setValue('shadow')
  await wrapper.get('[data-testid="context-tokens"]').setValue('2000')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(api.putContextSetting).toHaveBeenCalledWith(expect.objectContaining({ scope_kind: scope, scope_key: key, agent: 'codex', mode: 'shadow', max_tokens: 2000, create_only: true }))
})
test('rejects invalid identifiers and token bounds', async () => {
  const wrapper = await openForm()
  await wrapper.get('[data-testid="context-scope"]').setValue('repository')
  await wrapper.get('[data-testid="context-key"]').setValue('not-a-uuid')
  await wrapper.get('form').trigger('submit'); expect(wrapper.text()).toContain('valid repository UUID')
  await wrapper.get('[data-testid="context-scope"]').setValue('session')
  await wrapper.get('[data-testid="context-key"]').setValue(' ')
  await wrapper.get('form').trigger('submit'); expect(wrapper.text()).toContain('1–64 characters')
  await wrapper.get('[data-testid="context-key"]').setValue('session-new')
  for (const tokens of ['0', '2001', '1.5']) {
    await wrapper.get('[data-testid="context-tokens"]').setValue(tokens)
    await wrapper.get('form').trigger('submit'); expect(wrapper.text()).toContain('integer from 1 to 2000')
  }
  expect(api.putContextSetting).not.toHaveBeenCalled()
})
test('refreshes before creation and refuses new duplicates', async () => {
  const wrapper = await openForm()
  api.listContextSettings.mockResolvedValue({ settings: [row({ scopeKind: 'installation', scopeKey: 'global', revision: 1 })] })
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(wrapper.text()).toContain('already exists'); expect(api.putContextSetting).not.toHaveBeenCalled()
})
test('creation distinguishes server conflicts from network failure and keeps draft', async () => {
  const wrapper = await openForm()
  api.putContextSetting.mockRejectedValueOnce({ status: 409 }).mockRejectedValueOnce(new TypeError('network'))
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(wrapper.text()).toContain('another request may have created')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(wrapper.text()).toContain('request could not be confirmed'); expect(wrapper.find('form').exists()).toBe(true)
})
test('row retry preserves CAS and successful update uses server revision', async () => {
  api.listContextSettings.mockResolvedValue({ settings: [row()] })
  api.putContextSetting.mockRejectedValueOnce(new TypeError('network')).mockResolvedValue({ revision: 7 })
  const wrapper = mount(MemoryContextSettings); await flushPromises()
  await wrapper.get('[data-testid="mode-shadow-session"]').trigger('click'); await flushPromises()
  expect(wrapper.find('[data-testid="cas-conflict"]').exists()).toBe(false)
  await wrapper.get('[data-testid="context-settings-request-error"]').findAll('button')[1]!.trigger('click'); await flushPromises()
  await wrapper.get('[data-testid="mode-enabled-session"]').trigger('click'); await flushPromises()
  expect(api.putContextSetting.mock.calls[0]![0].expected_revision).toBe(2)
  expect(api.putContextSetting.mock.calls[2]![0].expected_revision).toBe(7)
})
test('409 exposes refresh then writes refreshed revision', async () => {
  api.listContextSettings.mockResolvedValueOnce({ settings: [row()] }).mockResolvedValue({ settings: [row({ revision: 8 })] })
  api.putContextSetting.mockRejectedValueOnce({ status: 409 }).mockResolvedValue({ revision: 9 })
  const wrapper = mount(MemoryContextSettings); await flushPromises()
  await wrapper.get('[data-testid="mode-enabled-session"]').trigger('click'); await flushPromises()
  await wrapper.get('[data-testid="cas-conflict"] button').trigger('click'); await flushPromises()
  await wrapper.get('[data-testid="mode-shadow-session"]').trigger('click'); await flushPromises()
  expect(api.putContextSetting.mock.calls[1]![0].expected_revision).toBe(8)
})
test('canonicalizes repository UUID casing on creation', async () => {
  const wrapper = await openForm()
  await wrapper.get('[data-testid="context-scope"]').setValue('repository')
  await wrapper.get('[data-testid="context-key"]').setValue('AABBCCDD-1234-4ABC-8DEF-012345ABCDEF')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(api.putContextSetting).toHaveBeenCalledWith(expect.objectContaining({ scope_key: 'aabbccdd-1234-4abc-8def-012345abcdef' }))
})
test.each([
  ['AABBCCDD-1234-4ABC-8DEF-012345ABCDEF', 'aabbccdd-1234-4abc-8def-012345abcdef'],
  ['aabbccdd-1234-4abc-8def-012345abcdef', 'AABBCCDD-1234-4ABC-8DEF-012345ABCDEF'],
])('rejects repository duplicate across casing (%s)', async (existing, draft) => {
  const wrapper = await openForm([row({ scopeKind: 'repository', scopeKey: existing })])
  await wrapper.get('[data-testid="context-scope"]').setValue('repository')
  await wrapper.get('[data-testid="context-key"]').setValue(draft)
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(wrapper.text()).toContain('already exists')
  expect(api.putContextSetting).not.toHaveBeenCalled()
})
test('preserves session ID casing and does not merge case-distinct sessions', async () => {
  const wrapper = await openForm([row({ scopeKey: 'session-abc' })])
  await wrapper.get('[data-testid="context-scope"]').setValue('session')
  await wrapper.get('[data-testid="context-key"]').setValue('Session-ABC')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(api.putContextSetting).toHaveBeenCalledWith(expect.objectContaining({ scope_key: 'Session-ABC' }))
})
