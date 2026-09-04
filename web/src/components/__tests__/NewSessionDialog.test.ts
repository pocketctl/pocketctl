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

  test('offers Codex CLI only and sends the codex wire value', async () => {
    const wrapper = mount(NewSessionDialog, {
      props: {
        daemons: [{ daemon_id: 'daemon-1', daemon_online: true, hostname: 'host' }],
      },
    })

    const agentButtons = wrapper.findAll('button.agent-pill')
    expect(agentButtons.map(button => button.text())).toEqual(['Claude Code', 'Codex CLI', 'OpenCode'])
    expect(wrapper.text()).not.toContain('Codex Desktop')

    await agentButtons[1].trigger('click')
    await wrapper.find('button.btn-start').trigger('click')

    const createMessages = ws.send.mock.calls
      .map(([message]) => message)
      .filter(message => message.type === 'session_create')
    expect(createMessages).toHaveLength(1)
    expect(createMessages[0].agent).toBe('codex')
    expect(createMessages.some(message => message.agent === 'codex-desktop')).toBe(false)
    wrapper.unmount()
  })

  test.each(['codex-desktop', 'zcode', 'unknown-agent'])(
    'rejects programmatic selection and forged create payload for %s',
    async (agent) => {
      const wrapper = mount(NewSessionDialog, {
        props: {
          daemons: [{ daemon_id: 'daemon-1', daemon_online: true, hostname: 'host' }],
        },
      })
      const vm = wrapper.vm as any
      ws.send.mockClear()

      vm.selectAgent(agent)
      await nextTick()
      expect(vm.form.agent).toBe('claude-code')
      expect(ws.send.mock.calls.map(([message]) => message)).not.toContainEqual(
        expect.objectContaining({ type: 'list_models', agent }),
      )

      vm.form.agent = agent
      await nextTick()
      expect(wrapper.get('button.btn-start').attributes('disabled')).toBeDefined()
      vm.startSession()

      expect(ws.send.mock.calls.map(([message]) => message.type)).not.toContain('session_create')
      wrapper.unmount()
    },
  )

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
    expect((restoredClaudePermission.element as HTMLSelectElement).value).toBe('manual')

    await wrapper.find('button.btn-start').trigger('click')
    const claudeCreateMessage = ws.send.mock.calls.map(([message]) => message)
      .find(message => message.type === 'session_create' && message.agent === 'claude-code')
    expect(JSON.parse(JSON.stringify(claudeCreateMessage))).toMatchObject({
      agent: 'claude-code',
      permission: { agent: 'claude-code', mode: 'manual' },
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
