import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { nextTick } from 'vue'
import FileChangeCard from '../FileChangeCard.vue'
import type { AgentFileChangeMessage, FileChangeIntegrity } from '../../../utils/agentFileChange'

let mobile = false

function installMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('max-width') ? mobile : query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
}

function diff(lines: number) {
  return `--- a/a.txt\n+++ b/a.txt\n@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => ` line ${i + 1}`).join('\n')}\n`
}

function message(integrity: FileChangeIntegrity = 'complete'): AgentFileChangeMessage {
  return {
    id: 'agent-file-change:ses:turn', type: 'agent_file_change', role: 'agent',
    fileChange: {
      turnId: 'turn', additions: 3, deletions: 1, selectedPath: 'a.txt',
      files: [
        {
          path: 'a.txt', kind: 'update', additions: 2, deletions: 1,
          edits: [{ id: 'a1', changeSetId: 'set-1', sequence: 1, changeIndex: 0, diff: diff(420), additions: 2, deletions: 1, integrity }],
        },
        {
          path: 'b.txt', kind: 'create', additions: 1, deletions: 0,
          edits: [{ id: 'b1', changeSetId: 'set-1', sequence: 2, changeIndex: 1, diff: '@@ -0,0 +1 @@\n+only b\n', additions: 1, deletions: 0, integrity: 'complete' }],
        },
      ],
    },
  }
}

describe('FileChangeCard', () => {
  beforeEach(() => {
    mobile = false
    installMatchMedia()
  })

  test('starts collapsed with an accessible two-file summary and expands from keyboard', async () => {
    const wrapper = mount(FileChangeCard, { props: { message: message() } })
    const trigger = wrapper.get('[data-testid="file-change-trigger"]')

    expect(trigger.text()).toContain('Edited 2 files')
    expect(trigger.text()).toContain('+3')
    expect(trigger.text()).toContain('-1')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(trigger.attributes('aria-controls')).toBe('file-change-detail-agent-file-change-ses-turn')
    expect(wrapper.get('.file-change-card').classes()).not.toContain('expanded')

    await trigger.trigger('keydown', { key: 'Enter' })
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.file-change-card').classes()).toContain('expanded')
    expect(wrapper.get('[data-testid="selected-file-path"]').text()).toBe('a.txt')

    await trigger.trigger('keydown', { key: ' ' })
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('.file-change-card').classes()).not.toContain('expanded')
  })

  test('switches only the selected detail and progressively renders rows in windows of 200', async () => {
    const wrapper = mount(FileChangeCard, { props: { message: message() } })
    await wrapper.get('[data-testid="file-change-trigger"]').trigger('click')

    expect(wrapper.findAll('[data-testid="diff-row"]')).toHaveLength(200)
    await wrapper.get('[data-testid="load-more"]').trigger('click')
    expect(wrapper.findAll('[data-testid="diff-row"]')).toHaveLength(400)

    await wrapper.get('[data-file-path="b.txt"]').trigger('click')
    expect(wrapper.get('[data-testid="selected-file-path"]').text()).toBe('b.txt')
    expect(wrapper.text()).toContain('only b')
    expect(wrapper.text()).not.toContain('line 420')
  })

  test('loads the next row window when the code viewport reaches the bottom', async () => {
    const wrapper = mount(FileChangeCard, { props: { message: message() } })
    await wrapper.get('[data-testid="file-change-trigger"]').trigger('click')
    const code = wrapper.get('[data-testid="file-change-code-scroll"]')
    Object.defineProperties(code.element, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    })
    ;(code.element as HTMLElement).scrollTop = 400
    await code.trigger('scroll')
    expect(wrapper.findAll('[data-testid="diff-row"]')).toHaveLength(400)
  })

  test('exposes the active patch history entry to assistive technology', async () => {
    const history = message()
    history.fileChange.files[0].edits.push({
      id: 'a2', changeSetId: 'set-2', sequence: 3, changeIndex: 0,
      diff: '@@ -1 +1 @@\n-old\n+newer\n', additions: 1, deletions: 1, integrity: 'complete',
    })
    const wrapper = mount(FileChangeCard, { props: { message: history } })
    await wrapper.get('[data-testid="file-change-trigger"]').trigger('click')
    const edits = wrapper.findAll('.file-change-edits button')

    expect(edits[0].attributes('aria-pressed')).toBe('true')
    expect(edits[1].attributes('aria-pressed')).toBe('false')
    await edits[1].trigger('click')
    expect(edits[0].attributes('aria-pressed')).toBe('false')
    expect(edits[1].attributes('aria-pressed')).toBe('true')
  })

  test('preserves selected path and per-file scroll offsets across prop updates', async () => {
    const wrapper = mount(FileChangeCard, { props: { message: message() }, attachTo: document.body })
    await wrapper.get('[data-testid="file-change-trigger"]').trigger('click')
    const scroll = () => wrapper.get('[data-testid="file-change-code-scroll"]').element as HTMLElement
    scroll().scrollTop = 91
    await wrapper.get('[data-file-path="b.txt"]').trigger('click')
    scroll().scrollTop = 37
    await wrapper.setProps({ message: { ...message(), fileChange: { ...message().fileChange, additions: 4 } } })

    expect(wrapper.get('[data-testid="selected-file-path"]').text()).toBe('b.txt')
    expect(scroll().scrollTop).toBe(37)
    await wrapper.get('[data-file-path="a.txt"]').trigger('click')
    await nextTick()
    expect(scroll().scrollTop).toBe(91)
    wrapper.unmount()
  })

  test.each([
    ['streaming', 'Loading…'],
    ['verifying', 'Verifying…'],
    ['truncated', 'Truncated preview'],
    ['failed', 'Integrity check failed'],
  ] as const)('renders an explicit %s integrity state', async (integrity, label) => {
    const wrapper = mount(FileChangeCard, { props: { message: message(integrity) } })
    await wrapper.get('[data-testid="file-change-trigger"]').trigger('click')
    expect(wrapper.text()).toContain(label)
  })

  test('renders an explicit empty diff state', async () => {
    const empty = message()
    empty.fileChange.files[0].edits[0].diff = ''
    const wrapper = mount(FileChangeCard, { props: { message: empty } })
    await wrapper.get('[data-testid="file-change-trigger"]').trigger('click')
    expect(wrapper.text()).toContain('Diff unavailable')
  })

  test('emits a mobile open request without expanding inline', async () => {
    mobile = true
    installMatchMedia()
    const wrapper = mount(FileChangeCard, { props: { message: message() } })
    const trigger = wrapper.get('[data-testid="file-change-trigger"]')
    await trigger.trigger('click')

    expect(wrapper.emitted('open-mobile')).toHaveLength(1)
    expect(wrapper.find('[data-testid="file-change-detail"]').exists()).toBe(false)
    expect(trigger.attributes('aria-haspopup')).toBe('dialog')
    expect(trigger.attributes('aria-expanded')).toBeUndefined()
    expect(trigger.attributes('aria-controls')).toBe('file-change-mobile-sheet')
  })
})
