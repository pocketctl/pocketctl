import {expect,test,vi} from 'vitest'
import {ensurePlatformStatisticsSchema} from './schema.js'
test('shared runtime verifies statistics without DDL',async()=>{
 const query=vi.fn(async(sql:string)=>{
  if(/CREATE|DROP|ALTER/.test(sql))throw Error('runtime_ddl_forbidden')
  return {rows:[{ready:true,present:true}],rowCount:1}
 })
 await ensurePlatformStatisticsSchema({query} as any,{PLATFORM_STATS_ENABLED:'true',RELAY_SCHEMA_STARTUP:'verify'})
 expect(query.mock.calls.some(([sql])=>/CREATE|DROP|ALTER/.test(sql))).toBe(false)
})
