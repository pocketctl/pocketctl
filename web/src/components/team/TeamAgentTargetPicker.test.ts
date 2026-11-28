import { mount } from '@vue/test-utils'
import { expect, test } from 'vitest'
import TeamAgentTargetPicker from './TeamAgentTargetPicker.vue'
import type { TeamSessionAgentBinding, TeamMember } from '../../types/team'
const agents:TeamSessionAgentBinding[]=[1,2,3].map(id=>({id:'b'+id,offer_id:'o'+id,owner_user_id:id,provider:'codex',daemon_id:'mac-'+id,state:'active',revision:1,native_session_id:null,availability:id===3?'offline':'online',read_only_question:id===1}))
const members=[1,2,3].map(id=>({user_id:id,display_label:'Lin'+id,state:'active'} as TeamMember))
function setup(){
  return mount(TeamAgentTargetPicker,{props:{text:'',modelValue:{mode:'discussion',offerIDs:[]},bindings:agents,members,participantIds:[1,2],height:64,disabled:false,placeholder:'消息'}})
}
test('plain text and email stay in group chat, @ lists active participants and callable agents',async()=>{
  const w=setup(), input=w.get('textarea')
  for(const text of ['hello','hello@abc.com']){await input.setValue(text);expect(w.find('[role=listbox]').exists()).toBe(false)}
  await input.setValue('请@')
  expect(w.get('[role=listbox]').text()).toContain('Lin1')
  expect(w.get('[role=listbox]').text()).not.toContain('Lin3')
  expect(w.get('[role=listbox]').text()).toContain('Codex · Lin2 · mac-2')
  await input.trigger('keydown',{key:'Escape'})
  expect(w.find('[role=listbox]').exists()).toBe(false)
  await input.trigger('keydown',{key:'Enter'})
  expect(w.emitted('send')).toHaveLength(1)
})
test('selecting a member at the caret preserves the suffix without invoking an agent',async()=>{
  const w=setup(),input=w.get('textarea')
  await w.setProps({text:'请@Lin2 看一下'})
  input.element.setSelectionRange(6,6)
  await input.trigger('click')
  await input.trigger('keydown',{key:'Enter'})
  expect(w.emitted('update:text')?.at(-1)).toEqual(['请@Lin2 看一下'])
  expect(w.emitted('update:modelValue')).toBeUndefined()
  expect(w.emitted('send')).toBeUndefined()
})
test('composing Chinese never sends or selects until composition completes',async()=>{
  const w=setup(),input=w.get('textarea')
  await input.trigger('compositionstart');await input.setValue('@Lin')
  await input.trigger('keydown',{key:'Enter',isComposing:true})
  expect(w.find('[role=listbox]').exists()).toBe(false);expect(w.emitted('send')).toBeUndefined()
  await input.trigger('compositionend');expect(w.find('[role=listbox]').exists()).toBe(true)
})
test('readonly mention selects a single offer, removing it restores discussion',async()=>{
  const w=setup(),input=w.get('textarea')
  await input.setValue('@mac-1')
  const options=w.findAll('[role=option]')
  expect(options).toHaveLength(2)
  expect(options[1].find('.agent-badge.codex').exists()).toBe(true)
  await options[1].trigger('click')
  expect(w.emitted('update:modelValue')?.at(-1)).toEqual([{mode:'readonly_offer',offerIDs:['o1']}])
  await w.setProps({modelValue:{mode:'readonly_offer',offerIDs:['o1']},text:''})
  expect(w.get('.mention-chips').text()).toContain('mac-1')
  await w.get('.mention-chips button').trigger('click')
  expect(w.emitted('update:modelValue')?.at(-1)).toEqual([{mode:'discussion',offerIDs:[]}])
})
test('keeps distinct recipients when mentioning several agents',async()=>{
  const w=setup()
  await w.setProps({modelValue:{mode:'offers',offerIDs:['o1']}})
  await w.get('textarea').setValue('@mac-2')
  await w.get('[role=option]').trigger('click')
  expect(w.emitted('update:modelValue')?.at(-1)).toEqual([{mode:'offers',offerIDs:['o1','o2']}])
})
