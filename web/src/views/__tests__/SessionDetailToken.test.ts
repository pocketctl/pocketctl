import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolCallCard from '../../components/messages/ToolCallCard.vue'

describe('ToolCallCard tokenUsage (P1a)', () => {
  test('renders subagent accumulated token when tokenUsage prop is provided', () => {
    const w = mount(ToolCallCard, {
      props: {
        message: { id: 'sa1', type: 'subagent', tool: 'a1', input: 'desc', status: 'completed', expanded: true, outputExpanded: false },
        tokenUsage: { tokenIn: 100, tokenOut: 200, tokenCache: 50, tokenCacheCreate: 30 },
      },
      global: { stubs: { AgentBadge: true, ToolIcon: true, MarkdownRenderer: true } },
    })
    expect(w.html()).toMatch(/100/)
    expect(w.html()).toMatch(/200/)
    expect(w.html()).toMatch(/50/)
    expect(w.html()).toMatch(/30/)  // tokenCacheCreate
  })

  test('does not render token block when tokenUsage is absent (tool_call unaffected)', () => {
    const w = mount(ToolCallCard, {
      props: { message: { id: 'tc1', type: 'tool_call', tool: 'Bash', input: 'ls', status: 'completed', expanded: true, outputExpanded: false } },
      global: { stubs: { AgentBadge: true, ToolIcon: true, MarkdownRenderer: true } },
    })
    expect(w.html()).not.toMatch(/tcc-tokens/)
  })

  test('does not render token block when message type is subagent but tokenUsage is undefined', () => {
    const w = mount(ToolCallCard, {
      props: { message: { id: 'sa2', type: 'subagent', tool: 'a2', input: 'desc', status: 'completed', expanded: true, outputExpanded: false } },
      global: { stubs: { AgentBadge: true, ToolIcon: true, MarkdownRenderer: true } },
    })
    expect(w.html()).not.toMatch(/tcc-tokens/)
  })
})
