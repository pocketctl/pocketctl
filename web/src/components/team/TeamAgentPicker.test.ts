import { mount } from '@vue/test-utils'
import { describe, expect, test, vi } from 'vitest'
import TeamAgentPicker from './TeamAgentPicker.vue'
vi.mock('../../composables/useLocale', () => ({useLocale: () => ({t: (key: string) => key})}))

describe('DSH Team selection', () => {
 test('labels and shares DSH without presenting it as Codex', async () => {
  const wrapper = mount(TeamAgentPicker, {props:{modelValue:[],candidates:[{
   daemon_id:'host',hostname:'macmini',provider:'dsh',installed:true,online:true,managed_callable:true,dispatch_supported:true,availability:'online',occupied_team_id:null,
  }]}})
  expect(wrapper.text()).toContain('DeepSeek Harness')
  await wrapper.get('input').setValue(true)
  expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([['host:dsh']])
 })
})
