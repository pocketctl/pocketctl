import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import SessionPromptAnchor from '../SessionPromptAnchor.vue'
import { latestSentPrompt, promptSummary } from '../../../utils/sessionPrompt'

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks() })

function fixture(bottom = 90) {
  const container = document.createElement('div')
  const source = document.createElement('article')
  source.dataset.userMessageId = 'question'
  source.tabIndex = -1
  source.textContent = 'Original question'
  container.append(source); document.body.append(container)
  Object.defineProperty(container, 'clientHeight', { value: 500 })
  container.getBoundingClientRect = () => new DOMRect(0, 100, 600, 500)
  let edge = bottom
  source.getBoundingClientRect = () => new DOMRect(0, edge - 60, 450, 60)
  container.scrollTop = 600
  container.scrollTo = vi.fn(({ top }: any) => { container.scrollTop = top; edge = 172; container.dispatchEvent(new Event('scroll')) })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return { container, source, setBottom: (value: number) => { edge = value; container.dispatchEvent(new Event('scroll')) } }
}

describe('latest prompt reading', () => {
  test('never substitutes pending, failed or tool messages for the accepted user message', () => {
    const messages = [
      { id: 'old', role: 'user', type: 'user_text', content: 'accepted' },
      ...['pending', 'forwarded', 'unknown', 'failed'].map(deliveryStatus => ({ id: deliveryStatus, role: 'user', type: 'user_text', content: deliveryStatus, deliveryStatus })),
      { id: 'tool', role: 'agent', type: 'tool_call', content: 'tool input' },
    ]
    expect(latestSentPrompt(messages)).toEqual({ id: 'old', text: 'accepted' })
    messages.push({ id: 'new', role: 'user', type: 'user_text', content: 'next', deliveryStatus: 'accepted' })
    expect(latestSentPrompt(messages)?.id).toBe('new')
    expect(latestSentPrompt([])).toBeNull()
  })
  test('projects paragraphs, code and image labels without displaying markdown delimiters', () => {
    expect(promptSummary('## **Check** [this](https://example.com)\n\n`x < 2`\n\n![screen](demo.png)')).toBe('Check this x < 2 screen')
  })
  test('shows only once the whole prompt passes the top, never for a prompt below the viewport', async () => {
    const f = fixture(110)
    const wrapper = mount(SessionPromptAnchor, { props: { container: f.container, message: { id: 'question', text: 'Original question' }, context: 'one' } })
    await flushPromises()
    expect(wrapper.find('button').exists()).toBe(false)
    f.setBottom(97); await flushPromises()
    expect(wrapper.find('button').exists()).toBe(true)
    expect(wrapper.get('button').attributes('aria-label')).toContain('Original question')
    f.setBottom(800); await flushPromises()
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })
  test('returns to the exact message, gives it focus, and clears the bar and highlight on context change', async () => {
    const f = fixture()
    const wrapper = mount(SessionPromptAnchor, { attachTo: document.body, props: { container: f.container, message: { id: 'question', text: 'Original question' }, context: 'one' } })
    await flushPromises()
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(wrapper.emitted('navigate')).toHaveLength(1)
    expect(f.container.scrollTop).toBe(518)
    expect(document.activeElement).toBe(f.source)
    expect(f.source.classList.contains('prompt-return-highlight')).toBe(true)
    expect(wrapper.find('button').exists()).toBe(false)
    await wrapper.setProps({ context: 'two', message: null })
    expect(f.source.classList.contains('prompt-return-highlight')).toBe(false)
    wrapper.unmount()
  })
  test('missing DOM does not imply that the message is above the viewport', async () => {
    const f = fixture()
    const wrapper = mount(SessionPromptAnchor, { props: { container: f.container, message: { id: 'absent', text: 'not mounted' }, context: 'one' } })
    await flushPromises()
    expect(wrapper.find('button').exists()).toBe(false)
    wrapper.unmount()
  })
})
