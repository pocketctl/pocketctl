import { shallowMount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import SessionDetail from '../SessionDetail.vue'

const websocketMock = vi.hoisted(() => ({
  handlers: new Map<string, (message: any) => void>(),
  send: vi.fn((_payload: any) => true),
}))
const routeMock = vi.hoisted(() => ({ current: null as any }))

vi.mock('vue-router', () => ({
  useRoute: () => routeMock.current,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))

vi.mock('../../composables/useWebSocket', () => ({
  useWebSocket: () => ({
    connect: vi.fn(), send: websocketMock.send,
    sendUserMessage: vi.fn((payload: Record<string, unknown>) => websocketMock.send({ type: 'user_message', ...payload })),
    connected: ref(true), reconnecting: ref(false),
    onEvent: vi.fn((type: string, handler: (message: any) => void) => {
      websocketMock.handlers.set(type, handler)
      return () => websocketMock.handlers.delete(type)
    }),
  }),
}))

vi.mock('../../composables/useLocale', () => ({ useLocale: () => ({ locale: ref('en'), t: (key: string) => key }) }))
vi.mock('../../composables/useSessionRename', () => ({
  useSessionRename: () => ({
    renamingId: ref(''), renameInput: ref(''), startRename: vi.fn(), commitRename: vi.fn(), cancelRename: vi.fn(),
  }),
}))

const mounted: Array<ReturnType<typeof shallowMount>> = []
beforeEach(() => {
  routeMock.current = reactive({ params: { id: 'thr_1' }, query: {} as Record<string, string> })
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  websocketMock.handlers.clear()
  websocketMock.send.mockClear()
  vi.unstubAllGlobals()
})

function mountSession() {
  const wrapper = shallowMount(SessionDetail)
  mounted.push(wrapper)
  websocketMock.handlers.get('replay_end')?.({ type: 'replay_end', session_id: 'thr_1', req_id: 1 })
  return wrapper
}

function useMobileViewport() {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    media: '(max-width: 768px)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

function setTerminalSession(overrides: Record<string, unknown>) {
  websocketMock.handlers.get('session_list')?.({ sessions: [session(overrides)] })
  websocketMock.handlers.get('session_status')?.({ session_id: 'thr_1', status: 'completed' })
}

function session(overrides: Record<string, unknown>) {
  return {
    session_id: 'thr_1', daemon_id: 'd1', agent_type: 'codex', source: 'terminal', status: 'completed',
    daemon_online: true, cwd: '/repo', title: 'Codex',
    ...overrides,
  }
}


function latest(type:string) {return websocketMock.send.mock.calls.map(([payload])=>payload).filter(p=>p.type===type).at(-1)}
async function ready() {
 const wrapper=mountSession()
 setTerminalSession({source:'daemon',status:'idle',control_mode:'managed',capabilities:['message_acceptance_receipt']})
 await nextTick()
 const request=latest('list_invocations')
 expect(request).toBeDefined()
 websocketMock.handlers.get('invocation_result')?.({session_id:'thr_1',request_id:request.request_id,invocation:{kind:'catalog',commands:[
 {id:'skill:a',name:'review-code',kind:'skill',source:'project',display_path:'.claude/skills/review/SKILL.md',description:'Review changes'},
 {id:'skill:b',name:'review-code',kind:'skill',source:'project',display_path:'.codex/skills/review/SKILL.md',description:'Review changes'},
 {id:'command:compact',name:'compact',kind:'command',source:'codex'}]}})
 await nextTick();return wrapper
}
describe('new Codex invocation composer',()=>{
 test('selection retains arguments and native identity; only Send executes',async()=>{
  const wrapper=await ready()
  await wrapper.get('.chat-textarea').setValue('/review-code check API')
  const popover=wrapper.findComponent({name:'CommandPopover'})
  popover.vm.$emit('select',popover.props('commands')[1]);await nextTick()
  expect(latest('invoke_command')).toBeUndefined()
  expect((wrapper.get('.chat-textarea').element as HTMLTextAreaElement).value).toBe('/review-code check API')
  await wrapper.get('.send-btn').trigger('click')
  const request=latest('invoke_command');expect(request.invocation_id).toBe('skill:b')
  expect(latest('user_message')).toBeUndefined()
  websocketMock.handlers.get('invocation_result')?.({session_id:'thr_1',request_id:request.request_id,invocation:{kind:'skill',entry_id:'skill:b'}})
  await nextTick()
  expect(latest('user_message')).toMatchObject({content:'/review-code check API',invocation_id:'skill:b'})
  expect((wrapper.get('.chat-textarea').element as HTMLTextAreaElement).value).toBe('')
 })
 test('preflight failure preserves draft and an unrelated response cannot execute it',async()=>{
  const wrapper=await ready();await wrapper.get('.chat-textarea').setValue('/review-code task');await wrapper.get('.send-btn').trigger('click')
  const request=latest('invoke_command')
  websocketMock.handlers.get('invocation_result')?.({session_id:'thr_1',request_id:'other-tab',invocation:{kind:'skill',entry_id:'skill:a'}})
  expect(latest('user_message')).toBeUndefined()
  websocketMock.handlers.get('invocation_result')?.({session_id:'thr_1',request_id:request.request_id,error:'请选择具体来源'})
  await nextTick();expect(wrapper.text()).toContain('请选择具体来源')
  expect((wrapper.get('.chat-textarea').element as HTMLTextAreaElement).value).toBe('/review-code task')
 })
 test('model operations use quota-admitted user_message and restore rejected drafts',async()=>{
  const wrapper=await ready();await wrapper.get('.chat-textarea').setValue('/compact');await wrapper.get('.send-btn').trigger('click')
  const request=latest('invoke_command')
  websocketMock.handlers.get('invocation_result')?.({session_id:'thr_1',request_id:request.request_id,invocation:{kind:'turn_command',entry_id:'command:compact'}})
  await nextTick();const command=latest('user_message');expect(command.invocation_id).toBe('command:compact')
  websocketMock.handlers.get('user_message_nack')?.({msg_id:command.msg_id,reason:'quota_exceeded'})
  await nextTick();expect((wrapper.get('.chat-textarea').element as HTMLTextAreaElement).value).toBe('/compact');expect(wrapper.text()).toContain('quota_exceeded')
 })
})
