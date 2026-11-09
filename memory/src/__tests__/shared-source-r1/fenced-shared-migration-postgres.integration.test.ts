import pg from 'pg'
import{beforeAll,afterAll,describe,test,expect}from'vitest'
import{directLaunchFixture}from'./direct-launch-fixture.js'
import{applySharedSourceContract}from'../../migrations/shared-db/contract.js'
import{provisionSharedDatabase}from'../../migrations/shared-db/namespace.js'
import{assertTeamSemanticLegacyFunction}from'../../migrations/shared-db/team-semantic-contract.js'
const url=process.env.FENCED_SHARED_MIGRATION_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('explicit shared migration while the original runtime is fenced',()=>{
 let f:Awaited<ReturnType<typeof directLaunchFixture>>
 const roles={memoryRole:'direct_launch_memory',relayRole:'direct_launch_relay',migratorRole:'direct_launch_definer'}
 beforeAll(async()=>{if(!url)throw Error('dedicated_fixture_required');const admin=new URL(url);admin.username='postgres';admin.password='synthetic-only';process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL=admin.href;f=await directLaunchFixture(url);await f.runtime.end();await f.pool.query('ALTER ROLE direct_launch_memory NOLOGIN')},60000)
 afterAll(async()=>{await f?.publisher.end();await f?.pool.end();delete process.env.DIRECT_LAUNCH_FIXTURE_ADMIN_DATABASE_URL})
 test('keeps the normal assertion strict but upgrades with an explicitly fenced real runtime',async()=>{
  await expect(assertTeamSemanticLegacyFunction(f.pool)).rejects.toThrow('team_semantic_legacy_function_incompatible')
  await applySharedSourceContract(f.pool,{fencedMemoryRuntimeRole:roles.memoryRole} as never)
  await(provisionSharedDatabase as any)(f.pool,roles,{fencedMemoryRuntime:true})
  expect((await f.pool.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='direct_launch_memory'")).rows[0].rolcanlogin).toBe(false)
 })
 test('a LOGIN role is not an explicitly fenced migration runtime',async()=>{
  await f.pool.query('ALTER ROLE direct_launch_memory LOGIN')
  try{await expect(applySharedSourceContract(f.pool,{fencedMemoryRuntimeRole:roles.memoryRole} as never)).rejects.toThrow('fenced_maintenance_runtime_required')}finally{await f.pool.query('ALTER ROLE direct_launch_memory NOLOGIN')}
 })
 test('NOLOGIN alone cannot hide an existing runtime writer connection',async()=>{
  await f.pool.query('ALTER ROLE direct_launch_memory LOGIN');const u=new URL(url!);u.username=roles.memoryRole;u.password='synthetic-only';const runtime=new pg.Client({connectionString:u.href});await runtime.connect();await runtime.query('SELECT 1');await f.pool.query('ALTER ROLE direct_launch_memory NOLOGIN')
  try{await expect(applySharedSourceContract(f.pool,{fencedMemoryRuntimeRole:roles.memoryRole} as never)).rejects.toThrow('target_memory_not_drained')}finally{await runtime.end()}
 })
})
