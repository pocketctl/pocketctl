import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import NewSessionDialog from '../NewSessionDialog.vue'

const ws = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn(),
  handlers: new Map<string, (message: any) => void>(),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: ws.connect,
    send: ws.send,
    onEvent: (type: string, handler: (message: any) => void) => {
      ws.handlers.set(type, handler)
      return () => ws.handlers.delete(type)
    },
  }),
}))

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

vi.mock('../../composables/useQuota', async () => {
  const { ref } = await import('vue')
  return {
    useQuota: () => ({
      concurrentSessions: ref(undefined),
      quotaReached: () => false,
    }),
  }
})

const routerPush = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}))

describe('NewSessionDialog permission serialization', () => {
  beforeEach(() => {
    localStorage.clear()
    ws.send.mockClear()
    ws.connect.mockClear()
    ws.handlers.clear()
    routerPush.mockClear()
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
  })

  afterEach(() => vi.unstubAllGlobals())

  test('omits permission after switching from Claude to OpenCode', async () => {
    const wrapper = mount(NewSessionDialog, {
      props: {
        daemons: [{ daemon_id: 'daemon-1', daemon_online: true, hostname: 'host' }],
      },
    })

    const permission = wrapper.find('select.input-field')
    await permission.setValue('plan')

    const agentButtons = wrapper.findAll('button.agent-pill')
    await agentButtons[2].trigger('click')
    expect(wrapper.find('select.input-field').exists()).toBe(false)

    await agentButtons[0].trigger('click')
    const restoredClaudePermission = wrapper.find('select.input-field')
    expect(restoredClaudePermission.element).toBeInstanceOf(HTMLSelectElement)
    expect((restoredClaudePermission.element as HTMLSelectElement).value).toBe('acceptEdits')

    await wrapper.find('button.btn-start').trigger('click')
    const claudeCreateMessage = ws.send.mock.calls.map(([message]) => message)
      .find(message => message.type === 'session_create' && message.agent === 'claude-code')
    expect(JSON.parse(JSON.stringify(claudeCreateMessage))).toMatchObject({
      agent: 'claude-code',
      permission: { agent: 'claude-code', mode: 'acceptEdits' },
    })

    ws.handlers.get('session_create_failed')?.({ request_id: 'request-1', reason: 'start_fail' })
    await nextTick()

    await agentButtons[2].trigger('click')
    ws.handlers.get('model_list')?.({
      models: [{ alias: 'opencode/deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' }],
    })
    await nextTick()
    await wrapper.find('select.model-select').setValue('opencode/deepseek-v4-flash-free')
    await wrapper.find('button.btn-start').trigger('click')

    const opencodeCreateMessage = ws.send.mock.calls.map(([message]) => message)
      .find(message => message.type === 'session_create' && message.agent === 'opencode')
    expect(opencodeCreateMessage).toBeDefined()
    expect(JSON.parse(JSON.stringify(opencodeCreateMessage))).not.toHaveProperty('permission')
    expect(opencodeCreateMessage.model).toBe('opencode/deepseek-v4-flash-free')

    wrapper.unmount()
  })
})
