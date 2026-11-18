import {afterAll,beforeAll,expect,it,vi} from 'vitest'
import pg from 'pg'
import {initDB,renameOwnedDaemonSession} from '../db.js'
import {getPersonalCalls} from '../usage-analytics/call-service.js'
import {DAY,rangeWindow} from '../usage-analytics/range.js'
import {personalUsageQuery} from '../usage-analytics/routes.js'
import {resolvePersonalUsageScope} from '../usage-analytics/scope.js'
import {getPersonalSessions} from '../usage-analytics/session-service.js'
import {readTokenRows} from '../usage-analytics/token-repository.js'
import {getPersonalDashboard} from '../usage-analytics/token-service.js'
import {refreshHistoryDay} from '../usage-analytics/history-worker.js'
import type {UsageRange} from '../usage-analytics/contracts.js'

const enabled=process.env.RUN_POSTGRES_INTEGRATION==='1'
const suite=enabled?it:it.skip
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:3})
const today=new Date().toISOString().slice(0,10)
const midnight=Date.parse(today+'T00:00:00Z')
const day=(daysAgo:number)=>new Date(midnight-daysAgo*DAY).toISOString().slice(0,10)
const asOf=new Date(midnight+DAY/2)
let owner:number,other:number,host:string,historical:string,source:string,parent:string,foreign:string

async function project(
 id:string, daemon:string, session:string, parentSession:string|null, date:string,
 input:string|null, total:string, request:string|null, model='m', user=owner,
) {
 await pool.query(`
  INSERT INTO usage_token_projection
   (owner_user_id,daemon_id,source_session,parent_session_id,child_agent_id,logical_usage_id,source_fact_key,
    agent_type,model,occurred_at,received_at,time_basis,input,output,cache_read,cache_create,total,quality,request_id)
  VALUES ($1,$2,$3,$4,CASE WHEN $4::text IS NOT NULL THEN 'child' END,$5,$5,
     'claude-code',$6,$7,now(),'source',$8,0,0,0,$9,'normalized',$10)
 `,[user,daemon,session,parentSession,id,model,date,input,total,request])
}
const readScope=(daemon='all',time=asOf)=>resolvePersonalUsageScope(pool,owner,daemon,rangeWindow('all',time))
const refresh=(daemon:string,daysAgo:number)=>refreshHistoryDay(pool,{owner_user_id:owner,daemon_id:daemon,day:day(daysAgo)})

