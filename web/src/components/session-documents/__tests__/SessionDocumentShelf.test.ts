import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'

import SessionDocumentShelf from '../SessionDocumentShelf.vue'
import { useLocale } from '../../../composables/useLocale'

const available = {
  documentId: 'doc-1', versionId: 'ver-1', displayName: 'notes.md', format: 'markdown' as const,
  state: 'available' as const, reason: null, byteSize: 2048, sha256: 'a'.repeat(64),
  sourceTurnId: 'turn-1', sourceEventId: 'event-1', capturedAt: 'now', committedAt: 'now',
}

describe('SessionDocumentShelf', () => {
  test('keeps keyboard focus in the dialog when the final page disables Next', async () => {
    const documents = Array.from({ length: 23 }, (_, i) => ({ ...available, documentId: `focus-${i}` }))
    const wrapper = mount(SessionDocumentShelf, { attachTo: document.body,
      props: { documents, listStatus: 'ready' } })
    await wrapper.get('[data-testid="documents-more"]').trigger('click')
    const next = document.querySelector<HTMLButtonElement>('[data-testid="documents-next"]')!
    next.focus(); next.click(); await nextTick(); await nextTick()
    next.focus(); next.click(); await nextTick(); await nextTick()
    expect(next.disabled).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'))
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(wrapper.get('[data-testid="documents-more"]').element)
    wrapper.unmount()
  })

  test('shows latest three and paginates all documents in a dialog', async () => {
    const documents = Array.from({ length: 23 }, (_, i) => ({ ...available,
      documentId: `doc-${i}`, displayName: `notes-${i}.md` }))
    const wrapper = mount(SessionDocumentShelf, { props: { documents, listStatus: 'ready' },
      global: { stubs: { Teleport: true } } })
    expect(wrapper.findAll('button.session-document-row')).toHaveLength(3)
    await wrapper.get('[data-testid="documents-more"]').trigger('click')
    const dialog = () => wrapper.get('[role="dialog"]')
    expect(dialog().findAll('button.session-document-row')).toHaveLength(10)
    expect(dialog().text()).toContain('notes-0.md')
    await dialog().get('[data-testid="documents-next"]').trigger('click')
    expect(dialog().text()).toContain('notes-10.md')
    expect(dialog().text()).not.toContain('notes-0.md')
    await dialog().get('[data-testid="documents-next"]').trigger('click')
    expect(dialog().findAll('button.session-document-row')).toHaveLength(3)
    expect(dialog().get('[data-testid="documents-next"]').attributes('disabled')).toBeDefined()
    await dialog().find('button.session-document-row').trigger('click')
    expect(wrapper.emitted('open')?.[0]?.[0]).toEqual(documents[20])
    wrapper.unmount()
  })

  test('clamps pages after refresh and closes when access clears the list', async () => {
    const documents = Array.from({ length: 23 }, (_, i) => ({ ...available, documentId: `doc-${i}` }))
    const wrapper = mount(SessionDocumentShelf, { props: { documents, listStatus: 'ready' },
      global: { stubs: { Teleport: true } } })
    await wrapper.get('[data-testid="documents-more"]').trigger('click')
    await wrapper.get('[data-testid="documents-next"]').trigger('click')
    await wrapper.get('[data-testid="documents-next"]').trigger('click')
    await wrapper.setProps({ documents: documents.slice(0, 4) })
    expect(wrapper.get('[role="dialog"]').text()).toContain('1 / 1')
    expect(wrapper.get('[role="dialog"]').findAll('.session-document-row')).toHaveLength(4)
    await wrapper.setProps({ documents: [], listStatus: 'unavailable' })
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

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

  test('exposes a retry when metadata loading fails instead of hiding the shelf', async () => {
    const wrapper = mount(SessionDocumentShelf, {
      props: { documents: [], listStatus: 'unavailable' },
    })
    expect(wrapper.find('.session-document-shelf').exists()).toBe(true)
    expect(wrapper.find('[role="status"]').text()).toContain(useLocale().t('session.documents.list_failed'))
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
    wrapper.unmount()
  })
})
