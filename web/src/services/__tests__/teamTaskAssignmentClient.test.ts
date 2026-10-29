import {beforeEach,afterEach,expect,test,vi} from 'vitest'
const state=vi.hoisted(()=>({user:{value:{id:2}},accessToken:{value:'token'},origin:'',refresh:vi.fn()}))
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user:state.user,accessToken:state.accessToken,doRefreshToken:state.refresh})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>state.origin}))
import {assignTeamTask,findTeamTaskAssignment} from '../teamClient'
const input={request_id:'original',instruction:'goal',acceptance:'proof',target_offer_ids:['offer'],context_version:4}
beforeEach(()=>{vi.clearAllMocks();state.user.value={id:2};state.origin='';state.refresh.mockResolvedValue(true)})
afterEach(()=>vi.unstubAllGlobals())
test('receipt lookup encodes both path identities and treats explicit absence as data',async()=>{
 const fetch=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(JSON.stringify({operation:'assign_task',request_id:'key / ?',team_session_id:'s / ?',found:false,response:null})));vi.stubGlobal('fetch',fetch)
 expect((await findTeamTaskAssignment('s / ?','key / ?',{userId:2,origin:''})).found).toBe(false)
 expect(fetch.mock.calls[0]?.[0]).toBe('/api/team/sessions/s%20%2F%20%3F/tasks/by-request/key%20%2F%20%3F')
})
test('token refresh for the same actor reuses the identical request body',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(new Response('{}',{status:401})).mockResolvedValueOnce(new Response('{}'));vi.stubGlobal('fetch',fetch)
 await assignTeamTask('s',input,{userId:2,origin:''});expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body)
})
test('refresh switching account cannot replay the old assignment with the new actor',async()=>{
 const fetch=vi.fn(async()=>new Response('{}',{status:401}));vi.stubGlobal('fetch',fetch);state.refresh.mockImplementation(async()=>{state.user.value={id:3};return true})
 await expect(assignTeamTask('s',input,{userId:2,origin:''})).rejects.toMatchObject({code:'request_identity_changed'});expect(fetch).toHaveBeenCalledTimes(1)
})
test('refresh switching Relay cannot send the old assignment to a new destination',async()=>{
 const fetch=vi.fn(async()=>new Response('{}',{status:401}));vi.stubGlobal('fetch',fetch);state.refresh.mockImplementation(async()=>{state.origin='https://other.test';return true})
 await expect(assignTeamTask('s',input,{userId:2,origin:''})).rejects.toMatchObject({code:'request_identity_changed'});expect(fetch).toHaveBeenCalledTimes(1)
})
test('an already changed identity is rejected before any network request',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 await expect(assignTeamTask('s',input,{userId:1,origin:''})).rejects.toMatchObject({code:'request_identity_changed'});expect(fetch).not.toHaveBeenCalled()
})

test('invalidated operation lifetime prevents 401 refresh even after account A-B-A',async()=>{
 let active=true
 const fetch=vi.fn(async()=>{state.user.value={id:3};active=false;state.user.value={id:2};return new Response('{}',{status:401})});vi.stubGlobal('fetch',fetch)
 await expect(assignTeamTask('s',input,{userId:2,origin:'',isCurrent:()=>active})).rejects.toMatchObject({code:'request_identity_changed'})
 expect(state.refresh).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(1)
})
test('invalidation during token refresh prevents mutation replay with unchanged actor and Relay',async()=>{
 let active=true;const fetch=vi.fn(async()=>new Response('{}',{status:401}));vi.stubGlobal('fetch',fetch)
 state.refresh.mockImplementation(async()=>{active=false;return true})
 await expect(assignTeamTask('s',input,{userId:2,origin:'',isCurrent:()=>active})).rejects.toMatchObject({code:'request_identity_changed'});expect(fetch).toHaveBeenCalledTimes(1)
})
test('a still-current operation can refresh and replay exactly the original body',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(new Response('{}',{status:401})).mockResolvedValueOnce(new Response('{}'));vi.stubGlobal('fetch',fetch)
 await assignTeamTask('s',input,{userId:2,origin:'',isCurrent:()=>true});expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body)
})
