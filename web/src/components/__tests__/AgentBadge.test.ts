import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentBadge from '../AgentBadge.vue'

describe('AgentBadge', () => {
  test('zcode renders ZCode label and kind, not Claude fallback', () => {
    const w = mount(AgentBadge, { props: { agent: 'zcode' } })
    expect(w.text()).toContain('ZCode')
    expect(w.find('.agent-badge.zcode').exists()).toBe(true)
    expect(w.find('.agent-badge.claude').exists()).toBe(false)
  })

  test('unknown agent keeps pre-change Claude fallback (no generic kind)', () => {
    const w = mount(AgentBadge, { props: { agent: 'something-unknown' } })
    expect(w.find('.agent-badge.claude').exists()).toBe(true)
    expect(w.find('.agent-badge.zcode').exists()).toBe(false)
  })

  test('existing agents unchanged', () => {
    for (const { agent, kind } of [
      { agent: 'claude-code', kind: 'claude' },
      { agent: 'codex', kind: 'codex' },
      { agent: 'opencode', kind: 'opencode' },
    ] as const) {
      const w = mount(AgentBadge, { props: { agent } })
      expect(w.find(`.agent-badge.${kind}`).exists()).toBe(true)
    }
  })
})
