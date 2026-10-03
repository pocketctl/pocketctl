import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import NewSessionDialog from '../NewSessionDialog.vue'

const mobile = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../composables/useResponsiveLayout', () => ({ useResponsiveLayout: () => ({ isMobile: { value: mobile.enabled } }) }))

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
  test('disables forbidden permissions and keeps default-model effort options scoped to host capabilities', async () => {
    const wrapper=mount(NewSessionDialog,{props:{daemons:[{daemon_id:'daemon-1',daemon_online:true}]}})
    await wrapper.findAll('button.agent-pill')[1].trigger('click')
    ws.handlers.get('codex_home_list')?.({daemon_id:'daemon-1',codex_homes:[{id:'primary',label:'Primary'}]})
    await nextTick()
    ws.handlers.get('model_list')?.({daemon_id:'daemon-1',agent:'codex',models:[{alias:'default',name:'Default',supported_reasoning_efforts:['high']}],creation_capabilities:{version:1,supported:true,managed_runtime:true,default_model:'default',permission_presets:['request_approval','custom'],approval_policies:['on-request'],sandbox_modes:['read-only','workspace-write']}})
    await nextTick()
    expect(wrapper.get('.permission-field option[value="full_access"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.codex-effort-field select').findAll('option').map(option=>option.attributes('value'))).toEqual(['','high'])
    await wrapper.get('.permission-field select').setValue('custom')
    expect(wrapper.get('.permission-custom-grid select').findAll('option').map(option=>option.attributes('value'))).toEqual(['on-request'])
    ws.handlers.get('model_list')?.({daemon_id:'daemon-1',agent:'codex',models:[],creation_capabilities:{version:1,supported:false,managed_runtime:false,permission_presets:[],approval_policies:[],sandbox_modes:[]}})
    await nextTick()
    expect(wrapper.get('.btn-start').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  test('uses host model effort capabilities and sends the selected effort with native permissions', async () => {
    const wrapper = mount(NewSessionDialog, { props: { daemons: [{ daemon_id:'daemon-1', daemon_online:true, hostname:'host' }] } })
    await wrapper.findAll('button.agent-pill')[1].trigger('click')
    ws.handlers.get('codex_home_list')?.({ daemon_id:'daemon-1',codex_homes:[{id:'primary',label:'primary',primary:true}] })
    await nextTick()
    ws.handlers.get('model_list')?.({daemon_id:'daemon-1',agent:'codex',models:[
      {alias:'reasoning',name:'Reasoning model',supported_reasoning_efforts:['low','high'],default_reasoning_effort:'low'},
      {alias:'limited',name:'Limited model',supported_reasoning_efforts:['low']},
    ]})
    await nextTick()
    await wrapper.get('.model-field select').setValue('reasoning')
    expect(wrapper.get('button.agent-pill[aria-pressed="true"]').text()).toBe('Codex CLI')
    expect(wrapper.get('.codex-effort-field select').findAll('option').map(option=>option.attributes('value'))).toEqual(['','low','high'])
    await wrapper.get('.codex-effort-field select').setValue('high')
    await wrapper.get('.btn-start').trigger('click')
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({type:'session_create',agent:'codex',model:'reasoning',effort:'high',codex_home_id:'primary',permission:expect.objectContaining({agent:'codex'})}))
    wrapper.unmount()
  })

  test('clears effort when switching to a model with different capabilities', async () => {
    const wrapper = mount(NewSessionDialog, { props: { daemons:[{daemon_id:'daemon-1',daemon_online:true}] } })
    await wrapper.findAll('button.agent-pill')[1].trigger('click')
    ws.handlers.get('codex_home_list')?.({daemon_id:'daemon-1',codex_homes:[{id:'primary',label:'primary',primary:true}]})
    await nextTick()
    ws.handlers.get('model_list')?.({daemon_id:'daemon-1',agent:'codex',models:[{alias:'a',name:'A',supported_reasoning_efforts:['high']},{alias:'b',name:'B',supported_reasoning_efforts:['low']}]})
    await nextTick()
    await wrapper.get('.model-field select').setValue('a')
    await wrapper.get('.codex-effort-field select').setValue('high')
    await wrapper.get('.model-field select').setValue('b')
    expect((wrapper.get('.codex-effort-field select').element as HTMLSelectElement).value).toBe('')
    expect(wrapper.get('.codex-effort-field select').findAll('option').map(option=>option.attributes('value'))).toEqual(['','low'])
    wrapper.unmount()
  })
  beforeEach(() => {
    mobile.enabled = false
    quota.value = undefined
    localStorage.clear()
    ws.send.mockClear()
    ws.connect.mockClear()
    ws.handlers.clear()
    routerPush.mockClear()
    vi.stubGlobal('crypto', { randomUUID: () => 'request-1' })
  })

  afterEach(() => vi.unstubAllGlobals())

  test('mobile project selection is included in the existing create command', async () => {
    mobile.enabled = true
    const wrapper = mount(NewSessionDialog, { props: {
      daemons: [{daemon_id:'mobile-host',daemon_online:true}], projectId:'project-one',
      projects:[{id:'project-one',name:'One'},{id:'project-two',name:'Two'}],
    } })
    await flushPromises()
    expect((wrapper.get('.mobile-create-project select').element as HTMLSelectElement).value).toBe('project-one')
    await wrapper.get('.mobile-create-project select').setValue('project-two')
    await wrapper.get('.btn-start').trigger('click')
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({type:'session_create',daemon_id:'mobile-host',project_id:'project-two'}))
    wrapper.unmount()
  })

  test('offers Codex CLI only and sends the codex wire value', async () => {
    const wrapper = mount(NewSessionDialog, {
      props: {
        daemons: [{ daemon_id: 'daemon-1', daemon_online: true, hostname: 'host' }],
      },
    })

    const agentButtons = wrapper.findAll('button.agent-pill')
    expect(agentButtons.map(button => button.text())).toEqual(['Claude Code', 'Codex CLI', 'OpenCode', 'ZCode Runtime'])
    expect(wrapper.text()).not.toContain('Codex Desktop')

    await agentButtons[1].trigger('click')
    const homeRequest = ws.send.mock.calls.map(([message]) => message)
      .find(message => message.type === 'list_codex_homes')
    expect(homeRequest).toBeTruthy()
    ws.handlers.get('codex_home_list')?.({
      type: 'codex_home_list', daemon_id: 'daemon-1', request_id: homeRequest!.request_id,
      codex_homes: [
        { id: 'codex-home-primary', label: '~/.codex', primary: true },
        { id: 'codex-home-a', label: '~/.codex-a' },
      ],
    })
    await nextTick()
    expect(wrapper.find('select.input-field').exists()).toBe(true)
    await wrapper.find('button.btn-start').trigger('click')

    const createMessages = ws.send.mock.calls
      .map(([message]) => message)
      .filter(message => message.type === 'session_create')
    expect(createMessages).toHaveLength(1)
    expect(createMessages[0].agent).toBe('codex')
    expect(createMessages[0].codex_home_id).toBe('codex-home-primary')
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

  test('creates managed ZCode with its dedicated wire identity and no forged permission', async () => {
    const wrapper = mount(NewSessionDialog, {
      props: { daemons: [{ daemon_id: 'daemon-1', daemon_online: true, hostname: 'host' }] },
    })
    const zcode = wrapper.findAll('button.agent-pill').find(button => button.text() === 'ZCode Runtime')
    expect(zcode).toBeDefined()
    await zcode!.trigger('click')
    expect((wrapper.vm as any).form.agent).toBe('zcode-managed')
    expect(wrapper.find('.permission-field').exists()).toBe(false)
    await wrapper.find('button.btn-start').trigger('click')
    const create = ws.send.mock.calls.map(([message]) => message)
      .find(message => message.type === 'session_create' && message.agent === 'zcode-managed')
    expect(create).toBeDefined()
    expect(JSON.parse(JSON.stringify(create))).not.toHaveProperty('permission')
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
