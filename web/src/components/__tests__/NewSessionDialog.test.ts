import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import NewSessionDialog from '../NewSessionDialog.vue'

const quota = vi.hoisted(() => ({ value: undefined as any, current: undefined as any, api: vi.fn(async () => ({ ok: false, data: null as any })) }))
vi.mock('../../composables/useAuth', () => ({ useAuth: () => ({ apiGetAuth: quota.api }) }))

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
    useQuota: () => {
      quota.current = ref(quota.value)
      return {
      concurrentSessions: quota.current,
      applyQuotaPayload: (data: any) => { quota.current.value = data.quota.resources.concurrent_sessions },
      quotaReached: () => !!quota.current.value && quota.current.value.limit !== null && quota.current.value.used + (quota.current.value.reserved || 0) >= quota.current.value.limit,
    } },
  }
})

const routerPush = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: routerPush }),
}))

describe('NewSessionDialog permission serialization', () => {
  beforeEach(() => {
    quota.value = undefined
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
      daemon_id: 'daemon-1', agent: 'opencode',
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

test('host and agent model replies cannot cross tabs; host-scoped cwd and offline creation', async () => {
 localStorage.clear();ws.handlers.clear();ws.send.mockClear()
 const hosts=[{daemon_id:'d1',daemon_online:true},{daemon_id:'d2',daemon_online:true}]
 const w=mount(NewSessionDialog,{props:{daemons:hosts,preSelectedDaemonId:'d1'}})
 const vm=w.vm as any
 ws.handlers.get('model_list')?.({daemon_id:'d2',agent:'claude-code',models:[{alias:'wrong',name:'Wrong'}]})
 await nextTick();expect(w.text()).not.toContain('Wrong')
 vm.form.cwd='/home/one';vm.startSession()
 expect(localStorage.getItem('pocketctl_cwd:d1:claude-code')).toBe('/home/one')
 ws.handlers.get('session_create_failed')?.({reason:'start_fail'});await nextTick()
 vm.selectHost(hosts[1]);await nextTick();expect(vm.form.cwd).toBe('~/');expect(vm.form.model).toBe('')
 await w.setProps({daemons:[hosts[0],{...hosts[1],daemon_online:false}]})
 expect(w.get('button.btn-start').attributes('disabled')).toBeDefined();w.unmount()
})


test.each([
  [{ used: 1, reserved: 1, limit: 3, over_limit: false }, '2/3', false],
  [{ used: 2, reserved: 1, limit: 3, over_limit: false }, '3/3', true],
  [{ used: 4, reserved: 2, limit: null, over_limit: false }, '6/∞', false],
])('preserves concurrent quota outside the scrolling form: %j', async (value, count, reached) => {
  quota.value = value
  const w = mount(NewSessionDialog, { props: { daemons: [{ daemon_id: 'quota-host', daemon_online: true }] } })
  const banner = w.get('.quota-banner')
  expect(banner.get('strong').text()).toBe(count)
  expect(banner.text().includes('quota.session_reached_hint')).toBe(reached)
  expect(banner.element.closest('.modal-body')).toBeNull()
  expect(banner.element.closest('.modal-dialog')).not.toBeNull()
  if (reached) {
    ws.send.mockClear()
    await w.get('button.btn-start').trigger('click')
    expect(ws.send.mock.calls.some(([m]) => m.type === 'session_create')).toBe(false)
  }
  w.unmount(); quota.value = undefined
})


test('fetches quota when opening a fresh dialog instead of hiding an empty banner', async () => {
  quota.value = undefined
  quota.api.mockResolvedValueOnce({ ok: true, data: { quota: { resources: {
    bound_hosts: { used: 1, limit: 2 }, concurrent_sessions: { used: 1, reserved: 1, limit: 4, over_limit: false },
  } } } })
  const w = mount(NewSessionDialog, { props: { daemons: [] } })
  expect(w.find('.quota-banner').exists()).toBe(true)
  await flushPromises()
  expect(quota.api).toHaveBeenCalledWith('/api/user/profile')
  expect(w.get('.quota-banner strong').text()).toBe('2/4')
  w.unmount()
})
test('shows an unavailable state and retry when quota cannot be loaded', async () => {
  quota.value = undefined
  const w = mount(NewSessionDialog, { props: { daemons: [] } })
  await flushPromises()
  expect(w.get('.quota-banner').text()).toContain('quota.load_failed')
  expect(w.find('.quota-banner strong').exists()).toBe(false)
  expect(w.find('.quota-retry').exists()).toBe(true)
  w.unmount()
})
