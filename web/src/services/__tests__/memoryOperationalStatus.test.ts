import {afterEach,beforeEach,expect,test,vi} from 'vitest'
const auth=vi.hoisted(()=>({accessToken:{value:'old-token'},doRefreshToken:vi.fn()}))
vi.mock('../../composables/useAuth',()=>({useAuth:()=>auth}))
vi.mock('../../composables/useEnv',()=>({getRelayOrigin:()=> 'https://relay.example'}))
import {readMemoryOperationalStatus} from '../memoryOperationalStatus'
const row={installation_id:'one',state:'ready',last_error_code:null}
beforeEach(()=>{vi.useFakeTimers();auth.accessToken.value='old-token';auth.doRefreshToken.mockReset()})
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
test('401 refreshes token once and retries with current token',async()=>{
 const request=vi.fn().mockResolvedValueOnce(new Response('',{status:401})).mockResolvedValueOnce(Response.json({installations:[row]}))
 vi.stubGlobal('fetch',request)
 auth.doRefreshToken.mockImplementation(async()=>{auth.accessToken.value='new-token';return true})
 expect(await readMemoryOperationalStatus('one')).toEqual(row)
 expect(auth.doRefreshToken).toHaveBeenCalledTimes(1)
 expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer new-token')
})
test('a second 401 does not repeat auth refresh',async()=>{
 const request=vi.fn().mockResolvedValue(new Response('',{status:401}));vi.stubGlobal('fetch',request)
 auth.doRefreshToken.mockResolvedValue(true)
 await expect(readMemoryOperationalStatus('one')).rejects.toThrow('memory_status_unavailable')
 expect(auth.doRefreshToken).toHaveBeenCalledTimes(1);expect(request).toHaveBeenCalledTimes(2)
})
test('hanging fetch times out and aborts even when transport ignores abort',async()=>{
 const request=vi.fn((_input: RequestInfo | URL, _init?: RequestInit)=>new Promise(()=>{}));vi.stubGlobal('fetch',request)
 const result=expect(readMemoryOperationalStatus('one')).rejects.toThrow('memory_status_unavailable')
 await vi.advanceTimersByTimeAsync(10000);await result
 expect(request.mock.calls[0]![1]!.signal!.aborted).toBe(true)
})
test('hanging auth refresh shares timeout and cannot dispatch a late retry',async()=>{
 const request=vi.fn().mockResolvedValue(new Response('',{status:401}));vi.stubGlobal('fetch',request)
 let finish!:(value:boolean)=>void
 auth.doRefreshToken.mockImplementation(()=>new Promise<boolean>(resolve=>{finish=resolve}))
 const result=expect(readMemoryOperationalStatus('one')).rejects.toThrow('memory_status_unavailable')
 await vi.advanceTimersByTimeAsync(10000);await result
 finish(true);await Promise.resolve();await Promise.resolve()
 expect(request).toHaveBeenCalledTimes(1)
})

test('a late 401 after timeout does not start auth refresh',async()=>{
 let finish!:(value:Response)=>void
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve})))
 const result=expect(readMemoryOperationalStatus('one')).rejects.toThrow('memory_status_unavailable')
 await vi.advanceTimersByTimeAsync(10000);await result
 finish(new Response('',{status:401}));await Promise.resolve();await Promise.resolve()
 expect(auth.doRefreshToken).not.toHaveBeenCalled()
})
test('failed auth refresh does not retry a rejected request',async()=>{
 const request=vi.fn().mockResolvedValue(new Response('',{status:401}));vi.stubGlobal('fetch',request)
 auth.doRefreshToken.mockResolvedValue(false)
 await expect(readMemoryOperationalStatus('one')).rejects.toThrow('memory_status_unavailable')
 expect(request).toHaveBeenCalledTimes(1)
})
