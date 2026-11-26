import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,expect,it,vi} from 'vitest'
import pg from 'pg'
import {deleteUserAccount,initDB} from '../db.js'
import {repairCodexUsageComponents} from '../usage-analytics/codex-components.js'
import {refreshHistoryDay} from '../usage-analytics/history-worker.js'
import {personalUsageQuery} from '../usage-analytics/routes.js'

const enabled=process.env.RUN_POSTGRES_INTEGRATION==='1'
const test=enabled?it:it.skip
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3})
const daemon='codex-fixture-'+randomUUID(),session='session-'+daemon
const date=new Date(Date.now()-86400000).toISOString().slice(0,10)
let owner:number,other:number
const meta={version:1,provider:'codex-managed',mode:'cumulative',input_semantics:'includes_cache',revision:0,source_usage_id:''}
beforeAll(async()=>{
 if(!enabled)return
 if(!new URL(process.env.TEST_DATABASE_URL!).pathname.includes('personal_usage_test'))throw Error('isolated_test_database_required')
 vi.stubEnv('PERSONAL_USAGE_WRITE','true');vi.stubEnv('PERSONAL_USAGE_ENABLED','true')
 vi.stubEnv('PERSONAL_USAGE_SNAPSHOT_SECRET','codex-components-test-secret-32-chars')
 await initDB(pool)
 ;[owner,other]=(await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'f'),($2,'f') RETURNING id",
  [daemon+'@example.test',daemon+'-other@example.test'])).rows.map(r=>r.id)
 await pool.query('INSERT INTO daemons(daemon_id,user_id,hostname) VALUES($1,$2,$1)',[daemon,owner])
 await pool.query("INSERT INTO sessions(session_id,user_id,daemon_id,agent_type) VALUES($1,$2,$3,'codex')",[session,owner,daemon])
 await pool.query('INSERT INTO usage_history_owners(owner_user_id) VALUES($1)',[owner])
},60000)
afterAll(async()=>{
 if(owner)await deleteUserAccount(pool,owner)
 if(other)await deleteUserAccount(pool,other)
 await pool.end();vi.unstubAllEnvs()
})

async function fact(id:string,u:Record<string,number>,metadata=meta,eventOwner=owner,rawInput=u.input_tokens??0) {
 const e=(await pool.query("INSERT INTO events(session_id,user_id,event_type,payload) VALUES($1,$2,'agent_text',$3) RETURNING id",
  [session,eventOwner,{usage:u,usage_meta:metadata}])).rows[0].id
 const key=daemon+id
 await pool.query(`INSERT INTO token_usage_facts(fact_key,source_event_id,user_id,daemon_id,session_id,agent_type,model,
  usage_date,recorded_at,input,output,cache_read,cache_create,reported_total,reasoning)
  VALUES($1,$2,$3,$4,$5,'codex','m',$6,$7,$8,$9,$10,0,$11,$12)`,
 [key,e,owner,daemon,session,date,date+'T12:00:00Z',rawInput,u.output_tokens??0,u.cache_read_tokens??0,u.total_tokens,u.reasoning_tokens??0])
 return key
}
const dashboard=()=>personalUsageQuery(pool,owner,{range:'7d',daemon},'dashboard')

