import {mount,flushPromises} from '@vue/test-utils'
import {afterEach,beforeEach,test,expect,vi} from 'vitest'
const api=vi.hoisted(()=>({create:vi.fn()}))
vi.mock('../../services/memoryClient',async importOriginal=>({...await importOriginal<typeof import('../../services/memoryClient')>(),createManualMemoryClaim:api.create}))
import MemoryManualClaimDialog from './MemoryManualClaimDialog.vue'
const wrappers:ReturnType<typeof mount>[]=[]
beforeEach(()=>{api.create.mockReset()})
afterEach(()=>{wrappers.forEach(x=>x.unmount());wrappers.length=0;document.body.replaceChildren()})
async function form(){const w=mount(MemoryManualClaimDialog,{props:{installationId:'one'},attachTo:document.body});wrappers.push(w);await flushPromises();return w}
async function fill(){const field=document.querySelector<HTMLTextAreaElement>('[data-testid=manual-statement]')!;field.value='Use stable cursor pagination.';field.dispatchEvent(new Event('input',{bubbles:true}));const c=document.querySelector<HTMLInputElement>('[data-testid=manual-confirm]')!;c.checked=true;c.dispatchEvent(new Event('change',{bubbles:true}));await flushPromises()}
async function submit(){document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await flushPromises()}
test('requires confirmation and saves bounded personal knowledge with an explicit source contract',async()=>{
 api.create.mockResolvedValue({claim_id:'new-claim'})
 const w=await form();expect(document.querySelector<HTMLButtonElement>('[data-testid=manual-save]')!.disabled).toBe(true)
 await fill();await submit()
 expect(api.create).toHaveBeenCalledWith({statement:'Use stable cursor pagination.',claim_type:'work_method',repository_id:null,confirmed:true},expect.stringMatching(/^manual-claim:/),'one')
 expect(w.emitted('created')).toEqual([['new-claim']])
})
test('ambiguous failure preserves input and reuses the exact request key',async()=>{
 api.create.mockRejectedValueOnce(Error('network failed')).mockResolvedValueOnce({claim_id:'saved'})
 const w=await form();await fill();await submit()
 expect(document.querySelector('fieldset')!.disabled).toBe(true)
 expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Use stable cursor pagination.')
 await submit();expect(api.create.mock.calls[1]).toEqual(api.create.mock.calls[0]);expect(w.emitted('created')).toEqual([['saved']])
})
test('installation switch ignores late completion and closes the old form',async()=>{
 let finish!:(v:unknown)=>void;api.create.mockImplementation(()=>new Promise(r=>{finish=r}))
 const w=await form();await fill();await submit();await w.setProps({installationId:'two'});finish({claim_id:'old'});await flushPromises()
 expect(w.emitted('created')).toBeUndefined();expect(w.emitted('close')).toHaveLength(1)
})
test('system dropdown stays in the native dialog and supports option selection',async()=>{
 await form();const trigger=document.querySelector<HTMLButtonElement>('.action-select-trigger')!;trigger.click();await flushPromises()
 expect(document.querySelector('dialog .action-select-content')).not.toBeNull()
 const options=[...document.querySelectorAll<HTMLButtonElement>('[role=option]')];options[0]!.click();await flushPromises()
 expect(document.querySelector('.action-select-content')).toBeNull()
})
