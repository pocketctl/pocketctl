import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { computed, ref } from 'vue'
import { describe, expect, test, vi } from 'vitest'
import type { AttentionInboxStore } from '../../../composables/useAttentionInbox'
import type { AttentionInboxCapabilities, AttentionInboxScope } from '../../../types/attentionInbox'

function testStore(available: boolean, count: number): {
  value: AttentionInboxStore
  refresh: ReturnType<typeof vi.fn>
  setAvailable(value: boolean): void
} {
  const refresh = vi.fn(async () => undefined)
  const availability = ref(available)
  const capabilities = ref<AttentionInboxCapabilities>({
      schema_version: 1, mode: available ? 'on' : 'off', enabled: available,
      remote_response_enabled: available,
      providers: {
        codex: { projection: available, remote_response: available },
        opencode: { projection: available, remote_response: available },
        'claude-code': { projection: false, remote_response: false },
      },
    })
  return { refresh, setAvailable(value) {
    availability.value = value
    capabilities.value = { ...capabilities.value, enabled: value, mode: value ? 'on' : 'off' }
  }, value: {
    capabilities,
    isAvailable: computed(() => availability.value),
    isLoading: ref(false), errorMessage: ref(''),
    actionableCount: () => count,
    start: async () => undefined, stop: () => undefined, refresh,
    loadMore: async () => undefined, hasMore: () => false, itemsFor: () => [], itemById: () => undefined,
    recoveryItemsFor: () => [], recoveryById: () => undefined, attentionCount: () => count,
    allowedActions: () => [], markSeen: async () => false, snooze: async () => false,
    restore: async () => false, markRecoverySeen: async () => false,
    snoozeRecovery: async () => false, restoreRecovery: async () => false, submit: async () => false,
  } }
}

async function render(input: { scope: AttentionInboxScope; available?: boolean; count?: number; variant?: 'default' | 'nav' }) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }, { path: '/inbox', component: { template: '<div />' } }],
  })
  await router.push('/')
  await router.isReady()
  const Component = (await import('../AttentionInboxEntryButton.vue')).default
  const fakeStore = testStore(input.available ?? true, input.count ?? 0)
  const wrapper = mount(Component, {
    props: { scope: input.scope, store: fakeStore.value, variant: input.variant },
    global: { plugins: [router] },
  })
  await flushPromises()
  return { wrapper, router, refresh: fakeStore.refresh, setAvailable: fakeStore.setAvailable }
}

describe('AttentionInboxEntryButton', () => {
  test('renders nothing while the server capability is disabled', async () => {
    const { wrapper } = await render({ scope: { type: 'global' }, available: false, count: 4 })
    expect(wrapper.find('[data-testid="attention-inbox-entry"]').exists()).toBe(false)
  })

  test('opens the global inbox and caps a large actionable badge', async () => {
    const { wrapper, router } = await render({ scope: { type: 'global' }, count: 142 })
    const button = wrapper.get('[data-testid="attention-inbox-entry"]')

    expect(button.text()).toContain('99+')
    expect(button.attributes('aria-label')).toContain('142')
    await button.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/inbox')
  })

  test('renders the compact navigation treatment without putting the badge in layout flow', async () => {
    const { wrapper } = await render({ scope: { type: 'global' }, count: 7, variant: 'nav' })
    const button = wrapper.get('[data-testid="attention-inbox-entry"]')

    expect(button.classes()).toContain('attention-entry-button--nav')
    expect(button.classes()).toContain('has-attention')
    expect(button.get('b').text()).toBe('7')
  })

  test('preserves daemon id and display name in the scoped target', async () => {
    const scope = { type: 'daemon' as const, daemonId: 'daemon/1', daemonName: 'Mac Studio' }
    const { wrapper, router, refresh } = await render({
      scope, count: 2,
    })

    expect(refresh).toHaveBeenCalledWith(scope)

    await wrapper.get('[data-testid="attention-inbox-entry"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ daemon_id: 'daemon/1', daemon_name: 'Mac Studio' })
  })

  test('loads the daemon count when global capability finishes enabling after mount', async () => {
    const scope = { type: 'daemon' as const, daemonId: 'daemon-1' }
    const { refresh, setAvailable } = await render({ scope, available: false })

    setAvailable(true)
    await flushPromises()

    expect(refresh).toHaveBeenCalledWith(scope)
  })
})
