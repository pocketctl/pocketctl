import {mount,flushPromises} from '@vue/test-utils'
import {test,expect,vi,beforeEach} from 'vitest'
const client=vi.hoisted(()=>({listMemoryScenes:vi.fn(),createMemoryPersonalScene:vi.fn()}))
vi.mock('../../services/memoryClient',()=>client)
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(k:string)=>k})}))
import Form from './MemoryPersonalSceneForm.vue'
beforeEach(()=>{vi.clearAllMocks();client.listMemoryScenes.mockResolvedValue({scenes:[],has_more:false});client.createMemoryPersonalScene.mockResolvedValue({space_id:'new-scene',name:'Acceptance',domain:'personal_project',destinations:['personal']})})
test('explicit personal scene create preserves named scope and blocks duplicate clicks',async()=>{
 let finish!:(x:unknown)=>void;client.createMemoryPersonalScene.mockImplementationOnce(()=>new Promise(r=>{finish=r}))
 const w=mount(Form,{props:{installationId:'personal-one'}});await flushPromises()
 await w.get('[data-testid="memory-scene-name"]').setValue('Acceptance')
 await w.get('[data-testid="memory-scene-create"]').trigger('click');await flushPromises()
 await vi.waitFor(()=>expect(client.createMemoryPersonalScene).toHaveBeenCalledTimes(1))
 expect(client.createMemoryPersonalScene).toHaveBeenCalledTimes(1)
 expect(client.createMemoryPersonalScene.mock.calls[0].slice(0,2)).toEqual(['personal-one','Acceptance'])
 expect(w.get('[data-testid="memory-scene-create"]').attributes('disabled')).toBeDefined()
 finish({space_id:'new-scene',name:'Acceptance',domain:'personal_project',destinations:['personal']});await flushPromises();expect(w.text()).toContain('Acceptance');w.unmount()
})
test('unknown creation response retries the same request identity',async()=>{
 client.createMemoryPersonalScene.mockRejectedValueOnce(new Error('response unavailable'))
 const w=mount(Form,{props:{installationId:'personal-one'}});await flushPromises();await w.get('[data-testid="memory-scene-name"]').setValue('Acceptance')
 await w.get('[data-testid="memory-scene-create"]').trigger('click');await flushPromises();await vi.waitFor(()=>expect(w.get('[data-testid="memory-scene-error"]').text()).toContain('response unavailable'))
 await w.get('[data-testid="memory-scene-create"]').trigger('click');await flushPromises();await vi.waitFor(()=>expect(client.createMemoryPersonalScene).toHaveBeenCalledTimes(2));expect(client.createMemoryPersonalScene.mock.calls[0][2]).toEqual(client.createMemoryPersonalScene.mock.calls[1][2]);w.unmount()
})
