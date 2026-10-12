import pg from 'pg'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { beforeAll,afterAll,describe,test,expect } from 'vitest'
import { applyMemoryV50Fixture,seedMemoryV50Anomalies,V50_IDS } from '../testing/fixtures/memory-v50.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const enabled=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'
const suite=enabled?describe:describe.skip
suite('read-only governance migration inventory',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemoryV50Fixture(pool,url!);await seedMemoryV50Anomalies(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 function run(command='plan'){return spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../migrations/governance-v2/cli.ts',import.meta.url)),command],{encoding:'utf8',env:{...process.env,MEMORY_MIGRATION_DATABASE_URL:url}})}
 test('counts known historical anomalies without changing data or leaking content',async()=>{
  const before=(await pool.query('SELECT count(*)::int AS n FROM knowledge_versions')).rows[0].n
  const r=run();expect(r.status,r.stderr).toBe(0)
  const m=JSON.parse(r.stdout)
  expect(m.schemaVersion).toBe(50)
  expect(m.counts).toMatchObject({claims:2,versions:3,missingRepository:1,revisionsWithoutEvidence:1,expiredOpenProposals:1})
  expect(m.items).toContainEqual(expect.objectContaining({id:V50_IDS.unknownClaim,reason:'missing_repository',action:'quarantine'}))
  expect(r.stdout).not.toContain('Fixture symbol location');expect(r.stdout).not.toContain('isolated-memory-test')
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions')).rows[0].n).toBe(before)
 })
 test('apply without explicit phase, scope and fingerprint never modifies schema',async()=>{const before=(await pool.query('SELECT version FROM memory_schema_migrations ORDER BY version')).rows;const r=run('apply');expect(r.status).not.toBe(0);expect(r.stderr).toContain('no credentials or source content');expect((await pool.query('SELECT version FROM memory_schema_migrations ORDER BY version')).rows).toEqual(before)})
 test('newer schema is flagged incompatible without schema mutation',async()=>{
  await pool.query('INSERT INTO memory_schema_migrations(version) VALUES(999)')
  try{const r=run();expect(r.status).toBe(0);const m=JSON.parse(r.stdout);expect(m.compatible).toBe(false);expect(m.blockers).toContain('unsupported_schema')}
  finally{await pool.query('DELETE FROM memory_schema_migrations WHERE version=999')}
 })
})
