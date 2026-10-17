import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { beforeAll,afterAll,describe,test,expect } from 'vitest'
import { initDB } from '../db.js'
import {TeamDispatchRepository} from '../team/dispatch-repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamAgentConfigService,runtimeConfigHash } from '../team/agent-config-service.js'

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1' && process.env.TEST_DATABASE_URL
;(enabled ? describe : describe.skip)('Team binding configuration (PostgreSQL)',() => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!)
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/team_relay_test' || url.username !== 'team_relay_test') throw new Error('isolated Team database required')
    pool = new pg.Pool({connectionString:url.toString()});await initDB(pool)
  })
  afterAll(async () => {if(pool){await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE');await pool.end()}})
  async function fixture() {
    const key = randomUUID(),teamId=`config-${key}`,daemon=`daemon-${key}`,offer=`offer-${key}`
    const users = (await pool.query(`INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'x',true),($2,'x',true) RETURNING id`,[`${key}-a@example.test`,`${key}-b@example.test`])).rows
    const owner=Number(users[0].id),member=Number(users[1].id)
    await pool.query(`INSERT INTO collaboration_teams(team_id,name,creator_user_id) VALUES($1,'config',$2)`,[teamId,owner])
    for (const u of [owner,member]) await pool.query(`INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id,role) VALUES($1,$2,$3,$4)`,[`m-${key}-${u}`,teamId,u,u===owner?'admin':'member'])
    const capability={schema_version:2,revision:'cap-1',models:[{id:'model-a',reasoning_efforts:['low','high']},{id:'model-b',reasoning_efforts:[]}],permission_profiles:['request_approval','read_only'],default_config:{model:'model-a',reasoning_effort:'low',permission_profile:'request_approval'},default_source:'local-settings',runtime_switch:'recreate',read_only:true}
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,status,user_id,agents,collaboration_capabilities) VALUES($1,'config','online',$2,$3::jsonb,$4::jsonb)`,[daemon,owner,JSON.stringify([{type:'codex',manageable:true,team_config:capability}]),JSON.stringify(['team_collaboration_dispatch_v1','team_collaboration_context_v1','team_collaboration_config_v2'])])
    await pool.query(`INSERT INTO team_agent_offers(offer_id,team_id,owner_user_id,daemon_id,provider,config_policy) VALUES($1,$2,$3,$4,'codex','{"overridable_fields":["model","reasoning_effort"]}')`,[offer,teamId,owner,daemon])
    const sessions=new TeamSessionService(pool),configs=new TeamAgentConfigService(pool)
    const create=(id:string)=>sessions.createSession({teamId,actorUserId:owner,title:id,taskId:null,offerIds:[offer],participantUserIds:[member],requestId:id})
    const session=await create('first')
    return {owner,member,offer,session,sessions,configs,create,daemon,capability}
  }
  test('freezes the creation default, isolates sessions, restores its snapshot and distinguishes pending from applied',async()=>{
    const f=await fixture(),second=await f.create('second')
    const input={sessionId:f.session.id,offerId:f.offer,actorUserId:f.owner,requestId:'change',expectedRevision:1,mode:'custom' as const,override:{model:'model-b',reasoning_effort:null},capabilityRevision:'cap-1'}
    const result=await f.configs.update(input)
    expect(result).toMatchObject({status:'pending',config_revision:2,applied_config:null,requested_config:{model:'model-b',reasoning_effort:null}})
    expect((await f.sessions.getSession(second.id,f.owner)).agent_bindings[0].config?.requested_config?.model).toBe('model-a')
    expect(await f.configs.update(input)).toEqual(result)
    await expect(f.configs.update({...input,override:{model:'model-a'}})).rejects.toMatchObject({code:'idempotency_conflict'})
    const cap={...f.capability,default_config:{...f.capability.default_config,model:'model-b',reasoning_effort:null}}
    await pool.query(`UPDATE daemons SET agents=$2::jsonb WHERE daemon_id=$1`,[f.daemon,JSON.stringify([{type:'codex',manageable:true,team_config:cap}])])
    const restored=await f.configs.update({...input,requestId:'restore',expectedRevision:2,mode:'default',override:{}})
    expect(restored.requested_config?.model).toBe('model-a')
    expect(restored.applied_revision).toBeNull()
  })
  test('only the owner can delegate fields, revoke with CAS, and preserve native Offer identity',async()=>{
    const f=await fixture(),teamId=f.session.team_id
    const input={teamId,offerId:f.offer,actorUserId:f.owner,requestId:'delegate-policy',expectedRevision:1,fields:['model']}
    const before=(await pool.query(`SELECT revision FROM team_agent_offers WHERE offer_id=$1`,[f.offer])).rows[0].revision
    await expect(f.configs.updatePolicy({...input,actorUserId:f.member})).rejects.toMatchObject({code:'team_access_denied'})
    await expect(f.configs.updatePolicy({...input,fields:['permission_profile']})).rejects.toMatchObject({code:'invalid_state'})
    expect(await f.configs.updatePolicy(input)).toEqual({policy_revision:2,overridable_fields:['model']})
    expect(await f.configs.updatePolicy(input)).toEqual({policy_revision:2,overridable_fields:['model']})
    await expect(f.configs.updatePolicy({...input,fields:[]})).rejects.toMatchObject({code:'idempotency_conflict'})
    await expect(f.configs.updatePolicy({...input,requestId:'stale'})).rejects.toMatchObject({code:'revision_conflict'})
    expect(await f.configs.updatePolicy({...input,requestId:'revoke',expectedRevision:2,fields:[]})).toEqual({policy_revision:3,overridable_fields:[]})
    expect((await pool.query(`SELECT revision FROM team_agent_offers WHERE offer_id=$1`,[f.offer])).rows[0].revision).toBe(before)
    await expect(f.configs.update({sessionId:f.session.id,offerId:f.offer,actorUserId:f.member,requestId:'after-revoke',expectedRevision:1,mode:'custom',override:{model:'model-b'},capabilityRevision:'cap-1'})).rejects.toMatchObject({code:'offer_owner_required'})
  })
  test('enforces owner permission boundary, model-effort capability, CAS and current access on replay',async()=>{
    const f=await fixture()
    const input={sessionId:f.session.id,offerId:f.offer,actorUserId:f.member,requestId:'member',expectedRevision:1,mode:'custom' as const,override:{model:'model-a',reasoning_effort:'high'},capabilityRevision:'cap-1'}
    for (const override of [{permission_profile:'read_only'},{owner_user_id:123},{model:'unknown'},{model:'model-b',reasoning_effort:'high'}]) {
      await expect(f.configs.update({...input,override,requestId:randomUUID()})).rejects.toBeInstanceOf(Error)
    }
    const results=await Promise.allSettled([f.configs.update(input),f.configs.update({...input,actorUserId:f.owner,requestId:'race',override:{model:'model-b',reasoning_effort:null}})])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'revision_conflict',currentRevision:2}})
    await pool.query(`UPDATE collaboration_session_participants SET state='removed' WHERE team_session_id=$1 AND user_id=$2`,[f.session.id,f.member])
    await expect(f.configs.update(input)).rejects.toMatchObject({code:'team_not_found'})
  })
  test('hashes normalized runtime configuration deterministically',()=>{
    expect(runtimeConfigHash({model:'m',reasoning_effort:null,permission_profile:'read_only'})).toBe(runtimeConfigHash({permission_profile:'read_only',reasoning_effort:null,model:'m'}))
  })
  test('late same-revision mode receipts cannot replace the newer effective runtime',async()=>{
    const f=await fixture(),dispatch=new TeamDispatchRepository(pool)
    const first=await f.sessions.appendMessage({sessionId:f.session.id,actorUserId:f.owner,requestId:'first-runtime',content:'first',targetMode:'offers',targetOfferIds:[f.offer],referenceEventId:null})
    const second=await f.sessions.appendMessage({sessionId:f.session.id,actorUserId:f.owner,requestId:'second-runtime',content:'second',targetMode:'offers',targetOfferIds:[f.offer],referenceEventId:null})
    const readonly={...f.capability.default_config,permission_profile:'read_only'},normal=f.capability.default_config
    await pool.query(`UPDATE collaboration_calls SET requested_config=$2::jsonb,config_hash=$3 WHERE call_id=$1`,[first.call_ids[0],JSON.stringify(readonly),runtimeConfigHash(readonly)])
    expect(await dispatch.recordConfigReceipt(first.call_ids[0],f.daemon,f.owner,readonly,1,runtimeConfigHash(readonly))).toBe(true)
    expect((await f.sessions.getSession(f.session.id,f.owner)).agent_bindings[0].config?.status).toBe('pending')
    expect(await dispatch.recordConfigReceipt(second.call_ids[0],f.daemon,f.owner,normal,1,runtimeConfigHash(normal))).toBe(true)
    expect(await dispatch.recordConfigReceipt(first.call_ids[0],f.daemon,f.owner,readonly,1,runtimeConfigHash(readonly))).toBe(true)
    const config=(await f.sessions.getSession(f.session.id,f.owner)).agent_bindings[0].config
    expect(config).toMatchObject({status:'applied',applied_config:normal})
    const historical=(await pool.query('SELECT applied_config FROM collaboration_calls WHERE call_id=$1',[first.call_ids[0]])).rows[0]
    expect(historical.applied_config).toEqual(readonly)
  })

})
