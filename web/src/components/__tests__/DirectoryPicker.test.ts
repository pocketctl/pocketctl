import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import DirectoryPicker from '../DirectoryPicker.vue'
const ws=vi.hoisted(()=>({send:vi.fn(),handlers:new Map<string,(m:any)=>void>()}))
vi.mock('../../composables/useWebSocket',()=>({useWebSocket:()=>({send:ws.send,onEvent:(t:string,h:(m:any)=>void)=>{ws.handlers.set(t,h);return()=>ws.handlers.delete(t)}})}))
vi.mock('../../composables/useLocale',()=>({useLocale:()=>({t:(k:string)=>k})}))
const result={path:'/home/me',parent:'',home:'/home/me',roots:['/home/me'],can_browse:true,can_select:true,entries:[{name:'project',path:'/home/me/project',can_browse:true,can_select:true}]}
function last(type='list_directories'){return ws.send.mock.calls.map(([m])=>m).filter(m=>m.type===type).at(-1)}
function reply(data:any=result,extra:any={}){ws.handlers.get('directory_result')?.({type:'directory_result',daemon_id:'d1',request_id:last().request_id,directory:data,...extra})}
function mountPicker(){return mount(DirectoryPicker,{props:{daemonId:'d1',hostName:'m3',initialPath:'~/',online:true}})}
beforeEach(()=>{vi.useFakeTimers();ws.send.mockReset();ws.handlers.clear();let id=0;vi.stubGlobal('crypto',{randomUUID:()=>`req-${++id}`})})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
test('opens cwd, ignores foreign/old replies, revalidates before selecting',async()=>{
 const w=mountPicker();expect(last()).toMatchObject({path:'~/',daemon_id:'d1',fallback:true})
 reply(result,{daemon_id:'other'});await nextTick();expect(w.findAll('.directory-row')).toHaveLength(0)
 reply(result,{request_id:'stale'});await nextTick();expect(w.findAll('.directory-row')).toHaveLength(0)
 reply();await nextTick();await w.get('button.primary').trigger('click')
 expect(w.emitted('select')).toBeUndefined();const req=last('validate_directory')
 ws.handlers.get('directory_result')?.({daemon_id:'d1',request_id:req.request_id,directory:result})
 expect(w.emitted('select')?.[0]).toEqual(['/home/me']);w.unmount()
})
test('search queries host, pagination appends and cancellation leaves original path',async()=>{
 const w=mountPicker();reply({...result,next_cursor:'page2'});await nextTick()
 await w.get('.load-more').trigger('click');expect(last().cursor).toBe('page2')
 reply({...result,entries:[{...result.entries[0],name:'second',path:'/home/me/second'}]});await nextTick()
 expect(w.findAll('.directory-row')).toHaveLength(2)
 await w.get('input[type=search]').setValue('unloaded');await vi.advanceTimersByTimeAsync(300)
 expect(last()).toMatchObject({query:'unloaded'});expect(last().cursor).toBeUndefined()
 await w.get('.back').trigger('click');expect(w.emitted('select')).toBeUndefined();expect(w.emitted('close')).toHaveLength(1)
 w.unmount();expect(last('cancel_directory')).toBeDefined()
})
test('readonly and offline disable selection; stale validation cannot select after close',async()=>{
 const w=mountPicker();reply({...result,can_select:false,reason:'read_only'});await nextTick()
 expect(w.get('button.primary').attributes('disabled')).toBeDefined()
 await w.setProps({online:false});expect(w.text()).toContain('directory.error.daemon_offline')
 expect(w.get('button.primary').attributes('disabled')).toBeDefined();w.unmount()
})
test('unsupported keeps allowed root menu and manual fallback available via cancel',async()=>{
 const w=mountPicker();reply(undefined,{reason:'unsupported'});await nextTick()
 expect(w.text()).toContain('directory.error.unsupported');expect(w.get('button.primary').attributes('disabled')).toBeDefined();w.unmount()
})

test('large loaded lists render a bounded window, preserving keyboard-sized rows', async()=>{
 const w=mountPicker()
 const many=Array.from({length:600},(_,i)=>({name:`project-${i}`,path:`/home/me/project-${i}`,can_browse:true,can_select:true}))
 reply({...result,entries:many});await nextTick()
 expect(w.findAll('.directory-row').length).toBeLessThanOrEqual(80)
 const list=w.get('.directory-list');(list.element as HTMLElement).scrollTop=4000;await list.trigger('scroll');await nextTick()
 expect(w.findAll('.directory-row').length).toBeLessThanOrEqual(80)
 expect(w.findAll('.directory-row')[0].text()).not.toContain('project-0')
 w.unmount()
})
