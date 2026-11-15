import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test,vi} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from '../__tests__/shared-source-r1/direct-launch-fixture.js'
import {applyPlatformStatisticsSchema,initializePlatformStatistics} from './schema.js'
import {recordFirstClaim} from './service.js'
import {randomUUID} from 'node:crypto'
const url=process.env.STATISTICS_SHARED_TEST_DATABASE_URL

describe.skipIf(!url)('statistics on the shared database with runtime roles',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!)},60000)
 afterAll(async()=>{vi.unstubAllEnvs();await f?.close()})
 test('requires migration, then collects and revokes without granting runtime DDL',async()=>{
  vi.stubEnv('PLATFORM_STATS_ENABLED','true')
  await expect(initializePlatformStatistics(f.runtime,{role:'worker',namespace:'memory'})).rejects.toThrow('platform_statistics_migrator_required')
  const migrator=new pg.Pool({connectionString:process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL,
    options:'-c role=direct_launch_definer -c search_path=pg_catalog,memory,shared',max:1})
  try{await applyPlatformStatisticsSchema(migrator,'memory')}finally{await migrator.end()}
  const stop=await initializePlatformStatistics(f.runtime,{role:'worker',namespace:'memory'})
  try{
   const source=await f.source(),id=(await f.install(source,'from_now')).inst.installation_id
   const client=await f.runtime.connect()
   try{await client.query('BEGIN');await recordFirstClaim(client,{installationId:id,claimId:randomUUID(),source:'manual'});await client.query('COMMIT')}finally{client.release()}
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM memory_platform_stats_claims WHERE installation_id=$1',[id])).rows[0].n).toBe(1)
   vi.stubEnv('PLATFORM_STATS_ENABLED','false')
   await f.runtime.query("UPDATE memory_installations SET local_status='purging' WHERE installation_id=$1",[id])
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM memory_platform_stats_claims WHERE installation_id=$1',[id])).rows[0].n).toBe(0)
   expect((await f.runtime.query("SELECT has_schema_privilege(current_user,'memory','CREATE') AS allowed")).rows[0].allowed).toBe(false)
   await expect(f.runtime.query('CREATE TABLE memory.runtime_statistics_forbidden(id int)')).rejects.toMatchObject({code:'42501'})
  }finally{stop()}
 },30000)
})
