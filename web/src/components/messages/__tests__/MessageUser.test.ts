import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MessageUser from '../MessageUser.vue'

describe('#30 MessageUser — width follows content', () => {
  test('applies msg and msg-user classes (CSS drives fit-content + right align)', () => {
    const wrapper = mount(MessageUser, { props: { content: 'hello' } })
    const el = wrapper.find('.msg.msg-user')
    expect(el.exists()).toBe(true)
  })

  test('renders content text', () => {
    const wrapper = mount(MessageUser, { props: { content: '测试消息' } })
    expect(wrapper.text()).toContain('测试消息')
  })

  test('renders long content without truncation in DOM', () => {
    const longText = 'a'.repeat(500)
    const wrapper = mount(MessageUser, { props: { content: longText } })
    expect(wrapper.find('.msg-user').text()).toBe(longText)
  })
})
