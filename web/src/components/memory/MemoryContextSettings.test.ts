import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, test, vi } from 'vitest'
import MemoryContextSettings from './MemoryContextSettings.vue'

const api = vi.hoisted(() => ({ listContextSettings: vi.fn(), putContextSetting: vi.fn() }))
vi.mock('../../services/memoryClient', () => api)
beforeEach(() => vi.clearAllMocks())

test('failed settings reads show retry instead of offering writes against an unknown configuration', async () => {
  api.listContextSettings.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ settings: [] })
  const wrapper = mount(MemoryContextSettings)
  await flushPromises()
  expect(wrapper.find('[data-testid="context-settings-load-error"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="initial-mode-enabled"]').exists()).toBe(false)
  expect(api.putContextSetting).not.toHaveBeenCalled()

  await wrapper.get('[data-testid="context-settings-load-error"] button').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid="context-settings-load-error"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="initial-mode-enabled"]').exists()).toBe(true)
  wrapper.unmount()
})
