import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import FileChangeBottomSheet from '../FileChangeBottomSheet.vue'
import type { AgentFileChangeMessage } from '../../../utils/agentFileChange'

const message: AgentFileChangeMessage = {
  id: 'agent-file-change:ses:turn', type: 'agent_file_change', role: 'agent',
  fileChange: {
    turnId: 'turn', additions: 1, deletions: 0, selectedPath: 'mobile.txt',
    files: [{
      path: 'mobile.txt', kind: 'create', additions: 1, deletions: 0,
      edits: [{ id: 'one', changeSetId: 'set', sequence: 1, changeIndex: 0, diff: '@@ -0,0 +1 @@\n+mobile\n', additions: 1, deletions: 0, integrity: 'complete' }],
    }],
  },
}

describe('FileChangeBottomSheet', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion'), media: query,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })))
  })
  afterEach(() => vi.unstubAllGlobals())

  test('closes from the close control', async () => {
    const wrapper = mount(FileChangeBottomSheet, { global: { stubs: { Teleport: true } }, props: { message } })
    await wrapper.get('[data-testid="file-change-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  test('closes on Escape and restores focus to the opening card', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const wrapper = mount(FileChangeBottomSheet, { global: { stubs: { Teleport: true } }, props: { message, returnFocusTo: opener }, attachTo: document.body })
    await wrapper.vm.$nextTick()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="file-change-close"]').element)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  test('closes after a downward drag within an action list', async () => {
    const wrapper = mount(FileChangeBottomSheet, { global: { stubs: { Teleport: true } }, props: { message } })
    const grabber = wrapper.get('[data-testid="file-change-grabber"]')
    await grabber.trigger('pointerdown', { clientY: 100 })
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 190 }))

    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.find('[aria-modal]').exists()).toBe(false)
    expect(wrapper.find('.workspace-action-list').exists()).toBe(true)
    expect(wrapper.get('[data-testid="file-change-sheet"]').classes()).toContain('reduced-motion')
  })
})
