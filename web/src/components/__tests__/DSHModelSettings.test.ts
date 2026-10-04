import { mount } from '@vue/test-utils'
import { describe, expect, test } from 'vitest'
import DSHModelSettings from '../DSHModelSettings.vue'

const props = {
  models: [
    {alias:'deepseek/flash',name:'Flash',supported_reasoning_efforts:['off','low','high','max'],default_reasoning_effort:'high'},
    {alias:'zai/glm',name:'GLM',supported_reasoning_efforts:['low','high'],default_reasoning_effort:'low'},
  ],
  model:'deepseek/flash',effort:'max',disabled:false,disabledReason:'',pending:false,error:'',
}
function create(extra = {}) { return mount(DSHModelSettings, {props:{...props,...extra},global:{stubs:{Teleport:true}}}) }
describe('DSH model settings', () => {
  test('draft model resets incompatible effort and submits both only on apply', async () => {
    const wrapper=create()
    await wrapper.find('.model-trigger').trigger('click')
    await wrapper.findAll('.model-option')[1]!.trigger('click')
    expect(wrapper.find('.effort-options').text()).not.toContain('max')
    expect(wrapper.find('.effort-options .selected').text()).toBe('low')
    expect(wrapper.emitted('select')).toBeUndefined()
    await wrapper.find('.apply-settings').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['zai/glm','low']])
    await wrapper.setProps({pending:true})
    await wrapper.setProps({pending:false,error:'Host rejected'})
    expect(wrapper.find('[role="alert"]').text()).toBe('Host rejected')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    wrapper.unmount()
  })
  test('cancel discards drafts; successful native confirmation closes dialog', async () => {
    const wrapper=create()
    await wrapper.find('.effort-trigger').trigger('click')
    await wrapper.findAll('.effort-options button')[1]!.trigger('click')
    await wrapper.find('.cancel-settings').trigger('click')
    expect(wrapper.emitted('select')).toBeUndefined()
    await wrapper.find('.model-trigger').trigger('click')
    expect(wrapper.find('.effort-options .selected').text()).toBe('max')
    await wrapper.findAll('.effort-options button')[1]!.trigger('click')
    await wrapper.find('.apply-settings').trigger('click')
    await wrapper.setProps({pending:true})
    await wrapper.setProps({pending:false,effort:'off'})
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })
  test('disabled settings remain inspectable with an explanation', async () => {
    const wrapper=create({disabled:true,disabledReason:'Running'})
    await wrapper.find('.model-trigger').trigger('click')
    expect(wrapper.find('[role="status"]').text()).toBe('Running')
    expect(wrapper.find('.apply-settings').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.model-option').attributes('disabled')).toBeDefined()
    await wrapper.find('input').setValue('unknown-provider')
    expect(wrapper.findAll('.model-option')).toHaveLength(0)
    wrapper.unmount()
  })
})
