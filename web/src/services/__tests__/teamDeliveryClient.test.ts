import { beforeEach,afterEach,expect,test,vi } from 'vitest'
import { ref } from 'vue'
import { webcrypto,createHash } from 'node:crypto'
const accessToken=ref('fixture'),user=ref({id:1}),origin=ref(''),refresh=vi.fn(async()=>false)
vi.mock('../../composables/useAuth',()=>({useAuth:()=>({accessToken,user,doRefreshToken:refresh})}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=>origin.value}))
import {listDeliveryInbox,decideTaskDelivery,readDeliveryArtifact,getDeliveryReceipt,readTrustedEvidence} from '../teamDeliveryClient'
const artifact={id:'file',name:'proof.md',mime_type:'text/markdown',required:true,byte_size:5,sha256:createHash('sha256').update('proof').digest('hex')}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);user.value={id:1};origin.value='';refresh.mockReset().mockResolvedValue(false)})
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()})
test('receipt lookup is read-only and encodes the original task and request',async()=>{
 const fetchMock=vi.fn(async(_url:RequestInfo|URL,_options?:RequestInit)=>new Response(JSON.stringify({task_id:'task / one',request_id:'key / two',found:false,receipt:null})))
 vi.stubGlobal('fetch',fetchMock)
 await expect(getDeliveryReceipt('task / one','key / two')).resolves.toMatchObject({found:false,receipt:null})
 expect(String(fetchMock.mock.calls[0][0])).toContain('/api/team/tasks/task%20%2F%20one/delivery/receipt-lookup/key%20%2F%20two')
 expect(fetchMock.mock.calls[0][1]?.method??'GET').toBe('GET');expect(fetchMock).toHaveBeenCalledTimes(1)
})
test.each(['account','relay'])('401 refresh changing %s cannot replay an old delivery mutation',async(kind)=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:401})))
 refresh.mockImplementationOnce(async()=>{if(kind==='account')user.value={id:2};else origin.value='https://other.invalid';return true})
 await expect(decideTaskDelivery('task',{request_id:'key',expected_revision:2,submission_id:'s',spec_revision:1,decision:'accepted',reason:'',verified_checks:[]},{userId:1,origin:''})).rejects.toMatchObject({code:'request_identity_changed'})
 expect(fetch).toHaveBeenCalledTimes(1)
})
test('binary attachment must match both immutable size and SHA-256',async()=>{
 const response=new Response('proof');vi.stubGlobal('fetch',vi.fn(async()=>response))
 expect(await (await readDeliveryArtifact('task','submission',artifact)).text()).toBe('proof')
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('other')))
 await expect(readDeliveryArtifact('task','submission',artifact)).rejects.toMatchObject({code:'artifact_integrity'})
})
test('an expired write returns unknown network status without replaying a mutation automatically',async()=>{
 vi.useFakeTimers()
 const fetchMock=vi.fn((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')))))
 vi.stubGlobal('fetch',fetchMock)
 const result=decideTaskDelivery('task',{request_id:'same-key',expected_revision:2,submission_id:'submission',spec_revision:1,decision:'accepted',reason:'',verified_checks:[]})
 const assertion=expect(result).rejects.toMatchObject({status:0,code:'network_error'})
 await vi.advanceTimersByTimeAsync(30000);await assertion
 expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('a truncated successful response remains unknown instead of confirming the decision',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"decision_id":', {status:200})))
 await expect(decideTaskDelivery('task',{request_id:'same-key',expected_revision:2,submission_id:'submission',spec_revision:1,decision:'accepted',reason:'',verified_checks:[]})).rejects.toMatchObject({status:0,code:'network_error'})
})

test('trusted report identity is encoded and bytes require SHA and valid UTF-8',async()=>{
 const evidence={evidence_id:'report/id',report_sha256:artifact.sha256} as any
 const fetchMock=vi.fn(async(_url:RequestInfo|URL)=>new Response('proof'));vi.stubGlobal('fetch',fetchMock)
 expect(await readTrustedEvidence('task/one',evidence)).toBe('proof');expect(String(fetchMock.mock.calls[0][0])).toContain('/api/team/tasks/task%2Fone/trusted-evidence/report%2Fid/report')
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('tampered')));await expect(readTrustedEvidence('task',evidence)).rejects.toThrow('校验失败')
 const invalid=new Uint8Array([255]);vi.stubGlobal('fetch',vi.fn(async()=>new Response(invalid)))
 await expect(readTrustedEvidence('task',{...evidence,report_sha256:createHash('sha256').update(invalid).digest('hex')})).rejects.toThrow()
})

test('step Inbox opts in and retains root reminders on an older strict Relay',async()=>{
 const mock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'invalid_request'}}),{status:400})).mockResolvedValueOnce(new Response(JSON.stringify({items:[]})))
 vi.stubGlobal('fetch',mock)
 await expect(listDeliveryInbox()).resolves.toEqual({items:[]})
 expect(String(mock.mock.calls[0][0])).toContain('/delivery-inbox?include_steps=true')
 expect(String(mock.mock.calls[1][0])).toMatch(/\/delivery-inbox$/)
})
test('step Inbox does not hide permission failures with a root retry',async()=>{
 const mock=vi.fn(async()=>new Response(JSON.stringify({error:{code:'permission_denied'}}),{status:403}));vi.stubGlobal('fetch',mock)
 await expect(listDeliveryInbox()).rejects.toMatchObject({status:403});expect(mock).toHaveBeenCalledTimes(1)
})
