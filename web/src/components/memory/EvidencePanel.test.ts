import {mount,flushPromises} from '@vue/test-utils'
import {test,expect,vi,beforeEach} from 'vitest'
const api=vi.hoisted(()=>({read:vi.fn()}))
vi.mock('../../services/memoryClient',()=>({listVersionEvidence:api.read}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(s:string)=>s})}))
import EvidencePanel from './EvidencePanel.vue'
beforeEach(()=>{api.read.mockReset()})
test('evidence failure is an error with retry rather than a false empty result',async()=>{
 api.read.mockRejectedValueOnce(Error('network')).mockResolvedValueOnce([{evidence_id:'one',excerpt:'retained evidence',evidence_kind:'accepted_excerpt',occurred_at:'date'}])
 const w=mount(EvidencePanel,{props:{versionId:'v1'}});await flushPromises()
 expect(w.get('[role=alert]').text()).toContain('memory.evidence_load_failed')
 expect(w.text()).not.toContain('memory.evidence_empty')
 await w.get('[data-testid=memory-evidence-retry]').trigger('click');await flushPromises()
 expect(w.text()).toContain('retained evidence');w.unmount()
})
test('evidence reads clear old excerpts immediately and ignore late responses after version changes',async()=>{
 let finish!:(v:unknown)=>void
 api.read.mockImplementationOnce(()=>new Promise(r=>{finish=r})).mockResolvedValueOnce([{evidence_id:'new',excerpt:'new version proof'}])
 const w=mount(EvidencePanel,{props:{versionId:'old'}});await w.setProps({versionId:'new'});await flushPromises()
 finish([{evidence_id:'old',excerpt:'stale private evidence'}]);await flushPromises()
 expect(w.text()).toContain('new version proof');expect(w.text()).not.toContain('stale private evidence');w.unmount()
})
