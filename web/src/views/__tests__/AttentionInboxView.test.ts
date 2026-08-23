import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { ref } from 'vue'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AttentionInboxItem, AttentionInboxSnapshot, AttentionRecoveryItem } from '../../types/attentionInbox'
import { createAttentionInboxStore } from '../../composables/useAttentionInbox'

const mobile = ref(false)
vi.mock('../../composables/useResponsiveLayout', () => ({
  useResponsiveLayout: () => ({ isMobile: mobile }),
}))

const approval: AttentionInboxItem = {
  item_id: 'approval-1', revision: 4, provider: 'codex', kind: 'approval', state: 'open',
  risk: {
    level: 'critical', classification_incomplete: true,
    reasons: ['executes_command', 'unknown_server_reason', 'executes_command'],
  },
  daemon: { id: 'daemon-1', display_name: 'Mac Studio' },
  session: { id: 'session-approval', title: 'Production deploy', status: 'waiting_approval' },
  request_id: 'request-approval', title: 'Deploy production?', summary: 'Codex requests a command',
  context: { command: './deploy.sh --production', cwd: '/repo' },
  allowed_actions: [
    { id: 'once', style: 'primary', destructive: false, label_key: 'attention.action.once' },
    { id: 'reject', style: 'danger', destructive: true, label_key: 'attention.action.reject' },
  ],
  seen_at: null, snoozed_until: null, submitted_at: null, resolved_at: null, handled_at: null,
  expires_at: null, resolution: null, last_error: null,
  created_at: '2026-08-12T01:00:00.000Z', updated_at: '2026-08-12T02:00:00.000Z',
}

const question: AttentionInboxItem = {
  ...approval,
  item_id: 'question-1', revision: 2, provider: 'opencode', kind: 'question',
  risk: { level: 'medium', classification_incomplete: true, reasons: [] },
  session: { id: 'session-question', title: 'Migration choice', status: 'waiting' },
  request_id: 'request-question', title: 'Choose rollback strategy', summary: 'OpenCode needs a choice',
  context: {
    questions: [{
      id: 'strategy', question: 'Which strategy?', multiple: false, custom: true,
      options: [{ label: 'Blue-green', description: 'Keep both versions' }, { label: 'Snapshot' }],
    }],
  },
  allowed_actions: [
    { id: 'answer', style: 'primary', destructive: false, label_key: 'attention.action.answer' },
    { id: 'reject', style: 'danger', destructive: true, label_key: 'attention.action.reject' },
  ],
  updated_at: '2026-08-12T01:30:00.000Z',
}

const snoozed: AttentionInboxItem = {
  ...approval, item_id: 'snoozed-1', revision: 3, state: 'snoozed', title: 'Deferred approval',
  snoozed_until: '2026-08-12T03:00:00.000Z', updated_at: '2026-08-12T01:00:00.000Z',
}

const resolved: AttentionInboxItem = {
  ...approval, item_id: 'resolved-1', revision: 8, state: 'resolved', title: 'Handled approval',
  allowed_actions: [], resolved_at: '2026-08-12T02:00:00.000Z', handled_at: '2026-08-12T02:00:00.000Z',
}

const recovery: AttentionRecoveryItem = {
  recovery_id: 'recovery-1', revision: 2, kind: 'recovery', state: 'open',
  reason_code: 'daemon_offline', daemon: { id: 'daemon-1', display_name: 'Mac Studio' },
  navigation: { type: 'host', daemon_id: 'daemon-1' },
  last_seen_at: '2026-08-12T01:58:00.000Z', seen_at: null, snoozed_until: null,
  resolved_at: null, handled_at: null, resolution: null,
  created_at: '2026-08-12T02:00:00.000Z', updated_at: '2026-08-12T02:00:00.000Z',
}

function capabilities(mode: 'off' | 'observe' | 'on') {
  return {
    schema_version: 2 as const, mode, enabled: mode !== 'off', remote_response_enabled: mode === 'on',
    providers: {
      codex: { projection: mode !== 'off', remote_response: mode === 'on' },
      opencode: { projection: mode !== 'off', remote_response: mode === 'on' },
      'claude-code': { projection: false, remote_response: false },
    },
    recovery: { mode: mode === 'on' ? 'on' as const : 'off' as const, projection: mode === 'on', visible: mode === 'on' },
  }
}

