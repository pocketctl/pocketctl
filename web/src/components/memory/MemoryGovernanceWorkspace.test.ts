import { describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import MemoryScopeSwitcher from './MemoryScopeSwitcher.vue'
import MemoryGovernanceQueue from './MemoryGovernanceQueue.vue'
import MemoryConflictPanel from './MemoryConflictPanel.vue'

vi.mock('../../composables/useLocale', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}))

const scopes = [
  { installation_id: '11111111-1111-4111-8111-111111111111', owner_scope_kind: 'personal' as const,
    owner_scope_id: '11111111-1111-4111-8111-111111111111', authorization_epoch: '1', permissions: [] },
  { installation_id: '22222222-2222-4222-8222-222222222222', owner_scope_kind: 'team' as const,
    owner_scope_id: '33333333-3333-4333-8333-333333333333', authorization_epoch: '4', permissions: [] },
]

describe('MemoryScopeSwitcher', () => {
  test('renders personal first and emits selection changes', async () => {
    const wrapper = mount(MemoryScopeSwitcher, {
      props: { scopes, modelValue: scopes[0].installation_id },
      global: { stubs: { transition: false } },
    })
    const chips = wrapper.findAll('.memory-scope-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].classes()).toContain('memory-scope-chip-active')
    await chips[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([scopes[1].installation_id])
  })
})

describe('MemoryGovernanceQueue', () => {
  const entry = {
    candidate: {
      candidate_id: '44444444-4444-4444-8444-444444444444',
      target_installation_id: '22222222-2222-4222-8222-222222222222',
      source_scope_kind: 'personal',
      normalized_key: 'deploy-key',
      state: 'proposed',
      conflict_group_id: null,
      duplicate_of_claim_id: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      revision: 1,
    },
    current_revision: { revision_number: 1, statement: 'gated deploy statement' },
    decisions: [],
    conflict_claims: [],
  }

  test('renders entries and emits decide/publish actions', async () => {
    const wrapper = mount(MemoryGovernanceQueue, {
      props: { entries: [entry], loading: false, error: null },
    })
    expect(wrapper.find('.memory-governance-statement').text()).toContain('gated deploy statement')
    const buttons = wrapper.findAll('button')
    await buttons[0].trigger('click')
    expect(wrapper.emitted('decide')?.[0]).toEqual([entry.candidate.candidate_id, 'approve'])
    await buttons[3].trigger('click')
    expect(wrapper.emitted('publish')?.[0]).toEqual([entry.candidate.candidate_id, 'new'])
  })

  test('bulk binds each selected immutable revision and does not publish',async()=>{
    const hashed={...entry,current_revision:{...entry.current_revision,bundle_hash:'a'.repeat(64)},automation_mode:'assist' as const,automation_advice:{recommendation:'needs_human',reason:'risk'},evidence:[{ordinal:1,excerpt:'sanitized proof',excerpt_hash:'b'.repeat(64)}]}
    const wrapper=mount(MemoryGovernanceQueue,{props:{entries:[hashed],loading:false,error:null}})
    expect(wrapper.text()).toContain('memory.governance.automation.adviceOnly')
    expect(wrapper.text()).toContain('assist')
    await wrapper.get('input[type=checkbox]').setValue(true)
    await wrapper.findAll('button').find(b=>b.text().includes('bulkApprove'))!.trigger('click')
    const items=wrapper.emitted('bulk')?.[0][0] as any[]
    expect(items[0]).toMatchObject({candidate_id:entry.candidate.candidate_id,expected_revision:1,expected_hash:'a'.repeat(64),decision:'approve'})
    expect(items[0].review_duration_ms).toBeUndefined()
    expect(wrapper.emitted('publish')).toBeUndefined()
    await wrapper.setProps({entries:[{...hashed,candidate:{...hashed.candidate,revision:2}}]})
    expect((wrapper.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false)
  })
  test('human edits explicitly retain evidence and request a fresh revision',async()=>{
    const hashed={...entry,current_revision:{...entry.current_revision,bundle_hash:'a'.repeat(64)},evidence:[{ordinal:1,excerpt:'proof',excerpt_hash:'b'.repeat(64)}]}
    const wrapper=mount(MemoryGovernanceQueue,{props:{entries:[hashed],loading:false,error:null}})
    await wrapper.get('textarea').setValue('Edited candidate statement')
    await wrapper.findAll('details').at(-1)!.get('button').trigger('click')
    expect(wrapper.emitted('revise')?.[0]).toEqual([{candidateId:entry.candidate.candidate_id,statement:'Edited candidate statement',retainedOrdinals:[1]}])
    expect(wrapper.emitted('decide')).toBeUndefined()
  })

  test('delegated publication is visibly off and does not borrow review votes',async()=>{
    const hashed={...entry,current_revision:{...entry.current_revision,bundle_hash:'a'.repeat(64)},delegated_publish_mode:'off' as const}
    const wrapper=mount(MemoryGovernanceQueue,{props:{entries:[hashed],loading:false,error:null,executors:[]}})
    const button=wrapper.findAll('details')[0].get('button')
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('details')[0].text()).toContain('memory.governance.delegation.copy')
    await button.trigger('click');expect(wrapper.emitted('delegate')).toBeUndefined()
  })
  test('evidence filter preserves actionable missing-proof state',async()=>{
    const wrapper=mount(MemoryGovernanceQueue,{props:{entries:[{...entry,evidence:[]}],loading:false,error:null}})
    await wrapper.get('select').setValue('evidence')
    expect(wrapper.findAll('article')).toHaveLength(1)
    expect(wrapper.find('input[type=checkbox]').exists()).toBe(false)
  })

  test('distinguishes provider failure from an empty queue', () => {
    const failed = mount(MemoryGovernanceQueue, {
      props: { entries: [], loading: false, error: 'governance queue unavailable' },
    })
    expect(failed.find('.memory-governance-error').exists()).toBe(true)
    const empty = mount(MemoryGovernanceQueue, {
      props: { entries: [], loading: false, error: null },
    })
    expect(empty.find('.memory-governance-error').exists()).toBe(false)
    expect(empty.text()).toContain('memory.governance.queue.empty')
  })
})

describe('MemoryConflictPanel', () => {
  test('never preselects a destructive resolution', () => {
    const wrapper = mount(MemoryConflictPanel, {
      props: {
        candidates: [{ candidate_id: '55555555-5555-4555-8555-555555555555', normalized_key: 'k' }],
        claims: [{ candidate_id: '55555555-5555-4555-8555-555555555555', claim_id: '66666666-6666-4666-8666-666666666666', statement: 'incumbent', conflict_variant: 0 }],
      },
    })
    const resolve = wrapper.findAll('button').find(button => button.text().includes('memory.governance.conflict.resolve'))!
    expect(resolve.attributes('disabled')).toBeDefined()
    const checked = wrapper.findAll('input[type=radio]')
    expect(checked.every(radio => (radio.element as HTMLInputElement).checked === false)).toBe(true)
  })

  test('binds supersede selections to the selected conflict candidate', async () => {
    const wrapper = mount(MemoryConflictPanel, {
      props: {
        candidates: [
          { candidate_id: '55555555-5555-4555-8555-555555555551', normalized_key: 'one' },
          { candidate_id: '55555555-5555-4555-8555-555555555552', normalized_key: 'two' },
        ],
        claims: [
          { candidate_id: '55555555-5555-4555-8555-555555555551', claim_id: '66666666-6666-4666-8666-666666666661', statement: 'first incumbent', conflict_variant: 0 },
          { candidate_id: '55555555-5555-4555-8555-555555555552', claim_id: '66666666-6666-4666-8666-666666666662', statement: 'second incumbent', conflict_variant: 0 },
        ],
      },
    })
    await wrapper.get('select').setValue('55555555-5555-4555-8555-555555555552')
    await wrapper.get('input[type=radio][value=supersede]').setValue(true)
    const labels = wrapper.findAll('.memory-conflict-claims label')
    expect(labels).toHaveLength(1)
    expect(labels[0].text()).toContain('second incumbent')
    await labels[0].get('input[type=checkbox]').setValue(true)
    await wrapper.get('footer button').trigger('click')
    expect(wrapper.emitted('resolve')?.[0]).toEqual([{
      candidateId: '55555555-5555-4555-8555-555555555552',
      resolution: 'supersede',
      claimIds: ['66666666-6666-4666-8666-666666666662'],
    }])
  })
})
