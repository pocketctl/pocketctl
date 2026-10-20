import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useShareLinks } from '../useShareLinks'
import { shareLinksAPI } from '../../services/shareLinks'
vi.mock('../useAuth',()=>({useAuth:()=>({user:ref({id:7})})}))
vi.mock('../useEnv',()=>({getRelayOrigin:()=> 'https://relay.test'}))
vi.mock('../../services/shareLinks',()=>({shareLinksAPI:{list:vi.fn(),create:vi.fn(),get:vi.fn(),url:vi.fn(),revoke:vi.fn()},ShareAPIError:class extends Error{constructor(public status:number){super()}}}))
const expiry=new Date(Date.now()+900000).toISOString()
const link={id:'11111111-1111-4111-8111-111111111111',session_id:'s1',title:'Example',created_at:new Date().toISOString(),expires_at:expiry,status:'active' as const,server_time:new Date().toISOString()}
const wrappers:ReturnType<typeof mount>[]=[]
function setup(){let state!:ReturnType<typeof useShareLinks>;const session=ref<string|undefined>('s1');const wrapper=mount(defineComponent({setup(){state=useShareLinks(session);return()=>null}}));wrappers.push(wrapper);return {state,wrapper,session}}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();vi.mocked(shareLinksAPI.list).mockResolvedValue({links:[link],server_time:link.server_time});Object.defineProperty(navigator,'clipboard',{value:{writeText:vi.fn().mockResolvedValue(undefined)},configurable:true})})
afterEach(()=>{wrappers.splice(0).forEach(w=>w.unmount());vi.useRealTimers()})
test('opening/reopening and copying reuses the selected authorization without creation or renewal',async()=>{
 const {state,wrapper}=setup();await flushPromises();expect(state.selected.value?.id).toBe(link.id);expect(shareLinksAPI.create).not.toHaveBeenCalled()
 vi.mocked(shareLinksAPI.url).mockResolvedValue({...link,url:'https://relay.test/share/session/token'});await state.copy(link)
 expect(shareLinksAPI.url).toHaveBeenCalledWith(link.id);expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://relay.test/share/session/token');expect(state.selected.value?.expires_at).toBe(expiry)
 wrapper.unmount();setup();await flushPromises();expect(shareLinksAPI.create).not.toHaveBeenCalled()
})
test('ambiguous creation persists its original request ID across closing and retries only that ID',async()=>{
 const {state,wrapper}=setup();await flushPromises();vi.mocked(shareLinksAPI.create).mockRejectedValueOnce(new Error('timeout'));await state.mutate('create');const id=state.pending.value!.id
 expect(id).toMatch(/^[\da-f-]{36}$/);wrapper.unmount();const reopened=setup().state;await flushPromises();expect(reopened.pending.value?.id).toBe(id)
 vi.mocked(shareLinksAPI.create).mockResolvedValue({...link,url:'https://relay.test/share/session/token'});await reopened.reconcile();expect(shareLinksAPI.create).toHaveBeenNthCalledWith(2,'s1',id);expect(reopened.pending.value).toBeNull()
})
test('unknown revoke preserves the row and blocks copy until status is confirmed',async()=>{
 const {state}=setup();await flushPromises();vi.mocked(shareLinksAPI.revoke).mockRejectedValueOnce(new Error('offline'));await state.mutate('revoke',link.id)
 expect(state.links.value).toHaveLength(1);await state.copy(link);expect(shareLinksAPI.url).not.toHaveBeenCalled()
 vi.mocked(shareLinksAPI.get).mockResolvedValue({...link,status:'revoked'});vi.mocked(shareLinksAPI.list).mockResolvedValue({links:[],server_time:link.server_time});await state.reconcile();expect(state.links.value).toHaveLength(0);expect(state.pending.value).toBeNull()
})
test('server time removes expired links even when the device clock is behind',async()=>{
 vi.mocked(shareLinksAPI.list).mockResolvedValue({links:[link],server_time:new Date(Date.parse(expiry)+1000).toISOString()});const {state}=setup();await flushPromises();expect(state.links.value).toHaveLength(0)
})
test('an in-flight response cannot replace another session or write to its pending storage',async()=>{
 const {state,session}=setup();await flushPromises();let finish!:(value:typeof link)=>void;vi.mocked(shareLinksAPI.create).mockImplementation(()=>new Promise(resolve=>{finish=resolve}));const operation=state.mutate('create');session.value='s2';await flushPromises();finish(link);await operation
 expect(state.pending.value).toBeNull();expect(localStorage.getItem('pocketctl:pending-share:https://relay.test:7:s1')).not.toBeNull();expect(localStorage.getItem('pocketctl:pending-share:https://relay.test:7:s2')).toBeNull()
})
