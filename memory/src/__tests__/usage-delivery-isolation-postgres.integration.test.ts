import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createUsageOutbox} from '../reporting/usage-outbox.js'
import {createUsageWorker} from '../reporting/usage-worker.js'
import {relayErrorFromBody} from '../relay/errors.js'
import {createReportingClient} from '../relay/reporting-client.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url && process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('usage delivery isolation and Relay receipt matching',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:5});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>{await pool?.end()})
  async function install() {
    const id=randomUUID()
    await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[id])
    return id
  }
  async function seed(id:string,n=1,firstCost='11') {
    await pool.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,input_tokens,cost_micros,occurred_at)
      SELECT $1,'u-'||i,'recall',i,CASE WHEN i=1 THEN $3::bigint ELSE 11 END,now()-interval '1 day' FROM generate_series(1,$2) i`,[id,n,firstCost])
  }
  test('one tenant backlog cannot starve others and a replacement claim fences late success and failure',async()=>{
    const noisy=await install(),others=[] as string[]
    await seed(noisy,200)
    for(let i=0;i<9;i++){const id=await install();others.push(id);await seed(id)}
    const q=createUsageOutbox(pool),first=await q.nextBatch(randomUUID()),second=await q.nextBatch(randomUUID())
    const served=new Set([...first,...second].map(f=>f.installationId))
    expect(served.size).toBe(10)
    expect(first.length).toBeLessThanOrEqual(100)
    expect(first.filter(f=>f.installationId===noisy).length).toBeLessThanOrEqual(12)
    const id=others[0],newClaim=randomUUID()
    await pool.query("UPDATE memory_usage_outbox SET available_at=now()-interval '1 second' WHERE installation_id=$1",[id])
    expect((await q.nextBatch(newClaim)).some(f=>f.installationId===id)).toBe(true)
    await expect(pool.query("UPDATE memory_usage_outbox SET cost_micros=12 WHERE installation_id=$1 AND usage_id='u-1'",[id]))
      .rejects.toMatchObject({code:'23514'})
    expect(await q.markReported(id,'u-1',randomUUID())).toBe(false)
    await q.markAttempt(id,'u-1',randomUUID(),'invalid_request',true)
    expect(await q.markReported(id,'u-1',newClaim)).toBe(true)
    expect((await pool.query('SELECT attempts,dead_lettered_at FROM memory_usage_outbox WHERE installation_id=$1',[id])).rows)
      .toEqual([{attempts:1,dead_lettered_at:null}])
  })
  test('a lost receipt is retried with identical original fees and ID; incomplete duplicate ACK cannot settle it',async()=>{
    const id=await install()
    await seed(id)
    const sent:unknown[]=[]
    const http={request:vi.fn(async(_m:string,_p:string,args:{body:{facts:{usage_id:string}[]}})=>{
      sent.push(args.body.facts)
      if(sent.length===1) throw Object.assign(new Error('committed_then_disconnected'),{code:'network'})
      return {installation_id:id,ingested:0,...(sent.length===3?{acknowledged_usage_ids:['u-1']}:{})}
    })}
    const client=createReportingClient({http:http as never,tokens:{get:async()=>'fake'} as never})
    const worker=createUsageWorker({pool,reportUsage:client.reportUsage})
    expect(await worker.runOnce()).toBe(0)
    expect(await worker.runOnce()).toBe(0)
    expect(sent).toHaveLength(1)
    await pool.query("UPDATE memory_usage_outbox SET available_at=now(),attempts=9")
    expect(await worker.runOnce()).toBe(0)
    expect((await pool.query(`SELECT attempts,delivery_state,reported_at,last_error_code,available_at>now()+interval '55 minutes' AS cooled
      FROM memory_usage_outbox`)).rows[0]).toEqual({attempts:10,delivery_state:'probe',reported_at:null,last_error_code:'usage_receipt_unverified',cooled:true})
    await pool.query("UPDATE memory_usage_outbox SET available_at=now()")
    expect(await worker.runOnce()).toBe(1)
    expect(sent[0]).toEqual(sent[1]);expect(sent[1]).toEqual(sent[2])
    expect((await pool.query('SELECT cost_micros,input_tokens,reported_at IS NOT NULL AS reported FROM memory_usage_outbox')).rows[0])
      .toEqual({cost_micros:'11',input_tokens:'1',reported:true})
  })
  test('a Relay ledger collision isolates only the conflicting ID and keeps its charge unacknowledged',async()=>{
    const id=await install()
    await seed(id,2)
    const worker=createUsageWorker({pool,reportUsage:async(_id,facts)=>{
      if(facts.some(f=>f.usage_id==='u-1')) throw relayErrorFromBody('report_usage',409,{error:{code:'revision_conflict'}})
      return facts.length
    }})
    expect(await worker.runOnce()).toBe(1)
    expect((await pool.query('SELECT usage_id,reported_at IS NOT NULL AS sent,last_error_code,cost_micros FROM memory_usage_outbox ORDER BY usage_id')).rows)
      .toEqual([{usage_id:'u-1',sent:false,last_error_code:'revision_conflict',cost_micros:'11'},
        {usage_id:'u-2',sent:true,last_error_code:null,cost_micros:'11'}])
  })
  test('preserves an unrepresentable charge and historical invalid rejection; old known network failure probes independently',async()=>{
    const id=await install()
    await seed(id,4,'9007199254740993')
    await pool.query(`UPDATE memory_usage_outbox SET dead_lettered_at=now(),last_error_code=CASE WHEN usage_id='u-2' THEN 'invalid_request' ELSE 'network' END
      WHERE usage_id IN('u-2','u-3')`)
    await pool.query("UPDATE memory_usage_outbox SET available_at=now() WHERE usage_id='u-3'")
    const sent:string[]=[]
    const worker=createUsageWorker({pool,reportUsage:async(_id,facts)=>{sent.push(...facts.map(f=>String(f.usage_id)));return facts.length}})
    expect(await worker.runOnce()).toBe(2)
    expect(sent.sort()).toEqual(['u-3','u-4'])
    const rows=(await pool.query('SELECT usage_id,delivery_state,cost_micros,dead_lettered_at IS NOT NULL AS dead FROM memory_usage_outbox ORDER BY usage_id')).rows
    expect(rows[0]).toMatchObject({delivery_state:'rejected',cost_micros:'9007199254740993',dead:true})
    expect(rows[1]).toMatchObject({delivery_state:'legacy',cost_micros:'11',dead:true})
    expect(rows[2]).toMatchObject({delivery_state:'pending',cost_micros:'11',dead:false})
  })
})
