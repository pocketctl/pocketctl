import {afterEach,expect,test,vi} from 'vitest'
import {initializePlatformStatistics} from './schema.js'
afterEach(()=>vi.unstubAllEnvs())
test('shared runtime starts collectors without DDL',async()=>{
 vi.stubEnv('PLATFORM_STATS_ENABLED','true')
 const query=vi.fn(async(sql:string)=>{
  if(/CREATE|DROP|ALTER/.test(sql))throw Error('runtime_ddl_forbidden')
  return {rows:[{ready:true}],rowCount:1}
 })
 const client={query,release:vi.fn()},pool={query,connect:async()=>client}
 const stop=await initializePlatformStatistics(pool as any,{role:'worker',namespace:'memory'} as any)
 stop()
 expect(query.mock.calls.some(([sql])=>sql.includes('memory_platform_stats_collectors'))).toBe(true)
 expect(query.mock.calls.some(([sql])=>/CREATE|DROP|ALTER/.test(sql))).toBe(false)
})