function snapshot(mode: 'off' | 'observe' | 'on' = 'on'): AttentionInboxSnapshot {
  const items = mode === 'off' ? [] : [approval, question, snoozed, resolved]
  return {
    schema_version: 2, server_time: '2026-08-12T02:00:00.000Z', capabilities: capabilities(mode),
    scope: { type: 'global', daemon_id: null },
    counts: { actionable: mode === 'on' ? 2 : 0, open: 2, snoozed: 1, submitting: 0, result_unknown: 0 },
    items, recovery_items: mode === 'on' ? [recovery] : [], next_cursor: null,
  }
}

async function render(mode: 'off' | 'observe' | 'on' = 'on') {
  const list = vi.fn(async () => snapshot(mode))
  const mutate = vi.fn(async (input: any) => ({
    item: input.operation === 'restore'
      ? { ...snoozed, revision: 4, state: 'open' as const, snoozed_until: null }
      : input.operation === 'snooze'
        ? { ...approval, revision: 5, state: 'snoozed' as const, snoozed_until: input.snoozedUntil }
        : { ...(input.itemId === question.item_id ? question : approval), revision: input.itemId === question.item_id ? 3 : 5, seen_at: '2026-08-12T02:01:00.000Z' },
  }))
  const submit = vi.fn(async (input: any) => ({
    outcome: 'submitted' as const, receipt_id: '1',
    item: { ...(input.itemId === question.item_id ? question : approval), revision: 5, state: 'submitting' as const },
    final: false,
  }))
  const mutateRecovery = vi.fn(async (input: any) => ({
    recovery: input.operation === 'snooze'
      ? { ...recovery, revision: 3, state: 'snoozed' as const, snoozed_until: input.snoozedUntil }
      : { ...recovery, revision: 3, seen_at: '2026-08-12T02:01:00.000Z' },
  }))
  const store = createAttentionInboxStore({
    api: { list, mutate, mutateRecovery, submit },
    webSocket: { connect: vi.fn(), onEvent: vi.fn(() => () => undefined) },
    uuid: () => '5c642770-08ec-4b3e-9564-d88d01d08f44',
  })
  await store.start()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/inbox', component: { template: '<div />' } },
      { path: '/session/:id', component: { template: '<div />' } },
      { path: '/hosts', component: { template: '<div />' } },
    ],
  })
  await router.push('/inbox')
  await router.isReady()
  const View = (await import('../AttentionInboxView.vue')).default
  const wrapper = mount(View, { props: { store }, global: { plugins: [router] } })
  await flushPromises()
  return { wrapper, store, router, list, mutate, mutateRecovery, submit }
}

beforeEach(() => {
  mobile.value = false
  vi.clearAllMocks()
})