beforeAll(async()=>{
 if(!enabled)return
 vi.stubEnv('PERSONAL_USAGE_ENABLED','true')
 vi.stubEnv('PERSONAL_USAGE_SNAPSHOT_SECRET','usage-history-isolated-test-secret-32')
 const url=new URL(process.env.TEST_DATABASE_URL??'invalid')
 if(!url.pathname.includes('personal_usage_test')) throw Error('isolated_test_database_required')
 await initDB(pool)
 const result=await pool.query(`INSERT INTO users(email,password_hash)
  VALUES('history-test-'||clock_timestamp()||'@example.test','fixture'),
        ('history-other-'||clock_timestamp()||'@example.test','fixture') RETURNING id`)
 ;[owner,other]=result.rows.map(row=>row.id)
 await pool.query('INSERT INTO usage_history_owners(owner_user_id) VALUES($1)',[owner])
 host='history-host-'+owner
 historical='history-past-'+owner
 source='history-src-'+owner
 parent='history-parent-'+owner
 foreign='history-foreign-'+other
 await pool.query(`INSERT INTO daemons(daemon_id,user_id,hostname) VALUES
  ($1,$2,'Fixture'), ($3,$4,'Other')
 `,[host,owner,foreign,other])
 await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,title)
  VALUES($1,$2,$3,'claude-code','Child'),($4,$2,$3,'claude-code','Parent'),($5,$6,$7,'fixture','Foreign')
 `,[source,host,owner,parent,'foreign-session-'+other,foreign,other])
 await project('a',host,source,parent,day(2)+'T11:00:00Z','9007199254740993','9007199254740993','same-request')
 await project('b',host,source,parent,day(1)+'T11:00:00Z','40','40','same-request','other-model')
 await project('c',host,source,parent,today+'T11:00:00Z','5','5','same-request')
 await project('d',host,source,parent,today+'T17:00:00Z','777','777','too-new')
 await project('foreign',foreign,'foreign-session-'+other,null,day(1)+'T11:00:00Z','900','900','secret','m',other)
 await pool.query(`INSERT INTO token_daily_stats(user_id,daemon_id,date,model,input)
   VALUES($1,$2,$3,'legacy',45)`,[owner,historical,day(2)])
 await pool.query(`INSERT INTO usage_call_facts(owner_user_id,daemon_id,runtime,source_session,invocation_id,
    tool_kind,tool_name,mcp_server,occurred_at,received_at,outcome,has_start,quality)
   VALUES($1,$2,'fixture',$3,'one','mcp','Tool','example',$4,now(),'success',true,'normalized'),
         ($1,$2,'fixture',$3,'two','mcp','Tool','example',$5,now(),'unknown',false,'normalized'),
         ($1,$2,'fixture',$3,'three','mcp','Tool','example',$5,now(),'failure',true,'normalized')
 `,[owner,host,source,day(2)+'T17:00:00Z',day(1)+'T11:00:00Z'])
 await pool.query(`INSERT INTO usage_skill_facts(owner_user_id,daemon_id,runtime,source_session,skill_invocation_id,
    skill_key,skill_name,occurred_at,evidence_kind,evidence_version)
   VALUES($1,$2,'fixture',$3,'one','review','Review',$4,'native_skill_execution',1)
 `,[owner,host,source,day(2)+'T17:00:00Z'])
},60_000)
afterAll(async()=>{
 vi.unstubAllEnvs()
 if(owner){
  await pool.query('DELETE FROM deleted_sessions WHERE session_id=$1',[source])
  await pool.query('DELETE FROM token_daily_stats WHERE user_id=$1',[owner])
  await pool.query('DELETE FROM sessions WHERE user_id=ANY($1::int[])',[[owner,other]])
  await pool.query('DELETE FROM daemons WHERE user_id=ANY($1::int[])',[[owner,other]])
  await pool.query('DELETE FROM users WHERE id=ANY($1::int[])',[[owner,other]])
 }
 await pool.end()
})

suite('historical and live rows reproduce every dashboard, session and call view',async()=>{
 const all=await readScope()
 const only=await readScope(host)
 expect(await refresh(host,2)).toBe(true)
 expect(await refresh(host,1)).toBe(true)
 expect(await refresh(historical,2)).toBe(true)
 expect(await refresh(host,0)).toBe(false)
 for(const range of ['today','7d','30d','all'] satisfies UsageRange[]){
  expect(await getPersonalDashboard(pool,all,range,asOf,true)).toEqual(await getPersonalDashboard(pool,all,range,asOf,false))
 }
 // A bounded scope makes the work performed on the hot path inspectable.
 const win=rangeWindow('all',asOf)
 const scope={...only,windows:only.windows.map(w=>({...w,from:day(2)+'T00:00:00Z'}))}
 const trace={query:async (sql: string, values: unknown[])=>{
  const plan=(await pool.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0].Plan
  type Node={Plans?:Node[];'Relation Name'?:string;'Actual Rows':number;'Actual Loops':number}
  function reads(node:Node,relation:string):number {
   const own=node['Relation Name']===relation?node['Actual Rows']*node['Actual Loops']:0
   return own+(node.Plans??[]).reduce((total,child)=>total+reads(child,relation),0)
  }
  expect(reads(plan,'usage_token_projection')).toBe(1)
  expect(reads(plan,'token_usage_facts')).toBe(0)
  return pool.query(sql,values)
 }} as Pick<pg.Pool,'query'>
 await readTokenRows(trace,scope,win,{aggregate:true,history:true})
 const dashboard=await getPersonalDashboard(pool,only,'all',asOf,true)
 expect(dashboard.analysis).toMatchObject({total:'9007199254741038',requests:'1'})
 expect(dashboard.heatmap.days).toHaveLength(90)
 expect((await getPersonalDashboard(pool,all,'all',asOf,true)).analysis.requests).toBeNull()
 const results=await getPersonalSessions(pool,all,'all',asOf,{},undefined,true)
 expect(results).toEqual(await getPersonalSessions(pool,all,'all',asOf,{},undefined,false))
 expect(results.sessions[0]).toMatchObject({session_id:parent,total:'9007199254741038',requests:'1',children:[{agent_id:'child'}]})
 expect(await getPersonalSessions(pool,all,'all',asOf,{},parent,true)).toEqual(await getPersonalSessions(pool,all,'all',asOf,{},parent,false))
 for (const category of ['tools','mcp','skills']){
  const calls=await getPersonalCalls(pool,all,'all',asOf,{category},undefined,true)
  expect(calls).toEqual(await getPersonalCalls(pool,all,'all',asOf,{category},undefined,false))
  if(!('ranking' in calls)||!calls.ranking)throw Error('expected ranking')
  const id=calls.ranking[0].object_id
  const association=category==='skills'?{skill_object_id:id}:{call_object_id:id}
  expect(await getPersonalCalls(pool,all,'all',asOf,{},id,true)).toEqual(await getPersonalCalls(pool,all,'all',asOf,{},id,false))
  const related=await getPersonalSessions(pool,all,'all',asOf,association,undefined,true)
  expect(related).toEqual(await getPersonalSessions(pool,all,'all',asOf,association,undefined,false))
  expect(related.sessions.map(s=>s.session_id)).toEqual([source])
 }
 expect(all.daemons.some(d=>d.daemon_id===foreign)).toBe(false)
})

suite('partial historical cutoff and dirty days query only the missing slice',async()=>{
 const cutoff=new Date(day(2)+'T15:00:00Z')
 const earlier=await readScope('all',cutoff)
 const before=await getPersonalDashboard(pool,earlier,'all',cutoff,true)
 expect(before).toEqual(await getPersonalDashboard(pool,earlier,'all',cutoff,false))
 expect(before.analysis.total).toBe('9007199254740993')
 const calls=await getPersonalCalls(pool,earlier,'all',cutoff,{},undefined,true)
 expect(calls).toEqual(await getPersonalCalls(pool,earlier,'all',cutoff,{},undefined,false))
 expect(calls.summary?.tools).toBeNull()

 await pool.query(`UPDATE usage_token_projection SET total=41,input=41 WHERE owner_user_id=$1 AND logical_usage_id='b'`,[owner])
 const ready=(await pool.query(`SELECT day::text,built_revision=revision AS ready FROM usage_history_days
  WHERE owner_user_id=$1 AND daemon_id=$2 AND day<$3 ORDER BY day`,[owner,host,today])).rows
 expect(ready).toEqual([{day:day(2),ready:true},{day:day(1),ready:false}])
 const scope=await readScope()
 expect(await getPersonalDashboard(pool,scope,'all',asOf,true)).toEqual(await getPersonalDashboard(pool,scope,'all',asOf,false))
 expect(await refresh(host,1)).toBe(true)
})

suite('HTTP read flag, authorization changes and the stored history stay separate',async()=>{
 vi.stubEnv('PERSONAL_USAGE_HISTORY_READ','true')
 vi.stubEnv('PERSONAL_USAGE_HISTORY_READ_OWNERS',String(owner))
 const dashboard=await personalUsageQuery(pool,owner,{contract:'personal-v1',range:'all'},'dashboard')
 expect(dashboard.meta.window_days).toBe(365)
 expect(dashboard.heatmap.days).toHaveLength(90)
 const snapshots=(await pool.query(`SELECT count(*)::int AS count FROM usage_history_days
  WHERE owner_user_id=$1 AND built_revision=revision`,[owner])).rows[0].count
 await pool.query('INSERT INTO deleted_sessions(session_id) VALUES($1)',[source])
 const scope=await readScope()
 const after=await getPersonalDashboard(pool,scope,'all',asOf,true)
 expect(after).toEqual(await getPersonalDashboard(pool,scope,'all',asOf,false))
 // Parent attribution still exists under the established token contract;
 // the revoked child must no longer be returned as a visible association.
 const calls=await getPersonalCalls(pool,scope,'all',asOf,{category:'mcp'},undefined,true)
 expect(calls.ranking?.[0].sessions).toBe('0')
 expect((await pool.query(`SELECT count(*)::int AS count FROM usage_history_days
  WHERE owner_user_id=$1 AND built_revision=revision`,[owner])).rows[0].count).toBe(snapshots)
})

suite('late legacy days and out-of-order revision commits invalidate an already issued query snapshot',async()=>{
 const query={contract:'personal-v1',range:'all'}
 const before=await personalUsageQuery(pool,owner,query,'dashboard')
 await pool.query('UPDATE token_daily_stats SET input=input+1 WHERE user_id=$1 AND daemon_id=$2',[owner,historical])
 await expect(personalUsageQuery(pool,owner,{...query,snapshot_token:before.meta.snapshot_token},'dashboard'))
  .rejects.toThrow('snapshot_changed')

 const first=await pool.connect()
 const append=`INSERT INTO usage_scope_changes(owner_user_id,daemon_id,from_at,to_exclusive)
   VALUES($1,$2,$3::timestamptz,$3::timestamptz+interval '1 microsecond')`
 try{
  await first.query('BEGIN')
  await first.query(append,[owner,host,day(2)+'T10:00:00Z'])
  await pool.query(append,[owner,host,day(1)+'T10:00:00Z'])
  const meanwhile=await personalUsageQuery(pool,owner,query,'dashboard')
  await first.query('COMMIT')
  await expect(personalUsageQuery(pool,owner,{...query,snapshot_token:meanwhile.meta.snapshot_token},'dashboard'))
   .rejects.toThrow('snapshot_changed')
 }finally{
  await first.query('ROLLBACK')
  first.release()
 }
})

suite('flag-off rollout reads from a pre-migration schema',async()=>{
 vi.stubEnv('PERSONAL_USAGE_HISTORY_READ','false')
 await pool.query('ALTER TABLE usage_scope_changes RENAME COLUMN legacy_day TO test_saved_legacy_day')
 try{
  const result=await personalUsageQuery(pool,owner,{contract:'personal-v1',range:'all'},'dashboard')
  expect(result.meta.contract).toBe('personal-v1')
  expect(result.meta.window_days).toBe(365)
 }finally{
  await pool.query('ALTER TABLE usage_scope_changes RENAME COLUMN test_saved_legacy_day TO legacy_day')
 }
})

suite('a lower alias revision committed later invalidates the signed authorization',async()=>{
 const query={contract:'personal-v1',range:'all'}
 const oldFirst='history-alias-1-'+owner,oldSecond='history-alias-2-'+owner
 await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,agent_type) VALUES
  ($1,$3,$4,'fixture'),($2,$3,$4,'fixture')`,[oldFirst,oldSecond,host,owner])
 const first=await pool.connect()
 const rename=(db:pg.Pool|pg.PoolClient,oldSessionId:string)=>renameOwnedDaemonSession(db,{
  oldSessionId,newSessionId:oldSessionId+'-renamed',daemonId:host,userId:owner,
 })
 try{
  await first.query('BEGIN')
  expect(await rename(first,oldFirst)).toBe(true)
  expect(await rename(pool,oldSecond)).toBe(true)
  const before=await personalUsageQuery(pool,owner,query,'dashboard')
  await first.query('COMMIT')
  await expect(personalUsageQuery(pool,owner,{...query,snapshot_token:before.meta.snapshot_token},'calls'))
   .rejects.toThrow('snapshot_authorization_changed')
 }finally{
  await first.query('ROLLBACK')
  first.release()
 }
})

