import pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {writeFileSync} from 'node:fs'
import {applyMemoryV50Fixture} from '../testing/fixtures/memory-v50.js'
import {seedMemoryV50UpgradeScenarios} from '../testing/fixtures/memory-v50-upgrade.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {measureInventoryRecovery} from '../testing/measure-inventory-recovery.js'
import {inventoryMemory} from '../migrations/governance-v2/inventory.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('inventory backup/restore measurement on disposable fixture only',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await applyMemoryV50Fixture(pool,url!);await seedMemoryV50UpgradeScenarios(pool,url!)},60000)
 afterAll(async()=>{await pool?.end()})
 test('measures actual pg_dump/pg_restore and preserves complete fixture data including privacy markers',async()=>{
  const before=await inventoryMemory(pool),measurement=await measureInventoryRecovery(pool,url!)
  expect(measurement.backupBytes).toBeGreaterThan(0);expect(measurement.schemaVersion).toBe(50)
  expect(measurement.beforeDigest).toMatch(/^[a-f0-9]{64}$/);expect(measurement.afterDigest).toBe(measurement.beforeDigest)
  expect((await inventoryMemory(pool)).counts).toEqual(before.counts)
  if(process.env.MEMORY_UPGRADE_SUITE==='memory-pg')writeFileSync('/reports/inventory-recovery.json',JSON.stringify({measurement,inventoryQueryMs:before.queryElapsedMs,fixtureCounts:before.counts,tableBytes:before.tableBytes,productionEstimate:false},null,2))
 },60000)
 test('refuses a business target before executing backup or restore and never echoes credentials',async()=>{
  await expect(measureInventoryRecovery(pool,'postgresql://business:DO_NOT_PRINT@127.0.0.1/business')).rejects.toThrow('isolated_upgrade_database_required')
 })
})
