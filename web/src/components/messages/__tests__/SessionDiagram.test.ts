import { afterEach, describe, expect, test, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { cleanWithSessionDiagrams, parseMarkdownSegments } from '../../../utils/markdownRenderer'
import { loadDiagramRuntime } from '../../../utils/diagramRuntime'
import MessageUser from '../MessageUser.vue'
import MessageAgent from '../MessageAgent.vue'
import SessionDiagram from '../SessionDiagram.vue'

enableAutoUnmount(afterEach)
afterEach(() => { delete window.PocketDiagram; vi.restoreAllMocks(); document.documentElement.removeAttribute('data-theme') })

const source = 'flowchart LR\r\n    A["<b>甲</b>"] --> B  \r\n'
const message = 'first **literal**\r\n\r\n~~~Mermaid\r\n' + source + '\r\n~~~\r\n\r\nlast'
const rendered = { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="80" height="40"/></svg>', width: 100, height: 50 }

describe('session diagram source detection', () => {
  test('renders the complete user message as selectable literal text without diagram controls', () => {
    const literal = '前言\n' + source + '\n请保留 <tag>、<script> 和围栏。'
    for (const content of [source, message, literal]) {
      const wrapper = mount(MessageUser, { props: { content } })
      expect(wrapper.get('.msg-text').element.textContent).toBe(content)
      expect(wrapper.get('.msg-text').element.childElementCount).toBe(0)
      expect(wrapper.findComponent(SessionDiagram).exists()).toBe(false)
    }
  })
  test('copies only the selected original text, including its final newline', async () => {
    const wrapper = mount(MessageUser, { attachTo: document.body, props: { content: 'prefix 图中 <x>\n' } })
    const element = wrapper.get('.msg-text').element
    const range = document.createRange()
    range.selectNodeContents(element)
    range.setStart(element.firstChild!, 7)
    const selected = window.getSelection()!
    selected.removeAllRanges()
    selected.addRange(range)
    const clipboardData = { setData: vi.fn() }
    await wrapper.get('.msg-text').trigger('copy', { clipboardData })
    expect(clipboardData.setData).toHaveBeenCalledWith('text/plain', '图中 <x>\n')
    selected.removeAllRanges()
  })
  test('extracts exact assistant source while keeping other Markdown fences ordinary', () => {
    expect(parseMarkdownSegments(message, true).map(part => part.type)).toEqual(['prose', 'diagram', 'prose'])
    expect(parseMarkdownSegments(message, true)[1].content).toBe(source)
    expect(parseMarkdownSegments(message)[1].type).toBe('code')
    const raw = '\n  graph TD; A-->B  \r\n'
    expect(parseMarkdownSegments(raw, true)[0].content).toBe(raw)
    for (const other of ['```mermaid\ngraph LR\n    ```', 'graph theory', 'graph TD is a direction', '```mermaid\ngraph TD', '````text\n```mermaid\nA\n```\n````']) {
      expect(parseMarkdownSegments(other, true).some(part => part.type === 'diagram')).toBe(false)
    }
  })
  test('preserves protected source through the session display cleanup; still removes external metadata', () => {
    const clean = (value: string) => value.replace(/<hidden>[\s\S]*?<\/hidden>/g, '').replace(/<[^>]+>/g, '').trim()
    const input = '<tag>prefix</tag>\n' + message
    expect(cleanWithSessionDiagrams(input, clean)).toBe('prefix\n' + message)
    expect(cleanWithSessionDiagrams('<hidden>\n' + message + '\n</hidden>visible', clean)).toBe('visible')
    expect(cleanWithSessionDiagrams(source, clean)).toBe(source)
    const literalMarker = '\0' + '3;'
    expect(cleanWithSessionDiagrams('<tag>' + literalMarker + '</tag>\n' + message, clean)).toBe(literalMarker + '\n' + message)
  })
  test('defers diagram controls until the streaming message is final', async () => {
    const wrapper = mount(MessageAgent, { props: { content: message, streaming: true } })
    expect(wrapper.findComponent(SessionDiagram).exists()).toBe(false)
    await wrapper.setProps({ streaming: false })
    expect(wrapper.getComponent(SessionDiagram).props('source')).toBe(source)
  })
})

describe('session diagram interactions', () => {
  test('keeps source as default, copies exact text in both modes, and reuses a static image', async () => {
    const render = vi.fn().mockResolvedValue(rendered)
    window.PocketDiagram = { render }
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const wrapper = mount(SessionDiagram, { props: { source } })
    expect(wrapper.get('code').element.textContent).toBe(source)
    expect(render).not.toHaveBeenCalled()
    expect(wrapper.find('.diagram-expand').exists()).toBe(false)
    await wrapper.get('.diagram-copy').trigger('click')
    expect(write).toHaveBeenCalledWith(source)
    await wrapper.get('.diagram-mode').trigger('click')
    await flushPromises()
    expect(render).toHaveBeenCalledTimes(1)
    expect(wrapper.get('img').attributes('src')).toMatch(/^data:image\/svg\+xml/)
    expect(wrapper.find('.diagram-preview svg').exists()).toBe(false)
    await wrapper.get('.diagram-copy').trigger('click')
    expect(write).toHaveBeenCalledTimes(2)
    await wrapper.get('.diagram-mode').trigger('click')
    expect(wrapper.get('code').element.textContent).toBe(source)
    await wrapper.get('.diagram-mode').trigger('click')
    expect(render).toHaveBeenCalledTimes(1)
  })
  test('keeps failed source and allows a retry; clipboard denial exposes selectable text', async () => {
    window.PocketDiagram = { render: vi.fn().mockRejectedValueOnce(new Error('syntax')).mockResolvedValue(rendered) }
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    const wrapper = mount(SessionDiagram, { props: { source } })
    await wrapper.get('.diagram-mode').trigger('click')
    await flushPromises()
    expect(wrapper.get('code').element.textContent).toBe(source)
    expect(wrapper.find('.diagram-status').exists()).toBe(true)
    await wrapper.get('.diagram-mode').trigger('click')
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(true)
    await wrapper.get('.diagram-copy').trigger('click')
    await flushPromises()
    expect(wrapper.get('code').element.textContent).toBe(source)
    expect(wrapper.get('.diagram-copy').text()).toMatch(/failed|失败/i)
  })
  test('ignores a previous result if history updates the message source', async () => {
    let finish!: (value: typeof rendered) => void
    window.PocketDiagram = { render: () => new Promise(resolve => { finish = resolve }) }
    const wrapper = mount(SessionDiagram, { props: { source } })
    await wrapper.get('.diagram-mode').trigger('click')
    await flushPromises()
    await wrapper.setProps({ source: 'graph TD\nB --> C' })
    finish(rendered)
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('code').text()).toBe('graph TD\nB --> C')
  })
  test('opens the modal, zooms with the keyboard, resets and returns focus on Escape', async () => {
    window.PocketDiagram = { render: vi.fn().mockResolvedValue(rendered) }
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const wrapper = mount(SessionDiagram, { attachTo: document.body, props: { source } })
    await wrapper.get('.diagram-mode').trigger('click')
    await flushPromises()
    await wrapper.get('.diagram-expand').trigger('click')
    await flushPromises()
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!
    expect(dialog).toBeTruthy()
    const press = async (key: string) => {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await flushPromises()
    }
    dialog.querySelector<HTMLButtonElement>('button[aria-live]')!.click()
    await flushPromises()
    expect(write).toHaveBeenCalledWith(source)
    await press('+')
    expect(dialog.textContent).toContain('140%')
    await press('0')
    expect(dialog.textContent).toContain('100%')
    await press('Escape')
    expect(document.querySelector('dialog[open]')).toBeNull()
    expect(document.activeElement).toBe(wrapper.get('.diagram-expand').element)
  })
  test('loads one local script for concurrent conversions and can retry a failed load', async () => {
    const append = vi.spyOn(document.head, 'append').mockImplementation(() => {})
    const failure = loadDiagramRuntime()
    expect(loadDiagramRuntime()).toBe(failure)
    const script = append.mock.calls[0][0] as HTMLScriptElement
    expect(script.getAttribute('src')).toBe(import.meta.env.BASE_URL + 'diagram/runtime.js')
    script.dispatchEvent(new Event('error'))
    await expect(failure).rejects.toThrow()
    const retry = loadDiagramRuntime()
    expect(append).toHaveBeenCalledTimes(2)
    window.PocketDiagram = { render: vi.fn() }
    const retryScript = append.mock.calls[1][0] as HTMLScriptElement
    retryScript.dispatchEvent(new Event('load'))
    expect(await retry).toBe(window.PocketDiagram)
  })
})
