import {beforeEach,expect,test,vi} from 'vitest'
import {ref} from 'vue'
const user=ref({id:2}),accessToken=ref('token')
let origin='https://relay.test'
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({user,accessToken,doRefreshToken:vi.fn(async()=>false)})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>origin}))
vi.mock('../memoryClient',()=>({resetScopedMemoryAuthorization:vi.fn()}))
import {mutateTeamTaskSelfHolder,findTeamTaskSelfHolder,findTeamTaskRequirements,listTeamTasks,saveTeamTaskRequirements,overrideTeamTaskRequirements,getTeamTaskRequirementHistory} from '../teamClient'
const identity={userId:2,origin:'https://relay.test'}
const input={request_id:'original',expected_revision:7,requirements:{goal:'goal',scope:'',acceptance:'',repository:null}}
beforeEach(()=>{user.value={id:2};origin=identity.origin;vi.unstubAllGlobals()})
test('unknown save outcome replays exact original payload and revision',async()=>{
 const fetch=vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(new Response(JSON.stringify({task:{id:'task',revision:8}})))
 vi.stubGlobal('fetch',fetch)
 await expect(saveTeamTaskRequirements('task',input,identity)).rejects.toMatchObject({status:0})
 await expect(saveTeamTaskRequirements('task',input,identity)).resolves.toMatchObject({revision:8})
 expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify(input))
 expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body)
 expect(fetch.mock.calls[1][1].method).toBe('PUT')
})
test('override is explicit, uses original request and encoded task path',async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({task:{id:'a/b'}})));vi.stubGlobal('fetch',fetch)
 const body={request_id:'override-original',expected_revision:8,reason:'manual confirmation'}
 await overrideTeamTaskRequirements('a/b',body,identity)
 expect(fetch).toHaveBeenCalledWith('https://relay.test/api/team/tasks/a%2Fb/requirements/override',expect.objectContaining({method:'POST',body:JSON.stringify(body)}))
})
test.each(['account','relay','generation'])('blocks %s changes before network',async(change)=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 if(change==='account')user.value={id:3}
 if(change==='relay')origin='https://other.test'
 await expect(saveTeamTaskRequirements('task',input,{...identity,isCurrent:()=>change!=='generation'})).rejects.toMatchObject({code:'request_identity_changed'})
 expect(fetch).not.toHaveBeenCalled()
})
test('history uses revision cursor; pool filters exclude deleted and never supply actor IDs',async()=>{
 const fetch=vi.fn(async(_url:string)=>new Response(JSON.stringify({events:[],next_before_revision:null,tasks:[]})));vi.stubGlobal('fetch',fetch)
 await getTeamTaskRequirementHistory('task',identity,42)
 await listTeamTasks('team')
 await listTeamTasks('team',true,'mine',identity)
 await listTeamTasks('team',false,'unclaimed',identity)
 expect(fetch.mock.calls.map(c=>c[0])).toEqual([
  'https://relay.test/api/team/tasks/task/requirements/history?before_revision=42',
  'https://relay.test/api/team/teams/team/tasks?include_deleted=true',
  'https://relay.test/api/team/teams/team/tasks?pool=mine',
  'https://relay.test/api/team/teams/team/tasks?pool=unclaimed',
 ])
})
test('late successful response cannot acknowledge after account switch',async()=>{
 let finish!:(r:Response)=>void
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve})))
 const pending=saveTeamTaskRequirements('task',input,identity)
 user.value={id:3}
 finish(new Response(JSON.stringify({task:{id:'task',revision:8}})))
 await expect(pending).rejects.toMatchObject({code:'request_identity_changed'})
})
test('invalid cursors are rejected before network',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch)
 for(const cursor of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])await expect(getTeamTaskRequirementHistory('task',identity,cursor)).rejects.toThrow('cursor')
 expect(fetch).not.toHaveBeenCalled()
})

test('original receipt lookup is read only and encodes the original request key',async()=>{
 const result={task_id:'task',actor_user_id:2,kind:'save',request_id:'a/b?c',found:false,response:null}
 const fetch=vi.fn(async()=>new Response(JSON.stringify(result)));vi.stubGlobal('fetch',fetch)
 expect(await findTeamTaskRequirements('task','save','a/b?c',identity)).toEqual(result)
 expect(fetch).toHaveBeenCalledWith('https://relay.test/api/team/tasks/task/requirements/receipt?kind=save&request_id=a%2Fb%3Fc',expect.objectContaining({method:'GET'}))
})

test.each([true,false])('self-holder mutation retains original request after lost response (active=%s)',async(active)=>{
 const fetch=vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(new Response(JSON.stringify({task:{id:'a/b',revision:8}})))
 vi.stubGlobal('fetch',fetch)
 const original={request_id:'holder-original',expected_revision:7}
 await expect(mutateTeamTaskSelfHolder('a/b',active,original,identity)).rejects.toMatchObject({status:0})
 await mutateTeamTaskSelfHolder('a/b',active,original,identity)
 expect(fetch.mock.calls[0][0]).toBe('https://relay.test/api/team/tasks/a%2Fb/holders/self')
 expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify(original))
 expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body)
 expect(fetch.mock.calls[1][1].method).toBe(active?'POST':'DELETE')
})
test('self-holder recovery is read-only, encoded, identity bound and supplies no holder override',async()=>{
 const fetch=vi.fn(async(_url:string,_init?:RequestInit)=>new Response(JSON.stringify({found:false,response:null})));vi.stubGlobal('fetch',fetch)
 await findTeamTaskSelfHolder('a/b','original/key',identity)
 expect(fetch.mock.calls[0][0]).toBe('https://relay.test/api/team/tasks/a%2Fb/holders/self/receipt?request_id=original%2Fkey')
 expect(fetch.mock.calls[0][1]).toMatchObject({method:'GET'})
 expect(fetch.mock.calls[0][1]?.body).toBeUndefined()
 user.value={id:3}
 await expect(findTeamTaskSelfHolder('a/b','original/key',identity)).rejects.toMatchObject({code:'request_identity_changed'})
 expect(fetch).toHaveBeenCalledTimes(1)
})
