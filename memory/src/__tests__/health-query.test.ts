import {test,expect,vi} from 'vitest'
import {queryHealth} from '../reporting/health-query.js'
test('bounds pool checkout and returns a late connection without leaking it',async()=>{
 let resolve!:(c:any)=>void
 const release=vi.fn(),query=vi.fn()
 const result=queryHealth({query,connect:()=>new Promise<any>(r=>{resolve=r})} as never,'SELECT 1',{checkoutTimeoutMs:10})
 await expect(result).rejects.toThrow('health_checkout_timeout')
 resolve({release,query});await new Promise(r=>setTimeout(r,0))
 expect(release).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled()
})
