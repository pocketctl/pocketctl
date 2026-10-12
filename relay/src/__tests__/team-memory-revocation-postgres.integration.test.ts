import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {initDB} from '../db.js'
import {TeamSessionService} from '../team/session-service.js'
import {TeamRepository} from '../team/repository.js'
import {TeamMemorySourceProjector,teamSourceSessionId} from '../team/memory-source-projector.js'
const url=process.env.RELAY_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL
const suite=url&&process.env.RUN_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('Team membership durable Memory revocation',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{
  const parsed=new URL(url!),name=parsed.pathname.slice(1)
  if(parsed.hostname!=='127.0.0.1'||name!=='pocketctl_relay_upgrade_test'||parsed.username!==name||parsed.searchParams.has('options'))throw new Error('isolated test database required')
  pool=new pg.Pool({connectionString:url})
  const identity=(await pool.query('SELECT current_database() AS name,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0]
  if(identity.name!==name||identity.role!==name||identity.superuser)throw new Error('test identity mismatch')
  await initDB(pool)
 },60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE extension_source_outbox,extension_providers,users RESTART IDENTITY CASCADE')})
 async function fixture(){
  const teams=new TeamRepository(pool),key=randomUUID(),session='css_'+key,binding='cmbd_'+key,membership='cmm_'+key,target=randomUUID()
  const users=(await pool.query("INSERT INTO users(email,password_hash,team_enabled) VALUES($1,'x',true),($2,'x',true) RETURNING id",[key+'-owner@example.test',key+'-member@example.test'])).rows
  const owner=Number(users[0].id),member=Number(users[1].id),team=(await teams.createTeam({actorUserId:owner,name:'Memory lifecycle',requestId:key})).team
  await pool.query("INSERT INTO collaboration_team_memberships(membership_id,team_id,user_id) VALUES($1,$2,$3)",[membership,team.id,member])
  await pool.query("INSERT INTO extension_providers(provider_id,manifest_version,manifest) VALUES('pocketctl-memory',1,'{}'::jsonb)")
  for(const userId of [owner,member])await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
   VALUES(gen_random_uuid(),'pocketctl-memory',$1,'personal',gen_random_uuid(),'active','{}','{session.event.v1}','{memory.manage}','{}','from_now')`,[userId])
  await pool.query(`INSERT INTO extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,event_filter,start_policy)
   VALUES($1,'pocketctl-memory','team',gen_random_uuid(),'active','{}','{}','{}','{}','from_now')`,[target])
  await pool.query('INSERT INTO collaboration_sessions(team_session_id,team_id,creator_user_id,title) VALUES($1,$2,$3,\'Memory lifecycle\')',[session,team.id,owner])
  for(const userId of [owner,member])await pool.query('INSERT INTO collaboration_session_participants(participant_id,team_session_id,user_id,added_by_user_id) VALUES($3,$1,$2,$4)',[session,userId,'csp_'+key+'_'+userId,owner])
  await pool.query("INSERT INTO team_memory_bindings(binding_id,team_id,owner_scope_kind,owner_scope_id,installation_id,created_by_user_id) VALUES($1,$2,'team',$3,$3,$4)",[binding,team.id,target,owner])
  function leave(){return teams.leaveTeam({teamId:team.id,actorUserId:member,expectedRevision:1,requestId:'leave'})}
  return{teams,team,owner,member,session,binding,membership,target,leave}
 }
 test.each(['leave','remove','dissolve'])('%s commits generation-bound revocation with membership transition',async(operation)=>{
  const f=await fixture()
  const input={teamId:f.team.id,actorUserId:operation==='leave'?f.member:f.owner,expectedRevision:1,requestId:operation}
  const mutate=()=>operation==='leave'?f.teams.leaveTeam(input):operation==='remove'?f.teams.removeMember({...input,membershipId:f.membership}):f.teams.dissolveTeam(input)
  await mutate()
  const events=(await pool.query("SELECT owner_user_id,session_id,payload FROM extension_source_outbox WHERE source_kind='session_access_revoked' ORDER BY owner_user_id,session_id")).rows
  expect(events).toHaveLength(operation==='dissolve'?4:2)
  const recipient=events.filter(e=>Number(e.owner_user_id)===f.member)
  expect(recipient).toHaveLength(2)
  expect(recipient.some(e=>e.session_id===teamSourceSessionId({teamSessionId:f.session,bindingId:f.binding,bindingRevision:1,participantRevision:1}))).toBe(true)
  for(const e of recipient)expect(e.payload).toMatchObject({team_id:f.team.id,team_session_id:f.session,team_memory_binding_id:f.binding,team_memory_binding_revision:1,participant_user_id:f.member,participant_revision:1})
  expect((await pool.query('SELECT state,revision::int FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2',[f.session,f.member])).rows[0]).toEqual({state:'removed',revision:2})
  await mutate()
  expect((await pool.query("SELECT count(*)::int AS n FROM extension_source_outbox WHERE source_kind='session_access_revoked'")).rows[0].n).toBe(events.length)
 })
 test('Session re-entry creates a new participant generation untouched by an old revoke retry',async()=>{
  const f=await fixture()
  const sessions=new TeamSessionService(pool,{},new TeamMemorySourceProjector(false))
  await sessions.removeParticipant({sessionId:f.session,actorUserId:f.owner,userId:f.member,expectedRevision:1,requestId:'reader-remove'})
  await sessions.addParticipant({sessionId:f.session,actorUserId:f.owner,userId:f.member,expectedRevision:2,requestId:'reader-rejoin'})
  const participant=(await pool.query('SELECT state,revision::int FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2',[f.session,f.member])).rows[0]
  expect(participant).toEqual({state:'active',revision:3})
  const oldSession=teamSourceSessionId({teamSessionId:f.session,bindingId:f.binding,bindingRevision:1,participantRevision:1})
  const newSession=teamSourceSessionId({teamSessionId:f.session,bindingId:f.binding,bindingRevision:1,participantRevision:3})
  expect(newSession).not.toBe(oldSession)
  await new TeamMemorySourceProjector(false).revokeReaderSession(pool,{teamSessionId:f.session,userId:f.member,participantRevision:1,reason:'participant_removed'})
  expect((await pool.query("SELECT count(*)::int AS n FROM extension_source_outbox WHERE source_kind='session_access_revoked' AND owner_user_id=$1",[f.member])).rows[0].n).toBe(2)
  expect((await pool.query("SELECT count(*)::int AS n FROM extension_source_outbox WHERE session_id=$1",[newSession])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT state,revision::int FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2',[f.session,f.member])).rows[0]).toEqual(participant)
 })
 test('cleanup remains enabled when new Team source capture is off',async()=>{
  const f=await fixture()
  expect(await new TeamMemorySourceProjector(false).revokeReaderSession(pool,{teamSessionId:f.session,userId:f.member,participantRevision:1,reason:'participant_removed'})).toBe(2)
 })
 test('adding an already-active reader preserves the generation later revoked on removal',async()=>{
  const f=await fixture(),sessions=new TeamSessionService(pool,{},new TeamMemorySourceProjector(false))
  await sessions.addParticipant({sessionId:f.session,actorUserId:f.owner,userId:f.member,expectedRevision:1,requestId:'already-reader'})
  expect((await pool.query('SELECT state,revision::int FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2',[f.session,f.member])).rows[0]).toEqual({state:'active',revision:1})
  await sessions.removeParticipant({sessionId:f.session,actorUserId:f.owner,userId:f.member,expectedRevision:2,requestId:'remove-reader'})
  const originalSession=teamSourceSessionId({teamSessionId:f.session,bindingId:f.binding,bindingRevision:1,participantRevision:1})
  expect((await pool.query("SELECT count(*)::int AS n FROM extension_source_outbox WHERE source_kind='session_access_revoked' AND session_id=$1",[originalSession])).rows[0].n).toBe(1)
 })
 test('adding an Agent owned by an active reader preserves that reader generation',async()=>{
  const f=await fixture(),sessions=new TeamSessionService(pool,{},new TeamMemorySourceProjector(false)),daemon=randomUUID()
  await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
   VALUES($1,'reader-agent-fixture','[{"type":"codex","manageable":true}]','online',$2,
    '["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`,[daemon,f.member])
  const offer=await f.teams.addAgentOffer({teamId:f.team.id,actorUserId:f.member,daemonId:daemon,provider:'codex',runtimeProfileId:null,expectedRevision:1,requestId:'offer'})
  await sessions.changeBinding({sessionId:f.session,actorUserId:f.owner,offerId:offer.id,active:true,expectedRevision:1,requestId:'add-agent'})
  expect((await pool.query('SELECT state,revision::int FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2',[f.session,f.member])).rows[0]).toEqual({state:'active',revision:1})
  await f.leave()
  const originalSession=teamSourceSessionId({teamSessionId:f.session,bindingId:f.binding,bindingRevision:1,participantRevision:1})
  expect((await pool.query("SELECT count(*)::int AS n FROM extension_source_outbox WHERE source_kind='session_access_revoked' AND session_id=$1",[originalSession])).rows[0].n).toBe(1)
 })
 test('paused personal installation still receives durable cleanup before it resumes',async()=>{
  const f=await fixture()
  await pool.query("UPDATE extension_installations SET status='paused' WHERE owner_user_id=$1 AND owner_scope_kind='personal'",[f.member])
  await f.leave()
  expect((await pool.query("SELECT count(*)::int AS n FROM extension_source_outbox WHERE source_kind='session_access_revoked' AND owner_user_id=$1",[f.member])).rows[0].n).toBe(2)
  await pool.query("UPDATE extension_installations SET status='active' WHERE owner_user_id=$1 AND owner_scope_kind='personal'",[f.member])
 })
 test('failed outbox write rolls back membership and participant generations',async()=>{
  const f=await fixture()
  await pool.query(`CREATE OR REPLACE FUNCTION test_reject_memory_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_kind='session_access_revoked' THEN RAISE EXCEPTION 'injected revoke failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_memory_revoke BEFORE INSERT ON extension_source_outbox FOR EACH ROW EXECUTE FUNCTION test_reject_memory_revoke()`)
  try{
   await expect(f.leave()).rejects.toThrow('injected revoke failure')
   expect((await pool.query('SELECT state,revision::int FROM collaboration_team_memberships WHERE membership_id=$1',[f.membership])).rows[0]).toEqual({state:'active',revision:1})
   expect((await pool.query('SELECT state,revision::int FROM collaboration_session_participants WHERE team_session_id=$1 AND user_id=$2',[f.session,f.member])).rows[0]).toEqual({state:'active',revision:1})
   expect((await pool.query('SELECT count(*)::int AS n FROM extension_source_outbox')).rows[0].n).toBe(0)
  }finally{await pool.query('DROP TRIGGER reject_memory_revoke ON extension_source_outbox; DROP FUNCTION test_reject_memory_revoke()')}
 })
})
