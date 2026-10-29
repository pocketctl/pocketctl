import {beforeEach,afterEach,expect,test,vi} from 'vitest'
const context=vi.hoisted(()=>({user:{value:{id:1}},accessToken:{value:'relay-secret'},origin:'https://relay.example'}))
vi.mock('../../composables/useAuth',()=>({useAuth:()=>context}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>context.origin}))
import {readDeliveryMemoryStatus} from '../teamDeliveryMemoryClient'
const fetchMock=vi.fn(),scope={userId:1,origin:'https://relay.example',isCurrent:()=>true}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status})
function discovery(){return json({installations:[{installation_id:'team-install',provider_id:'pocketctl-memory',owner_scope_kind:'team',status:'active',enabled_services:['memory.manage']},{installation_id:'personal-install',provider_id:'pocketctl-memory',status:'active',enabled_services:['memory.manage']}]})}
function grant(){return json({grant:'memory-capability',provider_public_origin:'https://memory.example'})}
beforeEach(()=>{context.user.value={id:1};context.accessToken.value='relay-secret';context.origin='https://relay.example';vi.stubGlobal('fetch',fetchMock);fetchMock.mockReset()})
afterEach(()=>vi.unstubAllGlobals())
test('uses personal installation and exact IDs with only the provider capability crossing origins',async()=>{
 fetchMock.mockResolvedValueOnce(discovery()).mockResolvedValueOnce(grant()).mockResolvedValueOnce(json({source:null}))
 expect(await readDeliveryMemoryStatus('task','sub/id','decision id',scope)).toEqual({source:null})
 expect(fetchMock.mock.calls[1][1].body).toBe(JSON.stringify({installation_id:'personal-install',caller_type:'web',services:['memory.manage']}))
 expect(fetchMock.mock.calls[2][0]).toBe('https://memory.example/api/v1/memory/delivery-sources/sub%2Fid/decisions/decision%20id')
 expect(fetchMock.mock.calls[2][1]).toMatchObject({headers:{Authorization:'Bearer memory-capability'},credentials:'omit',redirect:'error',cache:'no-store'})
 expect(JSON.stringify(fetchMock.mock.calls[2])).not.toContain('relay-secret')
})
test.each(['account','relay','token','unmounted'])('late discovery after %s changes cannot mint a grant or reach Memory',async change=>{
 let resolve!:(r:Response)=>void,current=true;fetchMock.mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
 const result=readDeliveryMemoryStatus('task','sub','decision',{...scope,isCurrent:()=>current})
 if(change==='account')context.user.value={id:2}
 if(change==='relay')context.origin='https://other.example'
 if(change==='token')context.accessToken.value='new-token'
 if(change==='unmounted')current=false
 resolve(discovery());await expect(result).rejects.toThrow('读取范围已变化')
 expect(fetchMock).toHaveBeenCalledTimes(1)
})
test('does not auto-enable missing manage service',async()=>{
 fetchMock.mockResolvedValueOnce(json({installations:[]}))
 await expect(readDeliveryMemoryStatus('task','sub','decision',scope)).rejects.toThrow('尚未启用')
 expect(fetchMock).toHaveBeenCalledTimes(1)
})
test('refreshes a provider 401 once and rejects a mismatched source identity',async()=>{
 fetchMock.mockResolvedValueOnce(discovery()).mockResolvedValueOnce(grant()).mockResolvedValueOnce(json({},401))
 .mockResolvedValueOnce(grant()).mockResolvedValueOnce(json({source:{task_id:'wrong'}}))
 await expect(readDeliveryMemoryStatus('task','sub','decision',scope)).rejects.toThrow('来源身份或状态不匹配')
 expect(fetchMock).toHaveBeenCalledTimes(5)
})

test('bounds an unresponsive provider read and propagates cancellation', async () => {
 vi.useFakeTimers()
 try {
  fetchMock.mockResolvedValueOnce(discovery()).mockResolvedValueOnce(grant())
   .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
   }))
  const request = readDeliveryMemoryStatus('task', 'sub', 'decision', scope)
  const rejected = expect(request).rejects.toThrow('读取超时或已中断')
  await vi.advanceTimersByTimeAsync(15000)
  await rejected
 } finally { vi.useRealTimers() }
})
