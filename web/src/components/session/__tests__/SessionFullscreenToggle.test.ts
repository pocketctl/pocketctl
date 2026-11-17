import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import Toggle from '../SessionFullscreenToggle.vue'
describe('conversation fullscreen', () => {
 it('toggles both ways and exits with Escape', async () => {
  const wrapper = mount(Toggle, {props:{modelValue:false}})
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  await wrapper.setProps({modelValue:true})
  expect(wrapper.get('button').attributes('aria-pressed')).toBe('true')
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  const events=wrapper.emitted('update:modelValue')!
  const count=events.length
  wrapper.unmount()
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))
  expect(events).toHaveLength(count)
 })
})
it('is icon-only without tooltip and defers Escape to an open overlay', async () => {
 const wrapper = mount(Toggle, { props: { modelValue: true, escapeBlocked: true } })
 expect(wrapper.get('button').text()).toBe('')
 expect(wrapper.get('button').attributes('title')).toBeUndefined()
 expect(wrapper.get('button').attributes('aria-label')).toBeTruthy()
 window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
 expect(wrapper.emitted('update:modelValue')).toBeUndefined()
 wrapper.unmount()
})
