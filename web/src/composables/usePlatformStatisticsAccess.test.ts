import {afterEach,expect,test,vi} from 'vitest'
import {ref,nextTick} from 'vue'
import {createPlatformStatisticsAccess} from './usePlatformStatisticsAccess'
import {PlatformStatisticsError} from '../services/platformStatistics'
afterEach(()=>vi.restoreAllMocks())
test('switch identity clears permission immediately and ignores late previous owner response',async()=>{
 const identity=ref('one');let finish!:(v:{allowed:boolean})=>void
 const access=createPlatformStatisticsAccess(identity,()=>new Promise(r=>{finish=r}))
 const pending=access.refresh();identity.value='two';await nextTick()
 expect(access.allowed.value).toBe(false);finish({allowed:true});await pending
 expect(access.allowed.value).toBe(false)
})
test('403 removes a previous allowed result; temporary refresh failure preserves only matching identity',async()=>{
 const identity=ref('one'),load=vi.fn().mockResolvedValue({allowed:true});const access=createPlatformStatisticsAccess(identity,load)
 await access.refresh();load.mockRejectedValue(new Error('offline'));await access.refresh();expect(access.allowed.value).toBe(true)
 load.mockRejectedValue(new PlatformStatisticsError(403,'forbidden'));await access.refresh();expect(access.allowed.value).toBe(false);expect(access.status.value).toBe('denied')
})
