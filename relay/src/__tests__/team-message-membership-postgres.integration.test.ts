import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { TeamRepository } from '../team/repository.js'
import { TeamSessionService } from '../team/session-service.js'
import { TeamContextService } from '../team/context-service.js'
import { TeamMemoryContextBridge } from '../team/memory-context-bridge.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1' ? describe : describe.skip

describeWithDatabase('Team message receipts and recipient identity acceptance (PostgreSQL)', () => {
  let pool: pg.Pool
  beforeAll(async () => {
    const url = new URL(databaseUrl!), database = decodeURIComponent(url.pathname.slice(1))
    if (!['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname) || !/test/i.test(database)
      || decodeURIComponent(url.username) !== database || url.searchParams.has('options')) throw new Error('Refusing non-isolated database')
    pool = new pg.Pool({connectionString:databaseUrl})
    const identity = (await pool.query(`SELECT current_database() AS database,current_user AS "user",
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0]
    if(identity.database!==database || identity.user!==database || identity.superuser) throw new Error('Unexpected database identity')
    await initDB(pool)
  },30_000)
  afterAll(async()=>{if(pool){await pool.query('TRUNCATE users,daemons RESTART IDENTITY CASCADE');await pool.end()}})

  async function fixture(notifier: ConstructorParameters<typeof TeamSessionService>[1] = {}) {
    const key=randomUUID(),teams=new TeamRepository(pool),sessions=new TeamSessionService(pool,notifier),contexts=new TeamContextService(pool)
    const emails=[`${key}.owner@example.test`,`${key}.member@example.test`]
    const users=(await pool.query("INSERT INTO users (email,password_hash, team_enabled) VALUES ($1,'x',true),($2,'x',true) RETURNING id",emails)).rows
    const owner=Number(users[0].id),member=Number(users[1].id)
    const team=(await teams.createTeam({actorUserId:owner,name:'Message acceptance',requestId:key})).team
    const invitation=await teams.invite({teamId:team.id,actorUserId:owner,email:emails[1],expectedRevision:1,requestId:key})
    await teams.respondToInvitation({invitationId:invitation.id,actorUserId:member,action:'accepted',expectedRevision:1,requestId:key})
    const daemons=[`${key}-one`,`${key}-two`]
    await pool.query(`INSERT INTO daemons(daemon_id,hostname,agents,status,user_id,collaboration_capabilities)
      VALUES($1,'one','[{"type":"codex","manageable":true}]','online',$2,'["team_collaboration_dispatch_v1","team_collaboration_context_v1"]'),
      ($3,'two','[{"type":"codex","manageable":true}]','online',$4,'["team_collaboration_dispatch_v1","team_collaboration_context_v1"]')`,[daemons[0],owner,daemons[1],member])
    const one=await teams.addAgentOffer({teamId:team.id,actorUserId:owner,daemonId:daemons[0],provider:'codex',runtimeProfileId:null,expectedRevision:3,requestId:key})
    const two=await teams.addAgentOffer({teamId:team.id,actorUserId:member,daemonId:daemons[1],provider:'codex',runtimeProfileId:null,expectedRevision:4,requestId:key})
    const session=await sessions.createSession({teamId:team.id,actorUserId:owner,title:'Message receipt',taskId:null,offerIds:[one.id],requestId:key})
    const context=await contexts.create({sessionId:session.id,actorUserId:owner,expectedRevision:0,requestId:key,goal:'Original Context',consensus:[],openQuestions:[],references:[]})
    return {key,teams,sessions,contexts,owner,member,team,session,one,two,context:context.context}
  }
  const message=(f:Awaited<ReturnType<typeof fixture>>,targetMode:'discussion'|'all'|'offers'='discussion')=>({sessionId:f.session.id,actorUserId:f.owner,requestId:'stable-message',content:'Unchanged accepted message',targetMode,targetOfferIds:targetMode==='offers'?[f.one.id]:[],referenceEventId:null})
  async function counts(sessionId:string) {
    return (await pool.query(`SELECT (SELECT count(*)::int FROM collaboration_events WHERE team_session_id=$1) AS events,
      (SELECT count(*)::int FROM collaboration_calls WHERE team_session_id=$1) AS calls`,[sessionId])).rows[0]
  }
  test('unchanged message receipt replays once and changed user content conflicts',async()=>{
    const f=await fixture(),input=message(f),original=await f.sessions.appendMessage(input),before=await counts(f.session.id)
    expect(await f.sessions.appendMessage(input)).toEqual(original)
    await expect(f.sessions.appendMessage({...input,content:'Different user content'})).rejects.toMatchObject({code:'idempotency_conflict'})
    expect(await counts(f.session.id)).toEqual(before)
  })
  test.each(['discussion','offers'] as const)('%s receipt preserves its accepted Context after a later Context version',async targetMode=>{
    const f=await fixture(),input=message(f,targetMode),original=await f.sessions.appendMessage(input)
    await f.contexts.create({sessionId:f.session.id,actorUserId:f.owner,expectedRevision:1,requestId:'later-context',goal:'Later Context',consensus:[],openQuestions:[],references:[]})
    const before=await counts(f.session.id)
    expect(await f.sessions.appendMessage(input)).toEqual(original)
    expect(original.event.context_version).toBe(1)
    expect(await counts(f.session.id)).toEqual(before)
  })
  test('all receipt retains its original target set when a new Agent binding is added',async()=>{
    const f=await fixture(),input=message(f,'all'),original=await f.sessions.appendMessage(input)
    await f.sessions.changeBinding({sessionId:f.session.id,actorUserId:f.owner,offerId:f.two.id,active:true,expectedRevision:1,requestId:'new-binding'})
    const before=await counts(f.session.id)
    expect(await f.sessions.appendMessage(input)).toEqual(original)
    expect(original.event.target_offer_ids).toEqual([f.one.id])
    expect(await counts(f.session.id)).toEqual(before)
  })
  test.each(['all','offers'] as const)('%s receipt remains a receipt after its accepted target binding is removed',async targetMode=>{
    const f=await fixture()
    const bound=await f.sessions.changeBinding({sessionId:f.session.id,actorUserId:f.owner,offerId:f.two.id,active:true,expectedRevision:1,requestId:'second-binding'})
    const input=message(f,targetMode),original=await f.sessions.appendMessage(input)
    await f.sessions.changeBinding({sessionId:f.session.id,actorUserId:f.owner,offerId:f.one.id,active:false,expectedRevision:bound.revision,requestId:'remove-target'})
    const before=await counts(f.session.id)
    expect(await f.sessions.appendMessage(input)).toEqual(original)
    expect(await counts(f.session.id)).toEqual(before)
  })
  test('revoked participant cannot replay a retained message receipt',async()=>{
    const f=await fixture()
    const added=await f.sessions.addParticipant({sessionId:f.session.id,actorUserId:f.owner,userId:f.member,expectedRevision:1,requestId:'add-member'})
    const input={...message(f),actorUserId:f.member};await f.sessions.appendMessage(input)
    await f.sessions.removeParticipant({sessionId:f.session.id,actorUserId:f.owner,userId:f.member,expectedRevision:added.revision,requestId:'remove-member'})
    const before=await counts(f.session.id)
    await expect(f.sessions.appendMessage(input)).rejects.toMatchObject({code:'team_not_found'})
    expect(await counts(f.session.id)).toEqual(before)
  })
  test('a receipt survives all Agents going offline while a fresh call is refused',async()=>{
    const f=await fixture(),input=message(f,'all'),original=await f.sessions.appendMessage(input)
    await pool.query("UPDATE daemons SET status='offline' WHERE daemon_id IN (SELECT daemon_id FROM team_agent_offers WHERE team_id=$1)",[f.team.id])
    const before=await counts(f.session.id)
    expect(await f.sessions.appendMessage(input)).toEqual(original)
    await expect(f.sessions.appendMessage({...input,requestId:'new-offline-call'})).rejects.toMatchObject({code:'no_callable_agent'})
    expect(await counts(f.session.id)).toEqual(before)
  })
  test('legacy server-derived hashes still return the original receipt after Context changes',async()=>{
    const f=await fixture(),input=message(f,'offers'),original=await f.sessions.appendMessage(input)
    const legacyHash=createHash('sha256').update(JSON.stringify({content:input.content,target_mode:'offers',target_offer_ids:[f.one.id],reference_event_id:null,context_version:1})).digest('hex')
    await pool.query('UPDATE collaboration_events SET request_hash=$2 WHERE event_id=$1',[original.event.id,legacyHash])
    await f.contexts.create({sessionId:f.session.id,actorUserId:f.owner,expectedRevision:1,requestId:'legacy-later-context',goal:'Later',consensus:[],openQuestions:[],references:[]})
    expect(await f.sessions.appendMessage(input)).toEqual(original)
    expect((await pool.query('SELECT request_hash FROM collaboration_events WHERE event_id=$1',[original.event.id])).rows[0].request_hash).toBe(legacyHash)
  })
  test('explicit targets are a set and replay preserves the original ordered call receipt',async()=>{
    const f=await fixture()
    await f.sessions.changeBinding({sessionId:f.session.id,actorUserId:f.owner,offerId:f.two.id,active:true,expectedRevision:1,requestId:'two-targets'})
    const input={...message(f,'offers'),targetOfferIds:[f.two.id,f.one.id]},original=await f.sessions.appendMessage(input)
    expect(await f.sessions.appendMessage({...input,targetOfferIds:[f.one.id,f.two.id,f.one.id]})).toEqual(original)
    expect(original.call_ids).toHaveLength(2)
  })
  test.each(['mode','targets','reference'] as const)('a changed client %s conflicts even after the accepted target is unavailable',async kind=>{
    const f=await fixture(),input=message(f,'offers');await f.sessions.appendMessage(input)
    await f.sessions.changeBinding({sessionId:f.session.id,actorUserId:f.owner,offerId:f.one.id,active:false,expectedRevision:1,requestId:'unavailable-target'})
    const changed=kind==='mode'?{...input,targetMode:'discussion' as const}:kind==='targets'?{...input,targetOfferIds:[f.two.id]}:{...input,referenceEventId:'cev_missing'}
    const before=await counts(f.session.id)
    await expect(f.sessions.appendMessage(changed)).rejects.toMatchObject({code:'idempotency_conflict'})
    expect(await counts(f.session.id)).toEqual(before)
  })
  test('concurrent identical messages publish and enqueue exactly once',async()=>{
    const published:string[]=[],enqueued:string[][]=[]
    const f=await fixture({event:(_id,_users,event)=>published.push(event.id),dispatch:ids=>enqueued.push(ids)})
    const input=message(f,'all'),receipts=await Promise.all([f.sessions.appendMessage(input),f.sessions.appendMessage(input)])
    expect(receipts[1]).toEqual(receipts[0])
    expect(published).toEqual([receipts[0].event.id])
    expect(enqueued).toEqual([receipts[0].call_ids])
    expect(await counts(f.session.id)).toEqual({events:2,calls:1})
  })
  test('auto-joining an Agent owner checks the same selected-reference gate as explicit participant addition',async()=>{
    const f=await fixture()
    // An explicit dangling-reference fixture models retained Context after
    // Memory unbinding. No shared Claim or permission is fabricated here.
    const reference={source_kind:'memory_claim',source_id:randomUUID(),source_version:randomUUID(),installation_id:randomUUID(),owner_scope_id:randomUUID()}
    await pool.query('UPDATE collaboration_context_versions SET context_references=$2::jsonb WHERE context_version_id=$1',[f.context.id,JSON.stringify([reference])])
    const bridge=new TeamMemoryContextBridge(pool,{mint:async()=>{throw new Error('No scope exists, so grant minting must not be reached')}},{enabled:true})
    const sessions=new TeamSessionService(pool,{},undefined,bridge)
    const before=await f.sessions.getSession(f.session.id,f.owner)
    await expect(sessions.addParticipant({sessionId:f.session.id,actorUserId:f.owner,userId:f.member,expectedRevision:1,requestId:'explicit-denied'})).rejects.toMatchObject({code:'memory_grant_required'})
    await expect(sessions.changeBinding({sessionId:f.session.id,actorUserId:f.owner,offerId:f.two.id,active:true,expectedRevision:1,requestId:'automatic-denied'})).rejects.toMatchObject({code:'memory_grant_required'})
    expect(await f.sessions.getSession(f.session.id,f.owner)).toEqual(before)
    expect((await pool.query('SELECT 1 FROM collaboration_team_idempotency WHERE user_id=$1 AND request_id=$2',[f.owner,'automatic-denied'])).rows).toEqual([])
  })
  test('an Agent owner can auto-join without a shared Memory selection',async()=>{
    const f=await fixture(),bridge=new TeamMemoryContextBridge(pool,{mint:async()=>{throw new Error('No Memory references require no grant')}},{enabled:true})
    const sessions=new TeamSessionService(pool,{},undefined,bridge)
    const added=await sessions.changeBinding({sessionId:f.session.id,actorUserId:f.owner,offerId:f.two.id,active:true,expectedRevision:1,requestId:'no-memory-auto-join'})
    expect(added.participants.map(p=>p.user_id)).toEqual([f.owner,f.member])
    expect(added.agent_bindings.map(b=>b.offer_id)).toContain(f.two.id)
  })

  async function unregisteredInvitation() {
    const key=randomUUID(),email=`${key}.future@example.test`,teams=new TeamRepository(pool)
    const owner=Number((await pool.query("INSERT INTO users (email,password_hash, team_enabled) VALUES ($1,'x',true) RETURNING id",[`${key}.sender@example.test`])).rows[0].id)
    const team=(await teams.createTeam({actorUserId:owner,name:'Future recipient',requestId:key})).team
    const input={teamId:team.id,actorUserId:owner,email,expectedRevision:1,requestId:key}
    const original=await teams.invite(input)
    const recipient=Number((await pool.query("INSERT INTO users (email,password_hash, team_enabled) VALUES ($1,'x',true) RETURNING id",[email])).rows[0].id)
    return {key,email,teams,team,input,original,recipient,owner}
  }
  test('registration preserves valid pending invitation deduplication for the same normalized recipient email',async()=>{
    const f=await unregisteredInvitation()
    const repeated=await f.teams.invite({...f.input,email:' '+f.email.toUpperCase()+' ',expectedRevision:2,requestId:'after-registration'})
    expect(repeated.id).toBe(f.original.id)
    expect((await f.teams.listMyInvitations(f.recipient)).map(i=>i.id)).toEqual([f.original.id])
    expect((await f.teams.getTeam(f.team.id,f.owner)).revision).toBe(2)
  })
  test('concurrent resends after registration return the same pending invitation without changing Team revision',async()=>{
    const f=await unregisteredInvitation()
    const receipts=await Promise.all(['concurrent-one','concurrent-two'].map(requestId=>f.teams.invite({...f.input,expectedRevision:2,requestId})))
    expect(receipts.map(i=>i.id)).toEqual([f.original.id,f.original.id])
    expect((await f.teams.listMyInvitations(f.recipient)).map(i=>i.id)).toEqual([f.original.id])
    expect((await f.teams.getTeam(f.team.id,f.owner)).revision).toBe(2)
  })
  test('an invitation to an unregistered email can be accepted by the later registered matching account',async()=>{
    const f=await unregisteredInvitation()
    await expect(f.teams.respondToInvitation({invitationId:f.original.id,actorUserId:f.owner,action:'accepted',expectedRevision:1,requestId:'wrong-recipient'})).rejects.toMatchObject({code:'team_not_found'})
    const result=await f.teams.respondToInvitation({invitationId:f.original.id,actorUserId:f.recipient,action:'accepted',expectedRevision:1,requestId:'matching-recipient'})
    expect(result.membership).toMatchObject({user_id:f.recipient,state:'active'})
    expect(result.invitation.recipient_user_id).toBe(f.recipient)
  })
  test('expiry before registration still allows a new usable invitation and preserves old expired history',async()=>{
    const f=await unregisteredInvitation()
    await pool.query("UPDATE collaboration_team_invitations SET expires_at=NOW()-INTERVAL '1 second' WHERE invitation_id=$1",[f.original.id])
    const fresh=await f.teams.invite({...f.input,expectedRevision:2,requestId:'fresh-registered'})
    expect(fresh.id).not.toBe(f.original.id)
    expect((await f.teams.listInvitations(f.team.id,f.owner)).find(i=>i.id===f.original.id)?.state).toBe('expired')
    expect((await f.teams.respondToInvitation({invitationId:fresh.id,actorUserId:f.recipient,action:'accepted',expectedRevision:1,requestId:'accept-fresh'})).membership?.state).toBe('active')
  })
})
