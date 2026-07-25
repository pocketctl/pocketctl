import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
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
  children: [{ agentId: 'child-1' }],
}

describe('MobileSessionCard', () => {
  test('presents the iOS three-row session summary without clipping key metadata', () => {
    const wrapper = mount(MobileSessionCard, {
      props: {
        session,
        effectiveStatus: 'running',
        relativeTime: '3 分钟前',
        expanded: false,
      },
    })

    expect(wrapper.get('.mobile-card-title-row').text()).toContain('修复登录流程')
    expect(wrapper.get('.mobile-source-chip').text()).toBe('终端')
    expect(wrapper.get('.mobile-card-meta-row').text()).toContain('Codex')
    expect(wrapper.get('.mobile-card-meta-row').text()).toContain('gpt-5.4')
    expect(wrapper.get('.mobile-card-meta-row').text()).toContain('2 子智能体')
    expect(wrapper.get('.mobile-card-footer').text()).toContain('Mac Studio')
    expect(wrapper.get('.mobile-card-footer').text()).toContain('3 分钟前')
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
})
