import type pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {TeamEventFanout} from '../team/event-fanout.js'
import {teamV2DatabaseEnabled,teamV2Pool,humanTeamFixture} from './fixtures/team-v2.js'
;(teamV2DatabaseEnabled?describe:describe.skip)('Team durable fanout (PostgreSQL)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=await teamV2Pool()});afterAll(async()=>{if(pool){await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE');await pool.end()}})
 test('two Relay cursors independently recover committed events and replay after delivery failure',async()=>{
  const f=await humanTeamFixture(pool),a:string[]=[],b:string[]=[]
  const r1=new TeamEventFanout(pool,`r1-${f.key}`,async(s,_,e)=>{if(s===f.session.id)a.push(e.id)})
  const r2=new TeamEventFanout(pool,`r2-${f.key}`,async(s,_,e)=>{if(s===f.session.id)b.push(e.id)})
  const first=await f.send('first'),second=await f.send('second')
  // No NOTIFY listener is present: polling alone must recover the committed log.
  await r1.pollOnce(500);await r2.pollOnce(500)
  expect(a).toEqual([first.event.id,second.event.id]);expect(b).toEqual(a)
  await r1.pollOnce(500);expect(a).toHaveLength(2)
  const third=await f.send('third')
  const crash=new TeamEventFanout(pool,`r2-${f.key}`,async(s,_,e)=>{if(s===f.session.id){b.push(e.id);throw new Error('commit-before-cursor crash')}})
  await expect(crash.pollOnce(500)).rejects.toThrow('crash')
  await r2.pollOnce(500)
  expect(b.filter(id=>id===third.event.id)).toHaveLength(2)
  expect(new Set(b)).toEqual(new Set([first.event.id,second.event.id,third.event.id]))
  expect((await pool.query(`SELECT COUNT(*)::int n FROM collaboration_calls WHERE team_session_id=$1`,[f.session.id])).rows[0].n).toBe(0)
 })
 test('same-node concurrent consumers serialize cursor updates and permission removal excludes the audience',async()=>{
  const f=await humanTeamFixture(pool),received:string[]=[],audiences:number[][]=[]
  const deliver=async(s:string,p:number[],e:{id:string})=>{if(s===f.session.id){received.push(e.id);audiences.push(p)}}
  const first=new TeamEventFanout(pool,`same-${f.key}`,deliver),second=new TeamEventFanout(pool,`same-${f.key}`,deliver)
  const note=await f.send('concurrent')
  await f.service.removeParticipant({sessionId:f.session.id,actorUserId:f.users[0],userId:f.users[2],expectedRevision:1,requestId:'remove'})
  await Promise.all([first.pollOnce(500),second.pollOnce(500)])
  expect(received).toEqual([note.event.id]);expect(audiences[0]).not.toContain(f.users[2])
 })
})
