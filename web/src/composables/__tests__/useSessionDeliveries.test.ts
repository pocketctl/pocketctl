import { mount,flushPromises } from '@vue/test-utils'
import { defineComponent,ref } from 'vue'
import { beforeEach,afterEach,expect,test,vi } from 'vitest'
import { TeamApiError } from '../../services/teamClient'
const api=vi.hoisted(()=>({getSessionDeliveryCards:vi.fn()}))
const cache=vi.hoisted(()=>({read:vi.fn(),write:vi.fn(),purge:vi.fn(),ticket:()=>1}))
vi.mock('../../services/teamDeliveryClient',()=>api)
vi.mock('../../services/teamDeliveryCache',()=>({teamDeliveryCache:cache,deliveryCacheScope:(user:number,origin:string)=>JSON.stringify([origin,user])}))
const user=ref({id:1})
vi.mock('../useAuth',()=>({useAuth:()=>({user})}))
import { useSessionDeliveries } from '../useSessionDeliveries'
const page=(session='session',ids=['task'],cursor:string|null=null)=>({team_id:'team',team_session_id:session,items:ids.map(task_id=>({task_id,title:task_id})),next_cursor:cursor})
const wrappers:Array<ReturnType<typeof mount>>=[]
function render(){const session=ref('session'),team=ref('team');let state!:ReturnType<typeof useSessionDeliveries>;const w=mount(defineComponent({setup(){state=useSessionDeliveries(session,team);return()=>null}}));wrappers.push(w);return {state,session,w}}
beforeEach(()=>{vi.resetAllMocks();user.value={id:1};cache.read.mockResolvedValue(null);cache.write.mockResolvedValue(undefined);cache.purge.mockResolvedValue(undefined);api.getSessionDeliveryCards.mockResolvedValue(page())})
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.useRealTimers()})
test('reload reads durable cards and pagination merges without duplicate tasks',async()=>{
 api.getSessionDeliveryCards.mockImplementation(async(_s,after)=>after?page('session',['task','next'],null):page('session',['task'],'task'))
 const {state}=render();await flushPromises();expect(state.items.value.map(i=>i.task_id)).toEqual(['task']);expect(state.more.value).toBe(true);await state.loadMore();expect(state.items.value.map(i=>i.task_id)).toEqual(['task','next']);expect(state.more.value).toBe(false)
})
test('transient offline keeps stored cards; membership revocation clears and purges',async()=>{
 cache.read.mockResolvedValue({data:page(),at:1});api.getSessionDeliveryCards.mockRejectedValueOnce(new TeamApiError(0,{error:{message:'offline'}}));const {state}=render();await flushPromises();expect(state.items.value).toHaveLength(1);expect(state.cached.value).toBe(true)
 api.getSessionDeliveryCards.mockRejectedValueOnce(new TeamApiError(404,{error:{code:'team_not_found',message:'revoked'}}));await state.refresh();expect(state.items.value).toEqual([]);expect(cache.purge).toHaveBeenCalledWith(expect.any(String),{session:'session'})
})
test('a late page from the prior session does not pollute the new view or cache',async()=>{
 let finish!:(v:unknown)=>void;api.getSessionDeliveryCards.mockReturnValueOnce(new Promise(r=>finish=r));const {state,session}=render();await flushPromises();api.getSessionDeliveryCards.mockResolvedValue(page('next',['next-task']));session.value='next';await flushPromises();finish(page('session',['secret']));await flushPromises();expect(state.items.value.map(i=>i.task_id)).toEqual(['next-task']);expect(cache.write.mock.calls.every(c=>c[2]==='next')).toBe(true)
})
test('external revocation cancels delayed reads and clears account-visible cards',async()=>{
 const {state}=render();await flushPromises();let finish!:(v:unknown)=>void;api.getSessionDeliveryCards.mockReturnValueOnce(new Promise(r=>finish=r));const work=state.refresh();window.dispatchEvent(new CustomEvent('team-delivery-cache-revoked',{detail:{team:'team'}}));finish(page());await work;expect(state.items.value).toEqual([]);expect(state.available.value).toBe(false)
})
test('a missing route on an older Relay hides the optional cards without treating it as revocation',async()=>{
 api.getSessionDeliveryCards.mockRejectedValueOnce(new TeamApiError(404,{error:{code:'request_failed'}}));const {state}=render();await flushPromises();expect(cache.purge).not.toHaveBeenCalled();expect(state.error.value).toBe('')
})
