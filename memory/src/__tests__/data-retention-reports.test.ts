import {afterEach,beforeEach,describe,expect,test,vi} from 'vitest'
import {mkdtemp,realpath,writeFile,readFile,readdir,utimes,rm,symlink,lstat} from 'node:fs/promises'
import {tmpdir,hostname} from 'node:os'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import type pg from 'pg'
vi.mock('../migrations/governance-v2/inventory.js',()=>({inventoryMemory:vi.fn(async(_pool,options)=>{
 await options.onFindingBatch([{entityKind:'event',recordId:'opaque-id',reason:'fixture'}]);return {schemaVersion:72,compatible:true,counts:{events:1},findingCounts:{unproven:1},tableBytes:{events:10},environmentFingerprint:'hash'}
})}))
import {createManagedInventoryReport,retainInventoryReports} from '../retention/reports.js'

describe('managed inventory report retention',()=>{
 let dir:string,pool:pg.Pool
 beforeEach(async()=>{dir=await realpath(await mkdtemp(join(tmpdir(),'memory-retention-reports-')));pool={query:vi.fn(async()=>({rows:[]}))} as unknown as pg.Pool})
 afterEach(async()=>{await rm(dir,{recursive:true,force:true});vi.restoreAllMocks()})
 async function oldReport(options:{migrationRunId?:string;age?:number;reclaimed?:boolean}={}){
  const id=randomUUID(),body='opaque inventory detail\n',receipt={id,format:'pocketctl-memory-inventory-v1',createdAt:new Date(Date.now()-(options.age??15)*86400000).toISOString(),migrationRunId:options.migrationRunId??null,detailsHash:createHash('sha256').update(body).digest('hex'),detailsReclaimedAt:options.reclaimed?'2020-01-01T00:00:00Z':null,summary:{events:12}}
  await writeFile(join(dir,id+'.receipt.json'),JSON.stringify(receipt));await writeFile(join(dir,id+'.details.ndjson'),body);return id
 }
 test('explicitly managed generation writes hash/summary and private files',async()=>{
  const report=await createManagedInventoryReport(pool,dir)
  expect(report).toBeTruthy();const receipt=JSON.parse(await readFile(report!.receipt,'utf8')),details=await readFile(report!.details)
  expect(receipt.detailsHash).toBe(createHash('sha256').update(details).digest('hex'));expect(receipt.summary.counts).toEqual({events:1})
  expect((await lstat(report!.details)).mode&0o777).toBe(0o600)
  expect(await retainInventoryReports(pool,dir)).toEqual({reports:0,partials:0,busy:false})
 })
 test('only old owned exports are reclaimed; summaries, backups and user exports survive',async()=>{
  const old=await oldReport(),young=await oldReport({age:13})
  await writeFile(join(dir,'backup.sql'),'backup');await writeFile(join(dir,'user-export.ndjson'),'export')
  const partial=join(dir,randomUUID()+'.details.ndjson.partial');await writeFile(partial,'interrupted');await utimes(partial,new Date(0),new Date(0))
  expect(await retainInventoryReports(pool,dir)).toEqual({reports:1,partials:1,busy:false})
  expect(await readdir(dir)).toEqual(expect.arrayContaining([old+'.receipt.json',young+'.details.ndjson','backup.sql','user-export.ndjson']))
  expect(JSON.parse(await readFile(join(dir,old+'.receipt.json'),'utf8'))).toMatchObject({summary:{events:12},detailsReclaimedAt:expect.any(String)})
 })
 test('important reports remain protected until corresponding run detail GC, including unknown runs',async()=>{
  const id=await oldReport({migrationRunId:randomUUID()})
  expect((await retainInventoryReports(pool,dir)).reports).toBe(0)
  vi.mocked(pool.query).mockResolvedValue({rows:[{details_reclaimed_at:new Date()}]} as never)
  expect((await retainInventoryReports(pool,dir)).reports).toBe(1)
  expect(await readdir(dir)).toContain(id+'.receipt.json')
 })
 test('live writer lock prevents report and partial cleanup',async()=>{
  await oldReport();await writeFile(join(dir,'.retention.lock'),JSON.stringify({pid:process.pid,host:hostname()}))
  expect(await retainInventoryReports(pool,dir)).toEqual({reports:0,partials:0,busy:true})
 })
 test('stale lock is reclaimed only after proving the same-host process has exited',async()=>{
  await oldReport();const path=join(dir,'.retention.lock');await writeFile(path,JSON.stringify({pid:123456789,host:hostname()}));await utimes(path,new Date(0),new Date(0))
  vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error('exited'),{code:'ESRCH'})})
  expect((await retainInventoryReports(pool,dir)).reports).toBe(1)
 })
 test('hash mismatch and symlinks fail closed without removing targets',async()=>{
  const id=await oldReport();await writeFile(join(dir,id+'.details.ndjson'),'tampered')
  await expect(retainInventoryReports(pool,dir)).rejects.toThrow('report_hash_mismatch')
  await rm(join(dir,id+'.details.ndjson'));const backup=join(dir,'backup.sql');await writeFile(backup,'must survive');await symlink(backup,join(dir,id+'.details.ndjson'))
  await expect(retainInventoryReports(pool,dir)).rejects.toThrow('unsafe_retention_report_path')
  expect(await readFile(backup,'utf8')).toBe('must survive')
 })
 test('committed summary resumes an interrupted unlink idempotently',async()=>{
  const id=await oldReport({reclaimed:true})
  expect((await retainInventoryReports(pool,dir)).reports).toBe(1)
  expect((await retainInventoryReports(pool,dir)).reports).toBe(0)
  expect(await readdir(dir)).toContain(id+'.receipt.json')
 })
})
