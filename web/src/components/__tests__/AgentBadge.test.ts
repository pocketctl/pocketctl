import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentBadge from '../AgentBadge.vue'

describe('AgentBadge', () => {
  test('desktop observer and managed runtime render distinct ZCode badges', () => {
    const desktop = mount(AgentBadge, { props: { agent: 'zcode' } })
    const runtime = mount(AgentBadge, { props: { agent: 'zcode-managed' } })

    expect(desktop.text()).toBe('ZCode Desktop')
    expect(desktop.find('.agent-badge.zcode').exists()).toBe(true)
    expect(desktop.find('.agent-badge.claude').exists()).toBe(false)
    expect(runtime.text()).toBe('ZCode Runtime')
    expect(runtime.find('.agent-badge.zcode-managed').exists()).toBe(true)
    expect(runtime.find('.agent-badge.zcode').exists()).toBe(false)
  })

  test('Codex Desktop renders a distinguishable desktop badge in the Codex family', () => {
    const w = mount(AgentBadge, { props: { agent: 'codex-desktop' } })
    expect(w.text()).toContain('Codex Desktop')
    expect(w.find('.agent-badge.codex-desktop').exists()).toBe(true)
    expect(w.find('[data-agent-icon="codex-desktop"]').exists()).toBe(true)
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
