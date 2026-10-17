import type pg from 'pg'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {TeamReadStateService} from '../team/read-state-service.js'
import {teamV2DatabaseEnabled,teamV2Pool,humanTeamFixture} from './fixtures/team-v2.js'
;(teamV2DatabaseEnabled?describe:describe.skip)('Team sync and reads (PostgreSQL)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=await teamV2Pool()});afterAll(async()=>{if(pool){await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE');await pool.end()}})
 test('pages to an explicit completed interval, reconciles only own requests and resets retained history',async()=>{
  const f=await humanTeamFixture(pool)
  const messages=[]
  for(let n=0;n<5;n++)messages.push(await f.send(`message-${n}`))
  const first=await f.service.listEvents(f.session.id,f.users[1],0,2)
  expect(first).toMatchObject({shared_high_water:5,completed_through:2,next_cursor:2,reset_required:false})
  expect((await f.service.listEvents(f.session.id,f.users[1],4,2))).toMatchObject({shared_high_water:5,completed_through:5,next_cursor:null})
  expect((await f.service.messageByRequest(f.session.id,f.users[0],'message-0')).event.id).toBe(messages[0].event.id)
  await expect(f.service.messageByRequest(f.session.id,f.users[1],'message-0')).rejects.toMatchObject({code:'team_not_found'})
  await pool.query(`UPDATE collaboration_sessions SET retained_after_seq=3 WHERE team_session_id=$1`,[f.session.id])
  const reset=await f.service.listEvents(f.session.id,f.users[1],1,20)
  expect(reset).toMatchObject({reset_required:true,retained_after_seq:3,completed_through:5})
  expect(reset.events.map(e=>e.event_seq)).toEqual([4,5])
 })
 test('keeps device read positions monotonic, rejects future cursors and excludes own/system messages',async()=>{
  const f=await humanTeamFixture(pool),reads=new TeamReadStateService(pool)
  await f.send('own',f.users[1]);await f.send('incoming-1');await f.send('incoming-2')
  expect(await reads.summary(f.session.id,f.users[1])).toMatchObject({unread_count:2,preview:'incoming-2'})
  await Promise.all([reads.advance(f.session.id,f.users[1],3),reads.advance(f.session.id,f.users[1],1)])
  expect(await reads.summary(f.session.id,f.users[1])).toMatchObject({unread_count:0,read_event_seq:3})
  await expect(reads.advance(f.session.id,f.users[1],4)).rejects.toMatchObject({code:'invalid_state'})
  await f.service.removeParticipant({sessionId:f.session.id,actorUserId:f.users[0],userId:f.users[1],expectedRevision:1,requestId:'remove'})
  await expect(reads.advance(f.session.id,f.users[1],3)).rejects.toMatchObject({code:'team_not_found'})
 })
})
