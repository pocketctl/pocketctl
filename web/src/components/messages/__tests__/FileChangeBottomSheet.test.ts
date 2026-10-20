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

  test('has one title and close control and restores focus through the action list', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const wrapper = mount(FileChangeBottomSheet, { global: { stubs: { Teleport: true } }, props: { message, returnFocusTo: opener }, attachTo: document.body })
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.workspace-action-list > header, .file-change-sheet-header')).toHaveLength(1)
    const close = wrapper.get('.workspace-action-list > header button')
    expect(document.activeElement).toBe(close.element)
    await close.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    await close.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
    expect(wrapper.find('[data-testid="file-change-grabber"]').exists()).toBe(false)
    wrapper.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
