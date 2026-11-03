import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, test, vi } from 'vitest'
import ReplyFooter from '../ReplyFooter.vue'
vi.mock('../../../composables/useLocale', () => ({ useLocale: () => ({ t: (key: string) => key }) }))
afterEach(() => vi.restoreAllMocks())
describe('whole reply footer', () => {
  test('copies all supplied Markdown and acknowledges success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as any)
    const content='First paragraph\n\n```swift\nlet value = 1\n```\n\nLast paragraph'
    const wrapper=mount(ReplyFooter,{props:{content,status:'completed',endedAt:'10:24',duration:'2m 5s'}})
    await wrapper.get('button').trigger('click')
    expect(writeText).toHaveBeenCalledWith(content)
    expect(wrapper.text()).toContain('common.copied')
    expect(wrapper.text()).toContain('2m 5s')
    expect(wrapper.get('.status-ended-at').text()).toBe('10:24')
    wrapper.unmount()
  })
  test('partial copy does not claim completion or expose unauthorized retry', () => {
    const wrapper=mount(ReplyFooter,{props:{content:'Partial',status:'interrupted'}})
    expect(wrapper.get('button').attributes('aria-label')).toBe('session.reply_copy_partial')
    expect(wrapper.text()).toContain('workspace.interrupted')
    expect(wrapper.findAll('button')).toHaveLength(1)
    wrapper.unmount()
  })
})
