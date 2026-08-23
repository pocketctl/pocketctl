import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageAgent from '../MessageAgent.vue'
import MarkdownRenderer from '../../MarkdownRenderer.vue'

describe('MessageAgent presentation', () => {
  test('streaming content renders as literal text without the markdown pipeline', () => {
    const hostile = 'line one\nline two <img src=x onerror="alert(1)"> <script>alert(1)</script>'
    const wrapper = mount(MessageAgent, {
      props: { content: hostile, streaming: true },
    })

    expect(wrapper.findComponent(MarkdownRenderer).exists()).toBe(false)
    const streamingText = wrapper.find('.streaming-text')
    expect(streamingText.exists()).toBe(true)
    expect(streamingText.text()).toBe(hostile)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('.blink-cursor').exists()).toBe(true)
  })

  test('final content renders through the markdown renderer', () => {
    const wrapper = mount(MessageAgent, {
      props: { content: '## Done\n\n- shipped', streaming: false },
    })

    expect(wrapper.findComponent(MarkdownRenderer).exists()).toBe(true)
    expect(wrapper.find('.streaming-text').exists()).toBe(false)
    // happy-dom's DOMPurify drops heading wrappers (browsers keep them), so
    // assert the list markup and text instead of the h2 tag itself.
    expect(wrapper.text()).toContain('Done')
    expect(wrapper.findAll('li')).toHaveLength(1)
    expect(wrapper.find('.blink-cursor').exists()).toBe(false)
  })
})
