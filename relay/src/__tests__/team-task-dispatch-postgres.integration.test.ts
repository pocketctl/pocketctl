import type pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {teamV2DatabaseEnabled,teamV2Pool,humanTeamFixture} from './fixtures/team-v2.js'
;(teamV2DatabaseEnabled?describe:describe.skip)('Atomic Team task dispatch (PostgreSQL)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=await teamV2Pool()});afterAll(async()=>{if(pool){await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE');await pool.end()}})
 test('creates one Task/event/Call receipt, freezes materials, and rolls back unavailable targets',async()=>{
  const f=await humanTeamFixture(pool),daemon=`task-d-${f.key}`,offer=`task-o-${f.key}`
  await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'task','online',$2,'[{"type":"codex","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`,[daemon,f.users[0]])
  await pool.query(`INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')`,[offer,f.teamId,f.users[0],daemon])
  await f.service.changeBinding({sessionId:f.session.id,actorUserId:f.users[0],offerId:offer,active:true,expectedRevision:1,requestId:'bind'})
  const input={sessionId:f.session.id,actorUserId:f.users[0],requestId:'assign',instruction:'Implement task',acceptance:'Verify output',targetOfferIds:[offer],contextVersion:0}
  const result=await f.service.assignTask(input)
  expect(await f.service.assignTask(input)).toEqual(result)
  const callsBefore=(await pool.query('SELECT count(*)::int n FROM collaboration_calls')).rows[0].n
  expect(await f.service.taskByRequest(f.session.id,f.users[0],'assign')).toEqual({operation:'assign_task',team_session_id:f.session.id,request_id:'assign',found:true,response:result})
  expect(await f.service.taskByRequest(f.session.id,f.users[0],'absent')).toMatchObject({found:false,response:null})
  expect(await f.service.taskByRequest(f.session.id,f.users[1],'assign')).toMatchObject({found:false,response:null})
  expect((await pool.query('SELECT count(*)::int n FROM collaboration_calls')).rows[0].n).toBe(callsBefore)
  const call=(await pool.query(`SELECT task_id,event_id,context_version FROM collaboration_calls WHERE call_id=$1`,[result.call_ids[0]])).rows[0]
  expect(call).toMatchObject({task_id:result.task_id,event_id:result.event.id,context_version:'0'})
  await expect(f.service.assignTask({...input,acceptance:'different'})).rejects.toMatchObject({code:'idempotency_conflict'})
  await expect(f.service.assignTask({...input,requestId:'missing',acceptance:''})).rejects.toMatchObject({code:'invalid_state'})
  await pool.query(`UPDATE daemons SET status='offline' WHERE daemon_id=$1`,[daemon])
  await expect(f.service.assignTask({...input,requestId:'offline'})).rejects.toMatchObject({code:'no_callable_agent'})
  expect((await pool.query(`SELECT COUNT(*)::int n FROM team_tasks WHERE team_id=$1`,[f.teamId])).rows[0].n).toBe(1)
  expect((await pool.query(`SELECT COUNT(*)::int n FROM collaboration_calls WHERE team_session_id=$1`,[f.session.id])).rows[0].n).toBe(1)
  await pool.query("UPDATE collaboration_sessions SET state='archived' WHERE team_session_id=$1",[f.session.id])
  expect(await f.service.taskByRequest(f.session.id,f.users[0],'assign')).toMatchObject({found:true})
  await pool.query("UPDATE team_tasks SET state='deleted' WHERE task_id=$1",[result.task_id])
  await expect(f.service.taskByRequest(f.session.id,f.users[0],'assign')).rejects.toMatchObject({code:'team_not_found'})
  await pool.query("UPDATE collaboration_session_participants SET state='removed' WHERE team_session_id=$1 AND user_id=$2",[f.session.id,f.users[0]])
  await expect(f.service.taskByRequest(f.session.id,f.users[0],'absent')).rejects.toMatchObject({code:'team_not_found'})
 })
})
