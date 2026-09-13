import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, test } from 'vitest'

import SessionDocumentViewer from '../SessionDocumentViewer.vue'
import { STATIC_DOCUMENT_CSP } from '../../../utils/staticHtmlSnapshot'

const baseDocument = {
  documentId: 'doc-1', versionId: 'ver-1', displayName: 'notes.md', format: 'markdown' as const,
  state: 'available' as const, reason: null, byteSize: 5, sha256: 'a'.repeat(64),
  sourceTurnId: 'turn-1', sourceEventId: 'event-1', capturedAt: '2026-09-11T00:00:00Z', committedAt: 'now',
}

afterEach(() => { document.body.innerHTML = '' })

describe('SessionDocumentViewer', () => {
  test('keeps raw Markdown HTML inert in both preview and source modes', async () => {
    const hostile = '# Safe\n<script>globalThis.pwned=true</script><img src=x onerror="globalThis.pwned=true">'
    const wrapper = mount(SessionDocumentViewer, {
      attachTo: document.body,
      props: { viewer: { status: 'ready', document: baseDocument, text: hostile, offlineSnapshot: false }, htmlRendering: false, compact: false },
    })
    expect(document.body.querySelector('.document-markdown script')).toBeNull()
    expect(document.body.querySelector('.document-markdown img')).toBeNull()
    const tabs = document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    tabs[1].click()
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.document-source')?.textContent).toContain('<script>')
    expect(document.body.querySelector('.document-source script')).toBeNull()
  })

  test('renders HTML only in an empty-sandbox recreated srcdoc with the deny-all policy', () => {
    mount(SessionDocumentViewer, {
      attachTo: document.body,
      props: {
        viewer: { status: 'ready', document: { ...baseDocument, format: 'html', displayName: 'page.html' }, text: '<script>fetch("https://evil.test")</script>', offlineSnapshot: false },
        htmlRendering: true,
        compact: false,
      },
    })
    const frame = document.body.querySelector<HTMLIFrameElement>('iframe')
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('sandbox')).toBe('')
    expect(frame?.getAttribute('srcdoc')).toContain(STATIC_DOCUMENT_CSP)
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  test('removes nested browsing contexts from preview while preserving them in source mode', async () => {
    const hostile = '<p>before</p><iframe src="https://attacker.invalid/frame"><b>fallback</b></iframe><frame src="https://attacker.invalid/legacy"><p>after</p>'
    const wrapper = mount(SessionDocumentViewer, {
      attachTo: document.body,
      props: {
        viewer: { status: 'ready', document: { ...baseDocument, format: 'html', displayName: 'page.html' }, text: hostile, offlineSnapshot: false },
        htmlRendering: true,
        compact: false,
      },
    })
    const srcdoc = document.body.querySelector<HTMLIFrameElement>('iframe')?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('before')
    expect(srcdoc).toContain('after')
    expect(srcdoc).not.toMatch(/<(?:iframe|frame)\b/i)
    document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click()
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.document-source')?.textContent).toContain('<iframe')
  })

  test('traps focus, closes on Escape, restores focus, and supports compact pushed-page markup', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const wrapper = mount(SessionDocumentViewer, {
      attachTo: document.body,
      props: { viewer: { status: 'ready', document: baseDocument, text: 'hello', offlineSnapshot: false }, htmlRendering: false, compact: true, returnFocusTo: opener },
    })
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector('.session-document-viewer-layer.compact')).not.toBeNull()
    const layer = document.body.querySelector<HTMLElement>('.session-document-viewer-layer')!
    await layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ viewer: { status: 'closed', document: null, text: '', offlineSnapshot: false } })
    expect(document.activeElement).toBe(opener)
    expect(document.body.querySelector('iframe')).toBeNull()
  })
})
