import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import MobileSessionCard from '../MobileSessionCard.vue'
import { useLocale } from '../../composables/useLocale'

enableAutoUnmount(afterEach)
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const session = {
  session_id: 'session-1234',
  title: '修复登录流程',
  status: 'running',
  source: 'terminal',
  agent: 'codex',
  model: 'gpt-5.4',
  hostname: 'Mac Studio',
  subagent_count: 2,
  pinned: true,
  children: [
    { agentId: 'child-1', kind: 'claude_subagent' },
    { agentId: 'child-2', kind: 'claude_subagent' },
  ],
}

describe('MobileSessionCard', () => {
  beforeEach(() => {
    useLocale().setLocale('zh')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  test('presents the latest iOS quiet hierarchy and trailing rail', () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session,
        effectiveStatus: 'running',
        relativeTime: '3 分钟前',
        expanded: false,
      },
    })

    expect(wrapper.get('.mobile-card-title-row').text()).toContain('修复登录流程')
    expect(wrapper.find('.mobile-source-chip').exists()).toBe(false)
    expect(wrapper.find('.mobile-card-footer').exists()).toBe(false)
    expect(wrapper.get('.mobile-card-context').text()).toContain('Codex CLI')
    expect(wrapper.get('.mobile-card-context').text()).toContain('gpt-5.4')
    expect(wrapper.get('.mobile-card-context').text()).toContain('2 子智能体')
    expect(wrapper.get('.mobile-card-trailing').text()).toContain('3 分钟前')
    expect(wrapper.find('.mobile-navigation-chevron').exists()).toBe(false)
    expect(wrapper.find('.mobile-subagent-toggle').exists()).toBe(true)
  })

  test('distinguishes Codex Desktop from Codex CLI in mobile session context', () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session: { ...session, agent: 'codex-desktop' },
        effectiveStatus: 'completed',
        relativeTime: '刚刚',
        expanded: false,
      },
    })

    expect(wrapper.get('.mobile-card-context').text()).toContain('Codex Desktop')
    expect(wrapper.get('.mobile-card-context').text()).not.toContain('Codex CLI')
  })

  test('keeps observer long-press access without offering mobile resume', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MobileSessionCard, {
      props: {
        session: { ...session, agent: 'codex-desktop', status: 'exited' },
        effectiveStatus: 'exited',
        relativeTime: '1 小时前',
        expanded: false,
      },
    })

    await wrapper.get('.mobile-session-card').trigger('pointerdown', { clientX: 10, clientY: 10 })
    vi.advanceTimersByTime(560)
    await Promise.resolve()

    expect(wrapper.emitted('long-press')?.[0]?.[0]).toMatchObject({ agent: 'codex-desktop', status: 'exited' })
    expect(wrapper.find('.mobile-resume').exists()).toBe(false)
    vi.useRealTimers()
  })

  test('uses a neutral navigation affordance when inline children are unavailable', () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session: { ...session, children: [], subagent_count: 0 },
        effectiveStatus: 'running',
        relativeTime: '刚刚',
        expanded: false,
      },
    })

    expect(wrapper.find('.mobile-subagent-toggle').exists()).toBe(false)
    expect(wrapper.find('.mobile-navigation-chevron').exists()).toBe(true)
  })

  test('long press emits long-press for the parent context sheet and suppresses open', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MobileSessionCard, {
      props: {
        session,
        effectiveStatus: 'running',
        relativeTime: '刚刚',
        expanded: false,
      },
    })

    const card = wrapper.get('.mobile-session-card')
    await card.trigger('pointerdown', { clientX: 10, clientY: 10 })
    vi.advanceTimersByTime(560)
    await Promise.resolve()
    await card.trigger('pointerup', { clientX: 10, clientY: 10 })
    await card.trigger('click')

    expect(wrapper.emitted('long-press')).toHaveLength(1)
    expect(wrapper.emitted('long-press')?.[0]?.[0]).toMatchObject({ session_id: 'session-1234' })
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
    expect(wrapper.emitted('open')).toBeUndefined()
    vi.useRealTimers()
  })

  test('cancels the long press when the pointer moves beyond the tolerance', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MobileSessionCard, {
      props: {
        session,
        effectiveStatus: 'running',
        relativeTime: '刚刚',
        expanded: false,
      },
    })

    const card = wrapper.get('.mobile-session-card')
    await card.trigger('pointerdown', { clientX: 10, clientY: 10 })
    await card.trigger('pointermove', { clientX: 30, clientY: 12 })
    vi.advanceTimersByTime(560)
    await Promise.resolve()
    await card.trigger('pointerup', { clientX: 30, clientY: 12 })

    expect(wrapper.emitted('long-press')).toBeUndefined()
    vi.useRealTimers()
  })

  test('swiping reveals contextual actions, blocks accidental navigation and closes after pinning', async () => {
    const wrapper = mount(MobileSessionCard, { props: { session, effectiveStatus:'running', relativeTime:'刚刚', expanded:false } })
    const card = wrapper.get('.mobile-session-card')
    expect(wrapper.get('.mobile-card-tray').attributes('inert')).toBeDefined()
    await card.trigger('touchstart', { touches:[{ clientX:240, clientY:100 }] })
    await card.trigger('touchmove', { touches:[{ clientX:100, clientY:103 }] })
    await card.trigger('touchend', { changedTouches:[{ clientX:100, clientY:103 }] })
    expect(wrapper.classes()).toContain('tray-open')
    expect(wrapper.get('.mobile-card-tray').attributes('inert')).toBeUndefined()
    expect(wrapper.find('.tray-delete').exists()).toBe(false)
    await card.trigger('click')
    expect(wrapper.emitted('open')).toBeUndefined()
    await wrapper.get('.tray-pin').trigger('click')
    expect(wrapper.emitted('pin')).toHaveLength(1)
    expect(wrapper.classes()).not.toContain('tray-open')
  })

  test('archive hides pin and resume, keeps more and terminal delete, and supports keyboard actions', async () => {
    const wrapper = mount(MobileSessionCard, { props: { session:{ ...session,status:'exited' }, effectiveStatus:'exited',relativeTime:'刚刚',expanded:false,archived:true } })
    expect(wrapper.find('.tray-pin').exists()).toBe(false)
    expect(wrapper.find('.mobile-resume').exists()).toBe(false)
    expect(wrapper.find('.tray-delete').exists()).toBe(true)
    await wrapper.get('.mobile-exit-card button').trigger('click')
    expect(wrapper.emitted('show-children')).toHaveLength(1)
    await wrapper.get('.mobile-session-card').trigger('keydown',{ key:'ArrowLeft' })
    expect(wrapper.classes()).toContain('tray-open')
    await wrapper.get('.tray-more').trigger('click')
    expect(wrapper.emitted('long-press')?.[0][0]).toMatchObject({ session_id: session.session_id })
  })

  test('opening a second tray closes the first one', async () => {
    const props = { session,effectiveStatus:'running',relativeTime:'刚刚',expanded:false }
    const first = mount(MobileSessionCard,{ props })
    const second = mount(MobileSessionCard,{ props:{ ...props,session:{ ...session,session_id:'second' } } })
    await first.get('.mobile-session-card').trigger('keydown',{ key:'ArrowLeft' })
    await second.get('.mobile-session-card').trigger('keydown',{ key:'ArrowLeft' })
    expect(first.classes()).not.toContain('tray-open')
    expect(second.classes()).toContain('tray-open')
  })

  test('long hold drags to a drop target instead of opening the context menu', async () => {
    vi.useFakeTimers()
    const target = document.createElement('div')
    target.dataset.projectDrop = 'project'; target.dataset.daemonDrop = 'host'
    vi.spyOn(document,'elementFromPoint').mockReturnValue(target)
    const wrapper = mount(MobileSessionCard,{ props:{session:{...session,daemon_id:'host'},effectiveStatus:'running',relativeTime:'刚刚',expanded:false,reorderable:true} })
    const card = wrapper.get('.mobile-session-card')
    await card.trigger('touchstart',{touches:[{clientX:100,clientY:150}]})
    vi.advanceTimersByTime(560)
    await card.trigger('touchmove',{touches:[{clientX:110,clientY:220}]})
    expect(wrapper.classes()).toContain('drag-placeholder')
    expect(target.classList.contains('mobile-drop-active')).toBe(true)
    await card.trigger('touchend')
    expect(wrapper.emitted('drop')?.[0][0]).toBe(target)
    expect(wrapper.emitted('long-press')).toBeUndefined()
    expect(wrapper.classes()).not.toContain('drag-placeholder')
  })

  test('opens the session from the card and expands subagents independently', async () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session,
        effectiveStatus: 'running',
        relativeTime: '3 分钟前',
        expanded: false,
      },
    })

    await wrapper.get('.mobile-session-card').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)

    await wrapper.get('.mobile-subagent-toggle').trigger('click')
    expect(wrapper.emitted('toggle-subagents')).toHaveLength(1)
    expect(wrapper.emitted('open')).toHaveLength(1)
  })

  test('uses the same accent treatment as the iOS subagent toggle', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/MobileSessionCard.vue'), 'utf8')

    expect(source).toMatch(/\.mobile-subagent-toggle::before[^}]*background:\s*var\(--accent-muted/m)
    expect(source).toMatch(/\.mobile-subagent-toggle svg[^}]*stroke:\s*var\(--accent/m)
  })

  test('counts subagents and sdk system sessions separately', () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session: {
          ...session,
          subagent_count: 5,
          children: [
            { agentId: 'sub-1', kind: 'claude_subagent' },
            { agentId: 'sub-2', kind: 'claude_subagent' },
            { agentId: 'sdk-1', kind: 'sdk_session' },
            { agentId: 'sdk-2', kind: 'sdk_session' },
            { agentId: 'sdk-3', kind: 'sdk_session' },
          ],
        },
        effectiveStatus: 'running',
        relativeTime: '刚刚',
        expanded: false,
      },
    })

    const context = wrapper.get('.mobile-card-context').text()
    expect(context).toContain('2 子智能体')
    expect(context).toContain('3 系统审查')
  })

  test('falls back to scalar subagent count when children carry no kind', () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session: { ...session, children: [{ agentId: 'child-1' }] },
        effectiveStatus: 'running',
        relativeTime: '刚刚',
        expanded: false,
      },
    })

    expect(wrapper.get('.mobile-card-context').text()).toContain('1 子智能体')
  })
})
