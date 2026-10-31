import {afterEach,describe,expect,test,vi} from 'vitest'
vi.mock('../retention/source.js',()=>({previewSourceRetention:vi.fn(),reclaimSourceTurn:vi.fn()}))
vi.mock('../retention/migrations.js',()=>({retainMigrationHistory:vi.fn(),retainMigrationChanges:vi.fn()}))
vi.mock('../retention/reports.js',()=>({retainInventoryReports:vi.fn()}))
import type pg from 'pg'
import {createDataRetentionWorker} from '../retention/worker.js'
import {previewSourceRetention,reclaimSourceTurn} from '../retention/source.js'
import {retainMigrationHistory,retainMigrationChanges} from '../retention/migrations.js'
const settings={mode:'enabled' as const,bodyDays:14,batchSize:500,intervalMs:86400000}
afterEach(()=>{vi.resetAllMocks();vi.useRealTimers()})
describe('data retention worker lifecycle',()=>{
 test('off and aborted never query or schedule mutations',async()=>{
  const abort=new AbortController();for(const s of [{...settings,mode:'off' as const},settings]){
   if(s.mode==='enabled')abort.abort();const w=createDataRetentionWorker({pool:{} as pg.Pool,settings:s,signal:abort.signal});w.start();expect(await w.runOnce()).toBe(false);await w.stop()
  }
  expect(previewSourceRetention).not.toHaveBeenCalled()
 })
 test('overlapping runs share one pass, stop drains the current transaction and skips subsequent cleanup',async()=>{
  let resolve!:(value:any)=>void;const pending=new Promise<any>(r=>{resolve=r})
  vi.mocked(previewSourceRetention).mockResolvedValue({eligible:[{installation_id:'i',session_id:'s',turn_id:'t',episode_id:'e'}],reclaiming:[],previewLimit:20})
  vi.mocked(reclaimSourceTurn).mockReturnValue(pending)
  const w=createDataRetentionWorker({pool:{} as pg.Pool,settings,signal:new AbortController().signal})
  const a=w.runOnce(),b=w.runOnce();expect(a).toBe(b)
  await vi.waitFor(()=>expect(reclaimSourceTurn).toHaveBeenCalledTimes(1))
  let stopped=false;const stop=w.stop().then(()=>{stopped=true});await Promise.resolve();expect(stopped).toBe(false)
  resolve({events:1,artifacts:0,snapshots:0,candidates:0,episodes:0,finished:false,skipped:null});await stop
  expect(await a).toBe(true);expect(retainMigrationChanges).not.toHaveBeenCalled()
 })
 test('busy full pages advance the cursor so other installations are not starved',async()=>{
  const rows=Array.from({length:20},(_,n)=>({installation_id:'i',session_id:'s',turn_id:`t${n}`,episode_id:`e${n}`}))
  vi.mocked(previewSourceRetention).mockResolvedValueOnce({eligible:rows,reclaiming:[],previewLimit:20}).mockResolvedValue({eligible:[],reclaiming:[],previewLimit:20})
  vi.mocked(reclaimSourceTurn).mockResolvedValue({events:0,artifacts:0,snapshots:0,candidates:0,episodes:0,finished:false,skipped:'busy'})
  vi.mocked(retainMigrationHistory).mockResolvedValue({actions:0,checkpoints:0,runs:0});vi.mocked(retainMigrationChanges).mockResolvedValue({changes:0})
  const onSkipped=vi.fn(),w=createDataRetentionWorker({pool:{} as pg.Pool,settings,signal:new AbortController().signal,onSkipped})
  expect(await w.runOnce()).toBe(true);expect(await w.runOnce()).toBe(false)
  expect(vi.mocked(previewSourceRetention).mock.calls[1][3]).toMatchObject({eligibleEpisodeId:'e19'})
  expect(onSkipped).toHaveBeenCalledTimes(20);await w.stop()
 })
 test('empty completed pass waits daily; progress continues in one second',async()=>{
  vi.useFakeTimers();vi.mocked(previewSourceRetention).mockResolvedValue({eligible:[],reclaiming:[],previewLimit:20})
  vi.mocked(retainMigrationHistory).mockResolvedValue({actions:1,checkpoints:0,runs:0});vi.mocked(retainMigrationChanges).mockResolvedValue({changes:0})
  const w=createDataRetentionWorker({pool:{} as pg.Pool,settings,signal:new AbortController().signal});w.start();await vi.advanceTimersByTimeAsync(0)
  expect(retainMigrationHistory).toHaveBeenCalledTimes(1);vi.mocked(retainMigrationHistory).mockResolvedValue({actions:0,checkpoints:0,runs:0})
  await vi.advanceTimersByTimeAsync(1000);expect(retainMigrationHistory).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1000);expect(retainMigrationHistory).toHaveBeenCalledTimes(2)
  await w.stop();await vi.advanceTimersByTimeAsync(86400000);expect(retainMigrationHistory).toHaveBeenCalledTimes(2)
 })
})
