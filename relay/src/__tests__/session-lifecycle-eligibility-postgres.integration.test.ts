import { afterAll,beforeAll,beforeEach,describe,expect,test } from 'vitest'
import type pg from 'pg'
import { initDB } from '../db.js'
import { lifecycleTestPool } from './session-lifecycle-test-database.js'
import { sessionLifecycleConfig } from '../session-lifecycle/config.js'
import { inspectLifecycleEligibility } from '../session-lifecycle/eligibility.js'

const suite=process.env.RUN_SESSION_LIFECYCLE_POSTGRES==='1'?describe:describe.skip
suite('final fenced lifecycle eligibility PostgreSQL',()=>{
  let pool:pg.Pool,userId:number
  const config=sessionLifecycleConfig({}),now='2026-02-10T00:00:00.000001Z'
  beforeAll(async()=>{pool=await lifecycleTestPool();await initDB(pool)},30000)
  afterAll(async()=>{await pool?.end()})
  beforeEach(async()=>{
    await pool.query('TRUNCATE users,daemons,sessions,events,subagents,deleted_sessions,extension_source_outbox,extension_feed RESTART IDENTITY CASCADE')
    await pool.query('UPDATE attention_projection_cursor SET last_event_id=0')
    userId=(await pool.query("INSERT INTO users(email,password_hash) VALUES('eligibility@test.invalid','x') RETURNING id")).rows[0].id
    await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('host',$1)",[userId])
  })
  async function add(id='root',parent:string|null=null){await pool.query(`INSERT INTO sessions(session_id,user_id,daemon_id,status,last_activity_at,activity_verified,parent_session_id)
    VALUES($1,$2,'host','idle','2026-01-01',true,$3)`,[id,userId,parent])}
  const inspect=()=>inspectLifecycleEligibility(pool,'root',config,{now})
  test.each(['source','session_id','daemon_id'])('recognizes demo %s without relying on activity verification',async(marker)=>{
    const id=marker==='session_id'?'app-review-demo-legacy':'root'
    await add(id)
    if(marker==='source')await pool.query("UPDATE sessions SET source='app_review_demo'")
    if(marker==='daemon_id'){
      await pool.query("INSERT INTO daemons(daemon_id,user_id) VALUES('app-review-demo-host',$1)",[userId])
      await pool.query("UPDATE sessions SET daemon_id='app-review-demo-host'")
    }
    for(const verified of [false,true]){
      await pool.query('UPDATE sessions SET activity_verified=$1',[verified])
      const result=await inspectLifecycleEligibility(pool,id,config,{now})
      expect(result.prediction).toMatchObject({action:null,blockedReasons:['demo_excluded']})
      expect(result.root!.activity_verified).toBe(verified)
    }
  })
  test('a demo dependency excludes the whole component from either entry point',async()=>{
    await add();await add('app-review-demo-child','root')
    for(const id of ['root','app-review-demo-child']){
      const result=await inspectLifecycleEligibility(pool,id,config,{now:'2026-06-01T00:00:00Z'})
      expect(result.sessionIds).toEqual(['app-review-demo-child','root'])
      expect(result.prediction).toMatchObject({action:null,blockedReasons:['demo_excluded']})
    }
  })
  test('idle without a turn is eligible; started turn and unknown status protect',async()=>{
    await add();expect((await inspect()).prediction.action).toBe('archive')
    await pool.query("UPDATE sessions SET turn_started_at=NOW() WHERE session_id='root'")
    expect((await inspect()).prediction.blockedReasons).toContain('session_active')
    await pool.query("UPDATE sessions SET turn_started_at=NULL,status='unrecognized' WHERE session_id='root'")
    expect((await inspect()).prediction.blockedReasons).toContain('status_unknown')
  })
  test('nested independent sessions and completed parent event buckets are distinguished',async()=>{
    await add();await add('child','root');await add('leaf','child')
    await pool.query("INSERT INTO subagents(parent_session_id,agent_id,kind,status) VALUES('root','bucket','claude_subagent','completed')")
    await pool.query("UPDATE subagents SET created_at='2026-01-01'")
    expect((await inspect()).sessionIds).toEqual(['child','leaf','root'])
    expect((await inspect()).prediction.action).toBe('archive')
    await pool.query("UPDATE sessions SET status='running',turn_started_at=NOW() WHERE session_id='leaf'")
    expect((await inspect()).prediction.blockedReasons).toContain('session_active')
    await pool.query("UPDATE sessions SET status='idle',turn_started_at=NULL,last_activity_at='2026-02-09' WHERE session_id='leaf'")
    expect((await inspect()).prediction.action).toBeNull()
    await pool.query("UPDATE sessions SET last_activity_at='2026-01-01' WHERE session_id='leaf'")
    await pool.query("UPDATE subagents SET kind='sdk_session' WHERE agent_id='bucket'")
    expect((await inspect()).prediction.blockedReasons).toContain('dependency_unknown')
  })
  test('cycle, missing ancestor and changed daemon owner are excluded',async()=>{
    await add();await add('child','root')
    await pool.query("UPDATE sessions SET parent_session_id='child' WHERE session_id='root'")
    expect((await inspect()).prediction.blockedReasons).toContain('dependency_unknown')
    await pool.query("UPDATE sessions SET parent_session_id='missing' WHERE session_id='root'")
    expect((await inspect()).prediction.blockedReasons).toContain('dependency_unknown')
    await pool.query('UPDATE daemons SET user_id=NULL')
    expect((await inspect()).prediction.blockedReasons).toContain('owner_unknown')
  })
  test('admission and extension work protect before activity is materialized',async()=>{
    await add()
    await pool.query(`INSERT INTO session_message_admissions(id,user_id,daemon_id,session_id,request_id,command_hash,expires_at)
      VALUES('00000000-0000-4000-8000-000000000099',$1,'host','root','request','hash',NOW()+interval '1 hour')`,[userId])
    expect((await inspect()).prediction.blockedReasons).toContain('admission_pending')
    await pool.query(`INSERT INTO extension_source_outbox(source_kind,source_id,owner_user_id,session_id,event_type,occurred_at,payload)
      VALUES('canonical_event','99',$1,'root','agent_text',NOW(),'{}')`,[userId])
    expect((await inspect()).prediction.blockedReasons).toContain('extension_pending')
  })
  test('pending effects and attention projection must settle before cooling',async()=>{
    await add()
    await pool.query("INSERT INTO events(session_id,event_type,payload,effect_status) VALUES('root','agent_text','{}','pending')")
    const prediction=(await inspect()).prediction
    expect(prediction.blockedReasons).toContain('effect_pending')
    expect(prediction.blockedReasons).toContain('attention_pending')
    await pool.query("UPDATE events SET effect_status='completed',created_at='2026-01-01'")
    await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
    expect((await inspect()).prediction.action).toBe('archive')
  })
  test('only an explicitly owned matching epoch may bypass its cooling marker',async()=>{
    await add();await pool.query("UPDATE sessions SET content_state='cooling',activity_epoch=9")
    expect((await inspect()).prediction.blockedReasons).toContain('cooling_pending')
    expect((await inspectLifecycleEligibility(pool,'root',config,{now,ownCoolingEpochs:new Map([['root','8']])})).prediction.action).toBeNull()
    expect((await inspectLifecycleEligibility(pool,'root',config,{now,ownCoolingEpochs:new Map([['root','9']])})).prediction.action).toBe('archive')
  })
  test('Team adoption advances the protected epoch and excludes the native session',async()=>{
    await add()
    await pool.query("INSERT INTO collaboration_teams(team_id,name,creator_user_id) VALUES('team','Fixture Team',$1)",[userId])
    await pool.query("INSERT INTO collaboration_sessions(team_session_id,team_id,creator_user_id,title) VALUES('team-session','team',$1,'Team work')",[userId])
    await pool.query("INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES('offer','team',$1,'host','codex')",[userId])
    const before=(await inspect()).root!.epoch
    await pool.query("INSERT INTO collaboration_session_agent_bindings(binding_id,team_session_id,offer_id,owner_user_id,native_session_id) VALUES('binding','team-session','offer',$1,'root')",[userId])
    const after=await inspect()
    expect(BigInt(after.root!.epoch)).toBeGreaterThan(BigInt(before))
    expect(after.prediction.blockedReasons).toContain('scope_excluded')
  })
  test('stable old running and pending effects expire, while new content protects the entire component',async()=>{
    await add()
    await pool.query("UPDATE sessions SET status='running',activity_verified=false,created_at='2026-01-01',turn_started_at='2026-01-01'")
    await pool.query("INSERT INTO events(session_id,event_type,payload,effect_status,created_at) VALUES('root','agent_text','{}','pending','2026-01-01')")
    await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
    expect((await inspect()).prediction.action).toBe('archive')
    expect((await inspect()).staleEvidence?.pendingEffects).toBe(1)
    await pool.query(`INSERT INTO event_inbox(daemon_id,daemon_generation,seq,dedup_key,event_type,priority_class,session_id,payload)
      VALUES('host',1,1,'reconnect-meta','session_meta',0,'root','{}')`)
    expect((await inspect()).prediction.action).toBe('archive')
    const purge=await inspectLifecycleEligibility(pool,'root',config,{now:'2026-04-01T00:00:00Z'})
    expect(purge.prediction.action).toBe('purge')
    await pool.query("INSERT INTO events(session_id,event_type,payload,effect_status,created_at) VALUES('root','agent_text','{}','completed','2026-02-09')")
    await pool.query('UPDATE attention_projection_cursor SET last_event_id=(SELECT max(id) FROM events)')
    expect((await inspect()).prediction.action).toBeNull()
    expect((await inspect()).prediction.blockedReasons).toContain('session_active')
  })

})
