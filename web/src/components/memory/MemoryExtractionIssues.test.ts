import {flushPromises,mount} from '@vue/test-utils'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
const api=vi.hoisted(()=>({list:vi.fn(),retry:vi.fn()}))
vi.mock('../../services/memoryClient',()=>({listMemoryExtractionIssues:api.list,retryMemoryExtraction:api.retry}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(key:string)=>key})}))
import MemoryExtractionIssues from './MemoryExtractionIssues.vue'
const issue={run_id:'r1',session_id:'s1',turn_id:'t1',completed_at:'2026-11-02T00:00:00Z',reason:'invalid_claim_type',status:'unresolved',retry_count:0,can_retry:true,blocked_reason:null}
beforeEach(()=>{vi.useFakeTimers();api.list.mockReset();api.retry.mockReset()})
afterEach(()=>vi.useRealTimers())
test('confirms model use before enqueue, polls progress and emits after issues clear',async()=>{
 api.list.mockResolvedValueOnce({issues:[issue],has_more:false}).mockResolvedValueOnce({issues:[{...issue,status:'pending',can_retry:false}],has_more:false}).mockResolvedValue({issues:[],has_more:false})
 api.retry.mockResolvedValue({job_id:'j1',state:'pending'})
 const w=mount(MemoryExtractionIssues,{props:{installationId:'one'}});await flushPromises()
 expect(w.text()).toContain('memory.recovery.reason.invalid_claim_type')
 await w.get('[data-testid="extraction-retry"]').trigger('click')
 expect(api.retry).not.toHaveBeenCalled();expect(w.text()).toContain('memory.recovery.confirm_hint')
 await w.get('[data-testid="extraction-retry-confirm"]').trigger('click');await flushPromises()
 expect(api.retry).toHaveBeenCalledWith('one','r1');expect(w.text()).toContain('memory.recovery.status.pending')
 await vi.advanceTimersByTimeAsync(10000);await flushPromises()
 expect(w.text()).toContain('memory.recovery.empty');expect(w.emitted('updated')).toBeTruthy();w.unmount()
})
test('failed retry keeps bounded error and can safely check using the same run',async()=>{
 api.list.mockResolvedValue({issues:[issue],has_more:false});api.retry.mockRejectedValue(Error('private details'))
 const w=mount(MemoryExtractionIssues,{props:{installationId:'one'}});await flushPromises()
 await w.get('[data-testid="extraction-retry"]').trigger('click');await w.get('[data-testid="extraction-retry-confirm"]').trigger('click');await flushPromises()
 expect(w.text()).toContain('memory.recovery.retry_unknown');expect(w.text()).not.toContain('private details');w.unmount()
})
test('installation switch clears rows and ignores a late list response',async()=>{
 let resolve!:(v:unknown)=>void
 api.list.mockImplementationOnce(()=>new Promise(r=>{resolve=r})).mockResolvedValue({issues:[],has_more:false})
 const w=mount(MemoryExtractionIssues,{props:{installationId:'one'}})
 await w.setProps({installationId:'two'});await flushPromises();resolve({issues:[issue],has_more:false});await flushPromises()
 expect(w.text()).not.toContain('s1');expect(w.text()).toContain('memory.recovery.empty');w.unmount()
})
test('operator-only problems explain why retry is unavailable',async()=>{
 api.list.mockResolvedValue({issues:[{...issue,can_retry:false,blocked_reason:'operator_required'}],has_more:true})
 const w=mount(MemoryExtractionIssues,{props:{installationId:'one'}});await flushPromises()
 expect(w.find('[data-testid="extraction-retry"]').exists()).toBe(false)
 expect(w.text()).toContain('memory.recovery.blocked.operator_required');expect(w.text()).toContain('memory.recovery.more');w.unmount()
})
