import { afterEach, describe, expect, test, vi } from 'vitest'
import { MOBILE_TOOL_VISIBILITY_KEY, readMobileToolVisibility, saveMobileToolVisibility, showsMobileMessage } from './mobileToolVisibility'

afterEach(() => { vi.restoreAllMocks(); localStorage.removeItem(MOBILE_TOOL_VISIBILITY_KEY) })
describe('mobile tool visibility', () => {
  test('defaults off, persists a separate mobile preference, and tolerates blocked storage', () => {
    expect(readMobileToolVisibility()).toBe(false)
    saveMobileToolVisibility(true)
    expect(readMobileToolVisibility()).toBe(true)
    saveMobileToolVisibility(false)
    expect(readMobileToolVisibility()).toBe(false)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(readMobileToolVisibility()).toBe(false)
    expect(() => saveMobileToolVisibility(true)).not.toThrow()
  })
  test('keeps questions, approvals, errors and text while filtering tools and diffs', () => {
    for (const tool of ['Bash', 'Read', 'Edit', 'Write']) {
      expect(showsMobileMessage({ type: 'tool_call', tool }, false)).toBe(false)
      expect(showsMobileMessage({ type: 'tool_call', tool }, true)).toBe(true)
    }
    expect(showsMobileMessage({ type: 'tool_call', tool: 'AskUserQuestion' }, false)).toBe(true)
    for (const type of ['agent_text', 'approval_request', 'question_request', 'mcp_elicitation_request', 'interactive_prompt', 'error', 'agent_file_change']) {
      expect(showsMobileMessage({ type }, false)).toBe(true)
    }
  })
})
