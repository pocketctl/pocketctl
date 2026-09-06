import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import MobileSessionCard from '../MobileSessionCard.vue'

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

  test('keeps observer pin/delete access without offering mobile resume', () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session: { ...session, agent: 'codex-desktop', status: 'exited' },
        effectiveStatus: 'exited',
        relativeTime: '1 小时前',
        expanded: false,
      },
    })

    expect(wrapper.find('.mobile-action-pin').exists()).toBe(true)
    expect(wrapper.find('.mobile-action-delete').exists()).toBe(true)
    expect(wrapper.find('.mobile-resume').exists()).toBe(false)
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

  test('long press copies the full session id and shows iOS feedback', async () => {
    vi.useFakeTimers()
    const wrapper = mount(MobileSessionCard, {
      props: {
        session,
        effectiveStatus: 'running',
        relativeTime: '刚刚',
        expanded: false,
      },
    })

    await wrapper.get('.mobile-session-card').trigger('pointerdown', { clientX: 10, clientY: 10 })
    vi.advanceTimersByTime(520)
    await Promise.resolve()

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('session-1234')
    expect(wrapper.get('.mobile-copy-feedback').text()).toBe('已复制会话 ID')
    vi.useRealTimers()
  })

  test('reveals iOS-style trailing pin and terminal delete actions after a left swipe', async () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session: { ...session, status: 'completed' },
        effectiveStatus: 'completed',
        relativeTime: '1 小时前',
        expanded: false,
      },
    })

    const card = wrapper.get('.mobile-session-card')
    await card.trigger('pointerdown', { clientX: 180, clientY: 20, pointerId: 1 })
    await card.trigger('pointermove', { clientX: 60, clientY: 22, pointerId: 1 })
    await card.trigger('pointerup', { clientX: 60, clientY: 22, pointerId: 1 })

    expect(wrapper.get('.mobile-card-actions').classes()).toContain('revealed')
    expect(wrapper.find('.mobile-action-delete').exists()).toBe(true)
    await wrapper.get('.mobile-action-pin').trigger('click')
    expect(wrapper.emitted('toggle-pin')?.[0]?.[0]).toMatchObject({ session_id: session.session_id, status: 'completed' })
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
