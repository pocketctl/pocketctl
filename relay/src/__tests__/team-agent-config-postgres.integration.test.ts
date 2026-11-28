import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { beforeAll,afterAll,describe,test,expect,vi } from 'vitest'
import { initDB } from '../db.js'
import {TeamContextDeliveryService} from '../team/context-delivery.js'
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
  test.each(['independent','plan'])('group %s is shared, revision-fenced and confirmed exactly once',async mode=>{
    const f=await fixture(), queued:string[]=[]
    const sessions=new TeamSessionService(pool,{dispatch: ids=>{queued.push(...ids)}},undefined,undefined,()=>true,()=>false,()=>true)
    await pool.query(`UPDATE daemons SET collaboration_capabilities=collaboration_capabilities || '["team_task_delivery_v1","team_task_steps_v1"]'::jsonb WHERE daemon_id=$1`,[f.daemon])
    const source=await sessions.appendMessage({sessionId:f.session.id,actorUserId:f.owner,requestId:'source',content:'Implement the plan',targetMode:'discussion',targetOfferIds:[],referenceEventId:null,contextVersion:0})
    const service=sessions.assignments
    const open=(actor:number)=>service.mutate(f.session.id,actor,'open','',{request_id:'open',source_event_id:source.event.id})
    const [draft,shared]=await Promise.all([open(f.owner),open(f.member)])
    expect(shared.assignment_id).toBe(draft.assignment_id)
    const items=['api','web'].map(id=>({item_id:id,offer_id:f.offer,instruction:id,acceptance:'test the change',reviewer_user_id:f.member,required_checks:['unit'],depends_on:[]}))
    const edit={request_id:'update',proposal:'Reviewed plan',mode,items,reference_event_ids:[source.event.id],context_version:f.session.current_context_version,expected_revision:draft.revision}
    const saved=await service.mutate(f.session.id,f.owner,'edit',draft.assignment_id,edit)
    const confirm=(actor:number)=>service.mutate(f.session.id,actor,'confirm',draft.assignment_id,{request_id:'confirm',expected_revision:saved.revision})
    await pool.query("UPDATE daemons SET status='offline' WHERE daemon_id=$1",[f.daemon])
    await expect(confirm(f.member)).rejects.toMatchObject({code:'agent_unavailable'})
    expect((await service.find(f.session.id,f.owner,'id',draft.assignment_id)).items.every((i:any)=>!i.task_id)).toBe(true)
    await pool.query("UPDATE daemons SET status='online' WHERE daemon_id=$1",[f.daemon])
    const [one,two]=await Promise.all([confirm(f.member),confirm(f.owner)])
    expect(one.confirmed_by).toBe(two.confirmed_by)
    expect(new Set(one.items.map((i:any)=>i.task_id)).size).toBe(mode==='plan'?1:2)
    expect(one.items.every((i:any)=>!!i.task_id)).toBe(true)
    expect(queued.length).toBe(mode==='plan'?0:2)
    for(const call of queued) {
      const content=await new TeamContextDeliveryService(pool).prepare(call)
      expect(content.stable_text).toContain('"proposal":"Reviewed plan"')
      expect(content.stable_text).toContain(source.event.id)
    }
    expect((await service.find(f.session.id,f.member,'source',source.event.id)).confirmed_by).toBe(one.confirmed_by)
  })
  test('one participant can ask another participant’s Agent read-only with a frozen context and one call on replay', async () => {
    vi.stubEnv('TEAM_DISCUSSIONS_V2', 'on')
    try {
      const f = await fixture()
      const input = { sessionId: f.session.id, actorUserId: f.member, requestId: 'question', content: 'How would you implement this?',
        targetMode: 'readonly_offer' as const, targetOfferIds: [f.offer], referenceEventId: null as string | null, contextVersion: f.session.current_context_version }
      const group = await f.sessions.appendMessage({...input, requestId:'human', targetMode:'discussion',targetOfferIds:[]})
      expect(group.call_ids).toEqual([])
      input.referenceEventId = group.event.id
      const result = await f.sessions.appendMessage(input)
      expect(result.call_ids).toHaveLength(1)
      expect(result.event).toMatchObject({target_mode:'readonly_offer',reference:{event_id:group.event.id}})
      expect(await f.sessions.appendMessage(input)).toEqual(result)
      await expect(f.sessions.appendMessage({...input, contextVersion:input.contextVersion + 1})).rejects.toMatchObject({code:'idempotency_conflict'})
      await expect(f.sessions.appendMessage({...input, targetMode:'offers'})).rejects.toMatchObject({code:'idempotency_conflict'})
      await expect(f.sessions.appendMessage({...input, requestId:'stale', contextVersion:input.contextVersion + 1})).rejects.toMatchObject({code:'revision_conflict'})
      const dispatch = new TeamDispatchRepository(pool)
      const claimed = await dispatch.claim(result.call_ids[0])
      expect(claimed?.authorization).toMatchObject({offer_id:f.offer,owner_user_id:f.owner,execution_mode:'discussion',
        requested_config:{permission_profile:'read_only'},binding_id:f.session.agent_bindings[0].id})
      expect((await f.sessions.getSession(f.session.id,f.member)).agent_bindings[0]).toMatchObject({read_only_question:true,
        config:{requested_config:{permission_profile:'request_approval'}}})
    } finally { vi.unstubAllEnvs() }
  })

  test('a group member can confirm a completed read-only proposal back to its original Agent',async()=>{
    vi.stubEnv('TEAM_DISCUSSIONS_V2','on')
    try{
      const f=await fixture()
      const sessions=new TeamSessionService(pool,{},undefined,undefined,()=>true)
      await pool.query(`UPDATE daemons SET collaboration_capabilities=collaboration_capabilities || '["team_task_delivery_v1"]'::jsonb WHERE daemon_id=$1`,[f.daemon])
      const root=await sessions.appendMessage({sessionId:f.session.id,actorUserId:f.owner,requestId:'root',content:'Feature request',targetMode:'discussion',targetOfferIds:[],referenceEventId:null,contextVersion:0})
      const question=await sessions.appendMessage({sessionId:f.session.id,actorUserId:f.member,requestId:'read',content:'What should we implement?',targetMode:'readonly_offer',targetOfferIds:[f.offer],referenceEventId:root.event.id,contextVersion:0})
      const dispatcher=new TeamDispatchRepository(pool),call=question.call_ids[0],native='test-'+randomUUID()
      expect((await dispatcher.claim(call))?.authorization.execution_mode).toBe('discussion')
      await dispatcher.bindNativeSession(call,f.daemon,f.owner,native)
      const answer=await dispatcher.projectDaemonEvent(f.daemon,f.owner,{type:'agent_text',session_id:native,seq:1,text:'Implement the agreed plan'})
      expect(answer).not.toBeNull()
      await dispatcher.projectDaemonEvent(f.daemon,f.owner,{type:'turn_status',session_id:native,seq:2,turn_status:'completed'})
      const group=sessions.assignments
      const draft=await group.mutate(f.session.id,f.member,'open','',{request_id:'open',source_event_id:answer!.event.id})
      expect(draft).toMatchObject({mode:'original',source_offer_id:f.offer,thread_event_id:root.event.id})
      const item={item_id:'implement',offer_id:f.offer,instruction:'Implement',acceptance:'Reviewed',reviewer_user_id:f.member,required_checks:['unit'],depends_on:[]}
      const saved=await group.mutate(f.session.id,f.member,'edit',draft.assignment_id,{request_id:'edit',expected_revision:1,mode:'original',proposal:draft.source_text,context_version:0,reference_event_ids:[question.event.id],items:[item]})
      const done=await group.mutate(f.session.id,f.owner,'confirm',draft.assignment_id,{request_id:'confirm',expected_revision:saved.revision})
      expect(done.items[0]).toMatchObject({owner_user_id:f.owner,reviewer_user_id:f.member,offer_id:f.offer,task_id:expect.any(String)})
      expect(done.items[0].call_id).not.toBe(call)
      expect((await pool.query("SELECT reference_event_id FROM collaboration_events WHERE team_session_id=$1 AND kind='system' ORDER BY event_seq DESC LIMIT 1",[f.session.id])).rows[0].reference_event_id).toBe(root.event.id)
    }finally{vi.unstubAllEnvs()}
  })
  test('a capability withdrawn after acceptance blocks dispatch before a daemon command is built', async () => {
    vi.stubEnv('TEAM_DISCUSSIONS_V2','on')
    try {
      const f = await fixture()
      const result = await f.sessions.appendMessage({ sessionId:f.session.id, actorUserId:f.member, requestId:'question', content:'Explain this',
        targetMode:'readonly_offer', targetOfferIds:[f.offer], referenceEventId:null, contextVersion:f.session.current_context_version })
      await pool.query('UPDATE daemons SET agents=$2::jsonb WHERE daemon_id=$1',
        [f.daemon,JSON.stringify([{type:'codex',manageable:true,team_config:{...f.capability,read_only:false}}])])
      expect(await new TeamDispatchRepository(pool).claim(result.call_ids[0])).toBeNull()
      expect((await pool.query('SELECT state,outcome FROM collaboration_calls WHERE call_id=$1',result.call_ids)).rows[0])
        .toMatchObject({state:'blocked',outcome:'configuration_requires_confirmation'})
    } finally { vi.unstubAllEnvs() }
  })

  test('unsupported read-only questions roll back the event, sequence and call, and never fall back to execution', async () => {
    vi.stubEnv('TEAM_DISCUSSIONS_V2','on')
    try {
      const f = await fixture()
      await pool.query("UPDATE daemons SET agents=$2::jsonb WHERE daemon_id=$1",[f.daemon,JSON.stringify([{type:'codex',manageable:true}])])
      const legacy = await f.create('without-config')
      const input = {sessionId:legacy.id,actorUserId:f.member,requestId:'question',content:'Inspect this',targetMode:'readonly_offer' as const,
        targetOfferIds:[f.offer],referenceEventId:null,contextVersion:legacy.current_context_version}
      const before = await f.sessions.getSession(legacy.id,f.member)
      expect(before.agent_bindings[0].read_only_question).toBe(false)
      await expect(f.sessions.appendMessage(input)).rejects.toMatchObject({code:'capability_not_supported'})
      const after = await f.sessions.getSession(legacy.id,f.member)
      expect(after.latest_event_seq).toBe(before.latest_event_seq)
      expect((await pool.query('SELECT call_id FROM collaboration_calls WHERE team_session_id=$1',[legacy.id])).rowCount).toBe(0)
      vi.stubEnv('TEAM_DISCUSSIONS_V2','off')
      await expect(f.sessions.appendMessage(input)).rejects.toMatchObject({code:'team_feature_disabled'})
      expect((await f.sessions.appendMessage({...input,targetMode:'discussion',targetOfferIds:[]})).call_ids).toEqual([])
    } finally { vi.unstubAllEnvs() }
  })
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