suite('near-midnight source timestamps queue the following day without building it early',async()=>{
 const tomorrow=day(-1)
 await project('following-day',host,source,parent,tomorrow+'T00:01:00Z','200','200','future-day')
 const pending=(await pool.query(`SELECT built_revision FROM usage_history_days
   WHERE owner_user_id=$1 AND daemon_id=$2 AND day=$3`,[owner,host,tomorrow])).rows
 expect(pending).toEqual([{built_revision:null}])
 expect(await refresh(host,-1)).toBe(false)
})

suite('a legacy source commit invalidates snapshots issued after a concurrent rollup commit',async()=>{
 const effectiveDay=day(4),model='legacy-race',id='legacy-race-'+owner
 await pool.query(`INSERT INTO token_usage_facts
   (fact_key,user_id,daemon_id,session_id,model,usage_date,recorded_at,input)
   VALUES($1,$2,$3,$4,$5,$6,now(),10)`,[id,owner,host,parent,model,effectiveDay])
 await pool.query(`INSERT INTO usage_source_metadata
   (fact_key,owner_user_id,daemon_id,source_session,logical_usage_id,metadata,received_at)
   VALUES($1,$2,$3,$4,$1,'{}',now())
   ON CONFLICT(fact_key) DO UPDATE SET source_session=EXCLUDED.source_session,logical_usage_id=EXCLUDED.logical_usage_id
  `,[id,owner,host,parent])
 const projection=await pool.query(`SELECT 1 FROM usage_token_projection WHERE owner_user_id=$1
   AND daemon_id=$2 AND source_session=$3 AND logical_usage_id=$4`,[owner,host,parent,id])
 if(!projection.rowCount)await project(id,host,parent,null,effectiveDay+'T07:00:00Z','10','10',id,model)
 const query={contract:'personal-v1',daemon:host,range:'all'}
 const sourceWrite=await pool.connect()
 try{
  await sourceWrite.query('BEGIN')
  await sourceWrite.query('UPDATE token_usage_facts SET input=20 WHERE fact_key=$1',[id])
  await pool.query(`INSERT INTO token_daily_stats(user_id,daemon_id,date,model,input)
    VALUES($1,$2,$3,$4,100)`,[owner,host,effectiveDay,model])
  const before=await personalUsageQuery(pool,owner,query,'dashboard')
  await sourceWrite.query('COMMIT')
  await expect(personalUsageQuery(pool,owner,{...query,snapshot_token:before.meta.snapshot_token},'dashboard'))
   .rejects.toThrow('snapshot_changed')
 }finally{
  await sourceWrite.query('ROLLBACK')
  sourceWrite.release()
 }
})
