import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'

import SessionDocumentShelf from '../SessionDocumentShelf.vue'

const available = {
  documentId: 'doc-1', versionId: 'ver-1', displayName: 'notes.md', format: 'markdown' as const,
  state: 'available' as const, reason: null, byteSize: 2048, sha256: 'a'.repeat(64),
  sourceTurnId: 'turn-1', sourceEventId: 'event-1', capturedAt: 'now', committedAt: 'now',
}

describe('SessionDocumentShelf', () => {
  test('renders accessible available and unavailable rows and emits the full metadata identity', async () => {
    const unavailable = { ...available, documentId: 'doc-2', versionId: 'ver-2', displayName: 'large.html', format: 'html' as const, state: 'unavailable' as const, reason: 'too_large' }
    const wrapper = mount(SessionDocumentShelf, {
      props: { documents: [available, unavailable], listStatus: 'ready' },
    })
    const rows = wrapper.findAll('button.session-document-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].attributes('aria-label')).toContain('notes.md')
    expect(wrapper.text()).toContain('2.0 KB')
    await rows[1].trigger('click')
    expect(wrapper.emitted('open')?.[0]?.[0]).toEqual(unavailable)
    expect(wrapper.emitted('open')?.[0]?.[1]).toBe(rows[1].element)
  })

  test('uses the compact grouped-list structure and exposes offline status', () => {
    const wrapper = mount(SessionDocumentShelf, {
      props: { documents: [available], listStatus: 'offline' },
    })
    expect(wrapper.find('.session-document-list').exists()).toBe(true)
    expect(wrapper.find('[role="status"]').exists()).toBe(true)
  })
})
