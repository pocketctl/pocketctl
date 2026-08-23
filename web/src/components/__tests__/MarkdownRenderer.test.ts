import { describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  installMarkdownSanitizerHooks,
  parseMarkdownSegments,
} from '../../utils/markdownRenderer'
import MarkdownRenderer from '../MarkdownRenderer.vue'

describe('markdownRenderer utility', () => {
  test('installs the sanitizer hook once per purifier instance', () => {
    const first = { addHook: vi.fn() }
    const second = { addHook: vi.fn() }

    installMarkdownSanitizerHooks(first as never)
    installMarkdownSanitizerHooks(first as never)
    installMarkdownSanitizerHooks(second as never)

    expect(first.addHook).toHaveBeenCalledOnce()
    expect(first.addHook).toHaveBeenCalledWith('afterSanitizeAttributes', expect.any(Function))
    expect(second.addHook).toHaveBeenCalledOnce()
  })

  test('the installed hook hardens anchors and leaves other tags untouched', () => {
    const purifier = { addHook: vi.fn() }
    installMarkdownSanitizerHooks(purifier as never)
    const hook = purifier.addHook.mock.calls[0][1] as (node: { tagName: string; setAttribute: ReturnType<typeof vi.fn> }) => void

    const anchor = { tagName: 'A', setAttribute: vi.fn() }
    hook(anchor)
    expect(anchor.setAttribute).toHaveBeenCalledWith('target', '_blank')
    expect(anchor.setAttribute).toHaveBeenCalledWith('rel', 'noopener noreferrer')

    const paragraph = { tagName: 'P', setAttribute: vi.fn() }
    hook(paragraph)
    expect(paragraph.setAttribute).not.toHaveBeenCalled()
  })

  test('markdown output never keeps raw scripts, handlers, or javascript links', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">click</a>',
    ].join('\n')
    const html = parseMarkdownSegments(hostile).map(segment => segment.html).join('')

    expect(html.toLowerCase()).not.toContain('<script')
    expect(html.toLowerCase()).not.toContain('<img')
    expect(html.toLowerCase()).not.toContain('<a href="javascript')
  })

  test('maps language aliases onto registered highlight languages', () => {
    const segments = parseMarkdownSegments('```ts\nconst answer = 42\n```')
    expect(segments).toHaveLength(1)
    expect(segments[0].type).toBe('code')
    expect(segments[0].language).toBe('ts')
    expect(segments[0].html).toContain('hljs-')
  })

  test('falls back to escaped plaintext for unknown languages', () => {
    const segments = parseMarkdownSegments('```notalang\na < b & c\n```')
    expect(segments[0].type).toBe('code')
    expect(segments[0].html).not.toContain('hljs-')
    expect(segments[0].html).toContain('a &lt; b &amp; c')
  })

  test('strips Claude command tags before parsing', () => {
    const segments = parseMarkdownSegments(
      '<command-name>foo</command-name><command-args>secret args</command-args>visible',
    )
    const joined = segments.map(segment => segment.content + segment.html).join('')
    expect(joined).toContain('visible')
    expect(joined).not.toContain('command-name')
    expect(joined).not.toContain('secret args')
  })
})

describe('MarkdownRenderer component', () => {
  test('renders prose, lists, and fenced code with a copy button', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '## Title\n\n- item\n\n```go\nfmt.Println(1)\n```' },
    })
    // happy-dom's DOMPurify drops heading wrappers but keeps text, lists,
    // and the unsanitized fenced-code path; browsers keep the heading tag.
    expect(wrapper.text()).toContain('Title')
    expect(wrapper.findAll('li')).toHaveLength(1)
    expect(wrapper.find('.md-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-copy').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('go')
  })

  test('renders sanitized prose only through v-html', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '<script>alert(1)</script>ok' },
    })
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.text()).toContain('ok')
  })
})