test('reconciles inclusive Codex components and total-only evidence on ingest and in a resumable repair',async()=>{
 const split=await fact('split',{input_tokens:100,output_tokens:20,cache_read_tokens:40,reasoning_tokens:8,total_tokens:120})
 const scalar=await fact('scalar',{total_tokens:26563},{...meta,provider:'codex'})
 const keys=[split,scalar]
 const projected=async()=>(await pool.query(`SELECT source_fact_key,quality,input,output,cache_read,cache_create,total,
   requests,request_id FROM usage_token_projection WHERE source_fact_key=ANY($1) ORDER BY source_fact_key`,[keys])).rows
 const expected=await projected()
 expect(expected).toEqual([
  {source_fact_key:scalar,quality:'codex_fact_total_only',input:null,output:null,cache_read:null,cache_create:null,total:'26563',requests:null,request_id:null},
  {source_fact_key:split,quality:'codex_fact_components',input:'60',output:'20',cache_read:'40',cache_create:'0',total:'120',requests:null,request_id:null},
 ])
 // Recreate the old projector output and a clean history day published from it.
 await pool.query("UPDATE usage_source_metadata SET metadata=metadata-'codex_fact_shape_v1' WHERE fact_key=ANY($1)",[keys])
 await pool.query(`UPDATE usage_token_projection SET input=NULL,output=NULL,cache_read=NULL,cache_create=NULL,
   total=CASE WHEN source_fact_key=$2 THEN 160 ELSE 0 END,quality='legacy_unverified' WHERE source_fact_key=ANY($1)`,[keys,split])
 const day={owner_user_id:owner,daemon_id:daemon,day:date}
 expect(await refreshHistoryDay(pool,day)).toBe(true)
 const before=await dashboard()
 // Exercise explicit backfill replay before the one-time migration.
 await pool.query('SELECT usage_project_token_fact(f) FROM token_usage_facts f WHERE fact_key=ANY($1)',[keys])
 await pool.query('UPDATE usage_analytics_state SET codex_components_version=0,codex_components_cursor=NULL')
 await repairCodexUsageComponents(pool)
 expect(await projected()).toEqual(expected)
 await expect(personalUsageQuery(pool,owner,{range:'7d',daemon,snapshot_token:before.meta.snapshot_token},'dashboard')).rejects.toThrow('snapshot_changed')
 const live=await dashboard()
 expect(live.analysis).toMatchObject({total:'26683',input:null,requests:null})
 expect(live.composition).toEqual({input:'60',output:'20',cache_read:'40',cache_create:'0',known_total:'120',unknown_total:'26563'})
 expect(await refreshHistoryDay(pool,day)).toBe(true)
 vi.stubEnv('PERSONAL_USAGE_HISTORY_READ','true')
 vi.stubEnv('PERSONAL_USAGE_HISTORY_READ_OWNERS',String(owner))
 const historical=await personalUsageQuery(pool,owner,{range:'7d',daemon,snapshot_token:live.meta.snapshot_token},'dashboard')
 expect(historical).toEqual(live)
 // An older worker can publish the same revision during an upgrade. Its
 // combined row lost the 120-token subtotal. Read live until the new worker
 // rebuilds that day, even though the old worker marked it clean.
 await pool.query(`UPDATE usage_history_days SET token_composition_revision=NULL,
  tokens=jsonb_build_array(tokens->0 || '{"input":null,"output":null,"cache_read":null,"cache_create":null,"total":26683}'::jsonb)
  WHERE owner_user_id=$1 AND daemon_id=$2 AND day=$3`,[owner,daemon,date])
 const oldDay=await personalUsageQuery(pool,owner,{range:'7d',daemon,snapshot_token:live.meta.snapshot_token},'dashboard')
 expect(oldDay).toEqual(live)
 expect(await refreshHistoryDay(pool,day)).toBe(true)
 expect((await dashboard()).composition).toEqual(live.composition)
 await repairCodexUsageComponents(pool)
 expect((await dashboard()).meta.revision).toBe(live.meta.revision)
 // A replay after ordinary body retention retains the proven scalar evidence.
 await pool.query("UPDATE events SET payload='{}',body_header='{}' WHERE id IN (SELECT source_event_id FROM token_usage_facts WHERE fact_key=ANY($1))",[keys])
 await pool.query('DELETE FROM usage_token_projection WHERE source_fact_key=ANY($1)',[keys])
 await pool.query('SELECT usage_project_token_fact(f) FROM token_usage_facts f WHERE fact_key=ANY($1)',[keys])
 expect(await projected()).toEqual(expected)
},60000)

test('rejects an unproven provider, malformed accounting, and mismatched fact ownership or source values',async()=>{
 const u={input_tokens:100,output_tokens:20,cache_read_tokens:40,total_tokens:120}
 const keys=[
  await fact('unknown-provider',u,{...meta,provider:'unproven'}),
  await fact('different-owner',u,meta,other),
  await fact('different-counter',u,meta,owner,110),
  await fact('total-mismatch',{...u,total_tokens:121}),
  await fact('oversized-cache',{...u,cache_read_tokens:110}),
 ]
 const rows=(await pool.query('SELECT quality,input,output,request_id FROM usage_token_projection WHERE source_fact_key=ANY($1)',[keys])).rows
 expect(rows).toHaveLength(keys.length)
 for(const row of rows)expect(row).toEqual({quality:'legacy_unverified',input:null,output:null,request_id:null})
})