describe('AttentionInboxView', () => {
  test('renders risk-prioritized active rows and filters loaded kinds', async () => {
    const { wrapper } = await render()

    expect(wrapper.findAll('[data-testid="attention-row"]').map(row => row.attributes('data-item-id')))
      .toEqual(['approval-1', 'question-1'])
    await wrapper.get('[data-testid="attention-kind-question"]').trigger('click')
    expect(wrapper.findAll('[data-testid="attention-row"]').map(row => row.attributes('data-item-id')))
      .toEqual(['question-1'])
    expect(wrapper.get('[data-testid="attention-detail"]').text()).toContain('Choose rollback strategy')
    await wrapper.get('[data-testid="attention-lifecycle-snoozed"]').trigger('click')
    expect(wrapper.text()).toContain('Deferred approval')
    expect(wrapper.find('[data-action-id="once"]').exists()).toBe(false)
    await wrapper.get('[data-testid="attention-lifecycle-handled"]').trigger('click')
    expect(wrapper.text()).toContain('Handled approval')
    expect(wrapper.find('[data-action-id="once"]').exists()).toBe(false)
  })

  test('refreshes the authoritative snapshot when route scope changes', async () => {
    const { router, list } = await render()
    list.mockClear()

    await router.push({ path: '/inbox', query: { daemon_id: 'daemon-1', daemon_name: 'Mac Studio' } })
    await flushPromises()

    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      scope: { type: 'daemon', daemonId: 'daemon-1', daemonName: 'Mac Studio' },
    }))
  })

  test('selects an approval and submits only its server-provided action', async () => {
    const { wrapper, submit } = await render()

    await wrapper.get('[data-item-id="approval-1"]').trigger('click')
    expect(wrapper.get('[data-testid="attention-detail"]').text()).toContain('./deploy.sh --production')
    expect(wrapper.get('[data-testid="attention-risk-reasons"]').text()).toContain('Executes a command')
    expect(wrapper.get('[data-testid="attention-detail"]').text()).toContain('Risk classification is incomplete')
    expect(wrapper.get('[data-testid="attention-detail"]').text()).not.toContain('unknown_server_reason')
    expect(wrapper.find('[data-action-id="once"]').exists()).toBe(true)
    expect(wrapper.find('[data-action-id="always"]').exists()).toBe(false)
    await wrapper.get('[data-action-id="once"]').trigger('click')
    await flushPromises()

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'approval-1', actionId: 'once', expectedRevision: 5,
    }))
  })

  test('collects a question answer in protocol order', async () => {
    const { wrapper, submit } = await render()

    await wrapper.get('[data-item-id="question-1"]').trigger('click')
    await wrapper.get('[data-option="Blue-green"]').trigger('click')
    await wrapper.get('[data-action-id="answer"]').trigger('click')
    await flushPromises()

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'question-1', actionId: 'answer', answers: [['Blue-green']],
    }))
  })

  test('snoozes an open item and restores a snoozed item', async () => {
    const { wrapper, mutate } = await render()

    await wrapper.get('[data-item-id="approval-1"]').trigger('click')
    await wrapper.get('[data-testid="attention-snooze"]').trigger('click')
    await flushPromises()
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'approval-1', operation: 'snooze' }))

    await wrapper.get('[data-testid="attention-lifecycle-snoozed"]').trigger('click')
    await wrapper.get('[data-item-id="snoozed-1"]').trigger('click')
    await wrapper.get('[data-testid="attention-restore"]').trigger('click')
    await flushPromises()
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'snoozed-1', operation: 'restore' }))
  })

  test('shows observe mode as read-only and off mode as unavailable', async () => {
    const observe = await render('observe')
    await observe.wrapper.get('[data-item-id="approval-1"]').trigger('click')
    expect(observe.wrapper.text()).toContain('Read-only observe mode')
    expect(observe.wrapper.find('[data-action-id="once"]').exists()).toBe(false)

    const off = await render('off')
    expect(off.wrapper.find('[data-testid="attention-disabled"]').exists()).toBe(true)
  })

  test('uses a mobile list/detail flow and deep-links to the source session', async () => {
    mobile.value = true
    const { wrapper, router } = await render()

    expect(wrapper.classes()).toContain('is-mobile')
    expect(wrapper.find('[data-testid="attention-detail"]').exists()).toBe(false)
    await wrapper.get('[data-item-id="approval-1"]').trigger('click')
    expect(wrapper.find('[data-testid="attention-detail"]').exists()).toBe(true)
    await wrapper.get('[data-testid="attention-open-session"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/session/session-approval')
  })

  test('renders recovery separately and only navigates to the host or mutates metadata', async () => {
    const { wrapper, router, mutateRecovery, submit } = await render()

    await wrapper.get('[data-testid="attention-kind-recovery"]').trigger('click')
    await wrapper.get('[data-recovery-id="recovery-1"]').trigger('click')
    const detail = wrapper.get('[data-testid="attention-recovery-detail"]')
    expect(detail.text()).toContain('Mac Studio is offline')
    expect(detail.text()).toContain('does not wake or reconnect')
    expect(detail.text()).not.toContain('Reconnect')

    await detail.get('[data-testid="attention-open-host"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/hosts?daemon_id=daemon-1')

    await router.push('/inbox')
    await wrapper.get('[data-testid="attention-kind-recovery"]').trigger('click')
    await wrapper.get('[data-recovery-id="recovery-1"]').trigger('click')
    await wrapper.get('[data-testid="attention-recovery-snooze"]').trigger('click')
    await flushPromises()
    expect(mutateRecovery).toHaveBeenCalledWith(expect.objectContaining({
      recoveryId: 'recovery-1', operation: 'snooze', expectedRevision: 3,
    }))
    expect(submit).not.toHaveBeenCalled()
  })
})
