import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {beforeAll,afterAll,describe,test,expect,vi} from 'vitest'
import {TeamInteractionService,recoverTeamPrivateResolutions} from '../team/interaction-service.js'
import {AttentionInboxRepository} from '../attention-inbox/repository.js'
import type {AttentionInboxService} from '../attention-inbox/service.js'
import {teamV2DatabaseEnabled,teamV2Pool,humanTeamFixture} from './fixtures/team-v2.js'
;(teamV2DatabaseEnabled?describe:describe.skip)('Team owner-private native Inbox view (PostgreSQL)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=await teamV2Pool()});afterAll(async()=>{if(pool){await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE');await pool.end()}})
 test('recovers a trusted native resolution skipped by an older worker without replaying its cursor',async()=>{
  const f=await humanTeamFixture(pool),owner=f.users[1],daemon=`rollback-${f.key}`,native=`native-${f.key}`,item=randomUUID()
  await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id) VALUES($1,'rollback','online',$2)`,[daemon,owner])
  await pool.query(`INSERT INTO sessions(session_id,daemon_id,user_id,agent_type,control_mode,status) VALUES($1,$2,$3,'claude-code','managed','idle')`,[native,daemon,owner])
  await pool.query(`INSERT INTO attention_items(item_id,user_id,daemon_id,session_id,request_id,provider,kind,state,title,context,allowed_actions,source_event_type) VALUES($1,$2,$3,$4,'rollback-request','claude-code','approval','open','Approval','{"team_native_request":true}','[{"id":"once"},{"id":"reject"}]','approval_request')`,[item,owner,daemon,native])
  const event=(await pool.query(`INSERT INTO events(session_id,event_type,payload) VALUES($1,'approval_resolved','{"request_id":"rollback-request","approved":false}') RETURNING id`,[native])).rows[0].id
  await pool.query(`UPDATE attention_projection_cursor SET last_event_id=$1 WHERE projector_name='attention-inbox-v1'`,[event])
  const repository=new AttentionInboxRepository(pool,'test-only')
  expect(await recoverTeamPrivateResolutions(pool,repository)).toBe(1)
  expect((await pool.query(`SELECT state FROM attention_items WHERE item_id=$1`,[item])).rows[0].state).toBe('resolved')
  expect(await recoverTeamPrivateResolutions(pool,repository)).toBe(0)
  expect(Number((await pool.query(`SELECT last_event_id FROM attention_projection_cursor WHERE projector_name='attention-inbox-v1'`)).rows[0].last_event_id)).toBe(Number(event))
 })
 test('links the same native request, excludes nonowners and closes Team access after removal',async()=>{
  const f=await humanTeamFixture(pool),owner=f.users[1],daemon=`d-${f.key}`,offer=`o-${f.key}`,item=randomUUID(),native=`n-${f.key}`
  await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'private','online',$2,'[{"type":"codex","manageable":true}]','["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`,[daemon,owner])
  await pool.query(`INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider) VALUES($1,$2,$3,$4,'codex')`,[offer,f.teamId,owner,daemon])
  const session=await f.service.changeBinding({sessionId:f.session.id,actorUserId:f.users[0],offerId:offer,active:true,expectedRevision:1,requestId:'bind'})
  const message=await f.service.appendMessage({sessionId:session.id,actorUserId:f.users[0],requestId:'dispatch',content:'public request',targetMode:'offers',targetOfferIds:[offer],referenceEventId:null})
  await pool.query(`UPDATE collaboration_session_agent_bindings SET native_session_id=$2 WHERE team_session_id=$1`,[session.id,native])
  await pool.query(`UPDATE collaboration_calls SET native_session_id=$2,state='accepted' WHERE call_id=$1`,[message.call_ids[0],native])
  await pool.query(`INSERT INTO attention_items(item_id,user_id,daemon_id,session_id,request_id,provider,kind,state,title,context,allowed_actions,source_event_type)
    VALUES($1,$2,$3,$4,'native-private-request','codex','approval','open','Approval','{"command":"PRIVATE_E10"}','[{"id":"once"},{"id":"reject"}]','approval_request')`,[item,owner,daemon,native])
  const submitAction=vi.fn(async()=>({outcome:'already_submitting',item:{},final:false}))
  const service=new TeamInteractionService(pool,{submitAction} as unknown as AttentionInboxService)
  expect((await service.list(session.id,owner)).items[0]).toMatchObject({item_id:item,request_id:'native-private-request',context:{command:'PRIVATE_E10'}})
  expect((await service.list(session.id,f.users[0])).items).toEqual([])
  await expect(service.submit({sessionId:session.id,userId:f.users[0],itemId:item,idempotencyKey:randomUUID(),expectedRevision:1,action:'once'})).rejects.toMatchObject({code:'team_not_found'})
  expect(submitAction).not.toHaveBeenCalled()
  const shared=JSON.stringify(await f.service.listEvents(session.id,f.users[0],0,100))
  expect(shared).not.toContain('PRIVATE_E10');expect(shared).not.toContain('native-private-request')
  expect(JSON.stringify((await pool.query(`SELECT j.* FROM team_event_journal j WHERE team_session_id=$1`,[session.id])).rows)).not.toContain('PRIVATE_E10')
  await f.service.removeParticipant({sessionId:session.id,actorUserId:f.users[0],userId:owner,expectedRevision:session.revision,requestId:'remove-owner'})
  await expect(service.list(session.id,owner)).rejects.toMatchObject({code:'team_not_found'})
  expect((await pool.query(`SELECT state FROM attention_items WHERE item_id=$1 AND user_id=$2`,[item,owner])).rows[0].state).toBe('open')
 })
})
