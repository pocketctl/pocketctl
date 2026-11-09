import {beginFreshInputFixture} from './input-start-fixture.js'
import {installRetainedInputStartFixture} from './input-start-fixture.js'
import pg from 'pg'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../../schema.js'
import {applySharedSourceContract} from '../../migrations/shared-db/contract.js'
import {provisionSharedDatabase} from '../../migrations/shared-db/namespace.js'
import {createMemoryPool} from '../../db.js'
import {canonicalPayloadHash,createPostgresSharedSourceReader,acceptedDeliverySourceSessionId,legacyTeamSourceSessionId,type SourceScope} from '@pocketctl/session-source'
const url=process.env.SHARED_R1_TEAM_TEST_DATABASE_URL,suite=url?describe:describe.skip
const inst='10000000-0000-0000-0000-000000000007',submission='20000000-0000-0000-0000-000000000007',decision='30000000-0000-0000-0000-000000000007'
const scope:SourceScope={installationId:inst,principalUserId:'1',ownerScopeKind:'personal',ownerScopeId:inst,authorizationRevision:'1',configVersion:'1',modeGeneration:'2',bindingRevision:'1',participantRevision:'1'}
const deliverySession=acceptedDeliverySourceSessionId({teamSessionId:'ts',submissionId:submission,decisionId:decision,bindingId:'b',bindingRevision:1,userId:1,participantRevision:1})
suite('Team independent canonical reader adapters',()=>{
 let pool:pg.Pool,runtime:pg.Pool
 beforeAll(async()=>{
  if(!url||!/(^|_)test$/.test(new URL(url).pathname.slice(1)))throw Error('isolated_test_required')
  pool=new pg.Pool({connectionString:url});await pool.query('DROP SCHEMA IF EXISTS memory CASCADE; DROP SCHEMA IF EXISTS shared CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  const inputFoundation=await beginFreshInputFixture(pool)
  await applyMemorySchema(pool,{namespace:'memory'});await applySharedSourceContract(pool)
  await pool.query(`CREATE TABLE public.users(id int PRIMARY KEY,team_enabled boolean); INSERT INTO public.users VALUES(1,true),(2,true);
   CREATE TABLE public.extension_providers(provider_id text,status text); INSERT INTO public.extension_providers VALUES('pocketctl-memory','enabled');
   CREATE TABLE public.extension_installations(installation_id uuid,provider_id text,owner_user_id int,owner_scope_kind text,owner_scope_id uuid,status text,authorization_epoch bigint,config_version bigint,granted_scopes text[],enabled_services text[],event_filter jsonb DEFAULT '{}',start_policy text NOT NULL DEFAULT 'retained_history',start_feed_id bigint NOT NULL DEFAULT 0);
   CREATE TABLE public.extension_scope_memberships(scope_kind text,scope_id uuid,user_id int,state text,roles text[],membership_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),membership_revision bigint DEFAULT 1);
   CREATE TABLE public.extension_teams(team_id uuid,organization_id uuid,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.extension_organizations(organization_id uuid,state text,authorization_epoch bigint DEFAULT 1);
   CREATE TABLE public.collaboration_teams(team_id text,state text); INSERT INTO public.collaboration_teams VALUES('team','active');
   CREATE TABLE public.collaboration_sessions(team_session_id text,team_id text,state text); INSERT INTO public.collaboration_sessions VALUES('ts','team','active');
   CREATE TABLE public.collaboration_team_memberships(team_id text,user_id int,state text); INSERT INTO public.collaboration_team_memberships VALUES('team',1,'active');
   CREATE TABLE public.collaboration_session_participants(team_session_id text,user_id int,state text,revision bigint); INSERT INTO public.collaboration_session_participants VALUES('ts',1,'active',1);
   CREATE TABLE public.team_memory_bindings(binding_id text,team_id text,installation_id uuid,owner_scope_kind text,owner_scope_id uuid,state text,revision bigint);
   CREATE TABLE public.collaboration_calls(call_id text,team_session_id text,event_id text,offer_id text,context_version bigint,state text,task_id text); INSERT INTO public.collaboration_calls VALUES('call','ts','goal','offer',0,'completed','task');
   CREATE TABLE public.team_agent_offers(offer_id text,daemon_id text); INSERT INTO public.team_agent_offers VALUES('offer','daemon');
   CREATE TABLE public.collaboration_events(event_id text,team_session_id text,event_seq bigint,kind text,author_user_id int,author_offer_id text,call_id text,content text,created_at timestamptz);
   INSERT INTO public.collaboration_events VALUES('goal','ts',1,'member_message',1,NULL,NULL,'goal','2026-11-01T00:00:00Z'),('reply','ts',2,'agent_message',NULL,'offer','call','private reply','2026-11-01T00:00:01Z'),('outcome','ts',3,'status',NULL,NULL,'call','completed','2026-11-01T00:00:02Z');
   CREATE TABLE public.team_delivery_memory_sources(source_session_id text,decision_id uuid,submission_id uuid,team_id text,team_session_id text,binding_id text,binding_revision bigint,reader_user_id int,participant_revision bigint,revoked_at timestamptz,withdrawn_at timestamptz);
   CREATE TABLE public.team_task_submissions(submission_id uuid,task_id text,spec_revision bigint,version bigint,state text,source_call_id text,source_offer_id text,context_version bigint,summary text,manifest_sha256 text,published_at timestamptz);
   CREATE TABLE public.team_acceptance_decisions(decision_id uuid,submission_id uuid,task_id text,spec_revision bigint,reviewer_user_id int,decision text,created_at timestamptz);
   CREATE TABLE public.team_task_specs(task_id text,revision bigint,goal text,acceptance text,reviewer_user_id int,created_by_user_id int,created_at timestamptz);
   INSERT INTO public.team_task_specs VALUES('task',1,'delivery goal','delivery criteria',1,1,'2026-11-01T00:00:00Z');
   CREATE TABLE public.team_artifact_revocations(submission_id uuid);
   CREATE TABLE public.team_delivery_memory_withdrawals(team_id text,team_session_id text,submission_id uuid,decision_id uuid);
   DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_team_memory') THEN CREATE ROLE shared_team_memory LOGIN PASSWORD 'only-test';END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_team_relay') THEN CREATE ROLE shared_team_relay NOLOGIN;END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shared_team_migrator') THEN CREATE ROLE shared_team_migrator NOLOGIN;END IF;
   END $$;`)
  await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}');",[inst])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[inst])
  await pool.query("INSERT INTO public.team_memory_bindings VALUES('b','team',$1,'personal',$1,'active',1)",[inst])
  await pool.query("INSERT INTO public.team_delivery_memory_sources VALUES($1,$2,$3,'team','ts','b',1,1,1,NULL,NULL)",[deliverySession,decision,submission])
  await pool.query("INSERT INTO public.team_task_submissions VALUES($1,'task',1,1,'published','call','offer',0,'private accepted summary',$2,'2026-11-01T00:00:01Z')",[submission,'ab'.repeat(32)])
  await pool.query("INSERT INTO public.team_acceptance_decisions VALUES($1,$2,'task',1,1,'accepted','2026-11-01T00:00:02Z')",[decision,submission])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[inst])
  await pool.query("SELECT shared.mark_memory_source_dirty('team_collaboration','call')");await pool.query("SELECT shared.mark_memory_source_dirty('team_delivery',$1)",[deliverySession])
  const {installRelayDeliveryPrivacyCapture}=await import(new URL('../../../../relay/src/shared-source/delivery-privacy-capture.ts',import.meta.url).href)
  await installRelayDeliveryPrivacyCapture(pool)
  await installRetainedInputStartFixture(pool,'retained_history',inputFoundation)
  await provisionSharedDatabase(pool,{memoryRole:'shared_team_memory',relayRole:'shared_team_relay',migratorRole:'shared_team_migrator'})
  const runtimeUrl=new URL(url);runtimeUrl.username='shared_team_memory';runtimeUrl.password='only-test';runtime=createMemoryPool({databaseUrl:runtimeUrl.href,databaseNamespace:'memory',dbPoolMax:3})
 },60000)
 afterAll(async()=>{await runtime?.end();await pool?.end()})
 test('bounded target enumeration retains every personal reader and exact delivery principal',async()=>{
  const second='10000000-0000-0000-0000-000000000008'
  await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',2,'personal',$1,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[second])
  await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[second])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[second])
  await pool.query("INSERT INTO public.collaboration_session_participants VALUES('ts',2,'active',2);INSERT INTO public.collaboration_team_memberships VALUES('team',2,'active')")
  const read=(after='',limit=1)=>runtime.query("SELECT * FROM shared.enumerate_memory_source_targets('team_collaboration','call',$1,$2)",[after,limit])
  try{
   const first=(await read()).rows[0],next=(await read(first.cursor_key)).rows[0]
   expect([first.source_scope.principalUserId,next.source_scope.principalUserId]).toEqual(['1','2'])
   expect(next).toMatchObject({state:'current',source_scope:{installationId:second,bindingRevision:'1',participantRevision:'2'}})
   expect((await read(next.cursor_key)).rowCount).toBe(0)
   expect(JSON.stringify([first,next])).not.toMatch(/private reply|private accepted summary/)
   const delivery=(await runtime.query("SELECT * FROM shared.enumerate_memory_source_targets('team_delivery',$1,'',64)",[deliverySession])).rows
   expect(delivery).toHaveLength(1);expect(delivery[0].source_scope.principalUserId).toBe('1')
   const shared='10000000-0000-0000-0000-000000000009',team='40000000-0000-0000-0000-000000000009',org='50000000-0000-0000-0000-000000000009'
   await pool.query("INSERT INTO public.extension_organizations(organization_id,state) VALUES($1,'active');",[org])
   await pool.query("INSERT INTO public.extension_teams(team_id,organization_id,state) VALUES($1,$2,'active')",[team,org])
   await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',1,'team',$2,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[shared,team])
   await pool.query("INSERT INTO public.extension_scope_memberships(scope_kind,scope_id,user_id,state,roles) VALUES('team',$1,1,'active',ARRAY['reader']),('team',$1,2,'active',ARRAY['reviewer'])",[team])
   await pool.query("INSERT INTO memory.memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[shared])
   await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[shared])
   try{
    await pool.query("UPDATE public.team_memory_bindings SET installation_id=$1,owner_scope_kind='team',owner_scope_id=$2 WHERE binding_id='b'",[shared,team])
    const targets=(await read('',64)).rows
    expect(targets).toHaveLength(4)
    expect(targets.filter(r=>r.source_scope.installationId===shared).map(r=>[r.source_scope.principalUserId,r.state])).toEqual([['1','current'],['2','current']])
    const claim=(await runtime.query("SELECT source_kind,root_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_source_work('team-distribution',30,128)")).rows.find(r=>r.source_kind==='team_collaboration'&&r.root_key==='call')!
    let page:any=null
    for(let n=0;n<5;n++){
     page=(await runtime.query("SELECT shared.step_memory_source_distribution('team_collaboration','call',$1,'team-distribution',$2,$3,$4,2) AS page",[claim.lease_token,claim.claimed_revision,page?.scanId??null,page?.cursor??''])).rows[0].page
     if(page.state==='sealed')break
    }
    expect(page.state).toBe('sealed')
    const {loadSourceContextSet,checkSourceContextSet}=await import('../../sources/source-context-set.js')
    const set=await loadSourceContextSet(runtime,shared,{kind:'team_collaboration',key:'call'},page.scanId)
    expect(set.contexts.map(c=>c.scope.principalUserId)).toEqual(['1','2'])
    await checkSourceContextSet(runtime,{kind:'team_collaboration',key:'call'},set)
    await pool.query("UPDATE public.extension_scope_memberships SET roles='{}' WHERE scope_id=$1 AND user_id=2",[team])
    expect((await read('',64)).rows.filter(r=>r.source_scope.installationId===shared).map(r=>[r.source_scope.principalUserId,r.state])).toEqual([['1','current'],['2','revoked']])
    // Test complete-installation progress against two real trusted contexts.
    // These seeded ready receipts represent separate durable worker commits;
    // they are not a claim that semantic Team projection is already complete.
    await pool.query("UPDATE public.extension_scope_memberships SET roles=ARRAY['reviewer'] WHERE scope_id=$1 AND user_id=2",[team])
    await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
    await pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[shared])
    await pool.query("SELECT shared.mark_memory_control_dirty('installation',$1)",[shared])
    for(let n=0;n<6;n++){
     page=(await runtime.query("SELECT shared.step_memory_source_distribution('team_collaboration','call',$1,'team-distribution',$2,$3,$4,2) AS page",[claim.lease_token,claim.claimed_revision,page.scanId,page.cursor])).rows[0].page
     if(page.state==='sealed')break
    }
    expect(page.state).toBe('sealed')
    const currentSet=await loadSourceContextSet(runtime,shared,{kind:'team_collaboration',key:'call'},page.scanId)
    expect(currentSet.contexts).toHaveLength(2)
    await runtime.query("SELECT shared.record_memory_source_dispatch($1,3,'team_collaboration','call',$2,1,1)",[shared,claim.claimed_revision])
    const {randomUUID}=await import('node:crypto'),{withSourceJobExecution,completeSourceProjection}=await import('../../sources/source-execution.js')
    const job=randomUUID(),target={kind:'team_collaboration' as const,key:'call'}
    await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',($1::uuid)::text,52,'running','complete-set-fixture',1,clock_timestamp()+interval '5 minutes')",[job,shared])
    const ready=async(index:number,version=currentSet.contexts[index].version)=>runtime.query(`INSERT INTO memory_canonical_projection_progress(installation_id,source_kind,root_key,context_key,source_version,state)
     VALUES($1,'team_collaboration','call',$2,$3,'ready') ON CONFLICT(installation_id,source_kind,root_key,context_key) DO UPDATE SET source_version=EXCLUDED.source_version,state='ready'`,[shared,canonicalPayloadHash(currentSet.contexts[index].scope).toString('hex'),version])
    const processed=async()=>(await pool.query("SELECT processed_revision::text FROM shared.memory_source_progress WHERE installation_id=$1 AND root_key='call'",[shared])).rows[0].processed_revision
    await withSourceJobExecution(runtime,{jobId:job,claimedBy:'complete-set-fixture',claimEpoch:1},async()=>{
     const complete=async()=>{
      const c=await runtime.connect()
      try{await c.query('BEGIN');await completeSourceProjection(c,currentSet.contexts[0].scope,target,currentSet.contexts[0].version);await c.query('COMMIT')}
      catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
     }
     await ready(0);await complete();expect(await processed()).toBe('0')
     await ready(1,{...currentSet.contexts[1].version,authorization:'stale'});await complete();expect(await processed()).toBe('0')
     await ready(1)
     const blocker=await pool.connect()
     try{
      await blocker.query('BEGIN')
      await blocker.query("SELECT 1 FROM memory.memory_canonical_projection_progress WHERE installation_id=$1 AND context_key=$2 FOR UPDATE",[shared,canonicalPayloadHash(currentSet.contexts[1].scope).toString('hex')])
      await expect(complete()).rejects.toMatchObject({code:'55P03'});expect(await processed()).toBe('0')
      await blocker.query('ROLLBACK')
      await runtime.query("INSERT INTO memory_canonical_projection_progress(installation_id,source_kind,root_key,context_key,source_version,state) VALUES($1,'team_collaboration','call',$2,$3,'ready')",[shared,'f'.repeat(64),currentSet.contexts[0].version])
      await blocker.query('BEGIN')
      await blocker.query("SELECT 1 FROM memory.memory_canonical_projection_progress WHERE installation_id=$1 AND context_key=$2 FOR UPDATE",[shared,'f'.repeat(64)])
      await complete();expect(await processed()).toBe(claim.claimed_revision)
     }finally{await blocker.query('ROLLBACK');blocker.release()}
    })

   }finally{
    await pool.query("UPDATE public.team_memory_bindings SET installation_id=$1,owner_scope_kind='personal',owner_scope_id=$1 WHERE binding_id='b'",[inst])
    await pool.query('DELETE FROM public.extension_scope_memberships WHERE scope_id=$1',[team])
    await pool.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[shared])
    await runtime.query('DELETE FROM memory_canonical_projection_progress WHERE installation_id=$1',[shared])
    await pool.query('DELETE FROM shared.memory_source_progress WHERE installation_id=$1',[shared])
    await pool.query('DELETE FROM shared.memory_source_executions WHERE installation_id=$1',[shared])
    await pool.query('DELETE FROM memory.memory_installations WHERE installation_id=$1',[shared])
    await pool.query("UPDATE shared.memory_source_modes SET mode='paused',generation=generation+1 WHERE installation_id=$1",[shared])
    await pool.query('DELETE FROM shared.memory_local_source_rights WHERE installation_id=$1',[shared])
    await pool.query('DELETE FROM public.extension_teams WHERE team_id=$1',[team])
    await pool.query('DELETE FROM public.extension_organizations WHERE organization_id=$1',[org])
   }
   await pool.query("UPDATE public.collaboration_team_memberships SET state='removed' WHERE user_id=2")
   expect((await read(first.cursor_key)).rows[0].state).toBe('revoked')
   await expect(read('',257)).rejects.toThrow('invalid_source_target_page')
  }finally{
   await pool.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[second])
   await pool.query('DELETE FROM memory.memory_installations WHERE installation_id=$1',[second])
   await pool.query("UPDATE shared.memory_source_modes SET mode='paused',generation=generation+1 WHERE installation_id=$1",[second])
   await pool.query('DELETE FROM shared.memory_local_source_rights WHERE installation_id=$1',[second])
   await pool.query('DELETE FROM public.collaboration_session_participants WHERE user_id=2;DELETE FROM public.collaboration_team_memberships WHERE user_id=2')
  }
 })

 test('collaboration preserves real event lineage; delivery is separate without fabricated event IDs',async()=>{
  await expect(runtime.query('SELECT content FROM public.collaboration_events')).rejects.toMatchObject({code:'42501'})
  const reader=createPostgresSharedSourceReader(runtime)
  for(const root of [{kind:'team_collaboration' as const,key:'call'},{kind:'team_delivery' as const,key:deliverySession}]){
   const page=await reader.listHeads(scope,root);expect(page.heads).toHaveLength(3);expect(JSON.stringify(page)).not.toContain('private')
   const bodies=await reader.resolveBodies(scope,root,page.heads,page.version)
   expect(bodies.map(r=>r.head.eventType).sort()).toEqual(['agent_text','turn_status','user_goal'])
   for(const b of bodies){const proof=(b.payload as any).team_source;expect(proof.source_version).toBe(root.kind==='team_delivery'?2:1);expect(proof.team_event_ids!==undefined).toBe(root.kind==='team_collaboration')}
   const one=await reader.listHeads(scope,root,{limit:1}),two=await reader.listHeads(scope,root,{limit:1,cursor:one.nextCursor!});expect(two.heads[0].canonicalKey).not.toBe(one.heads[0].canonicalKey)
  }
 })
 test('full native projection keys and legacy wire aliases share one current proof without crossing participant revisions',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),root={kind:'team_collaboration' as const,key:'call'}
  const original=(await reader.listHeads(scope,root)).heads[0],key=original.locator?.teamProjectionKey as string
  expect(key).toMatch(/^team_projection_[a-f0-9]{64}$/)
  const typed=await reader.getHeads(scope,root,[key]),wire=await reader.getHeads(scope,root,[original.canonicalKey])
  expect(typed.heads[0].canonicalKey).toBe(key)
  expect((await reader.resolveBodies(scope,root,typed.heads,typed.version))[0].payload).toEqual((await reader.resolveBodies(scope,root,wire.heads,wire.version))[0].payload)
  await pool.query("UPDATE public.collaboration_session_participants SET revision=2 WHERE user_id=1")
  try{
   await expect(reader.getHeads(scope,root,[key])).rejects.toMatchObject({code:'revoked'})
   const currentScope={...scope,participantRevision:'2'},fresh=(await reader.listHeads(currentScope,root)).heads.find(h=>h.canonicalKey===original.canonicalKey)!
   expect(fresh.canonicalKey).toBe(original.canonicalKey)
   expect(fresh.locator?.teamProjectionKey).not.toBe(key)
   await expect(reader.getHeads(currentScope,root,[key])).rejects.toMatchObject({code:'body_set_mismatch'})
   const page=await reader.getHeads(currentScope,root,[fresh.locator!.teamProjectionKey as string])
   expect((await reader.resolveBodies(currentScope,root,page.heads,page.version))[0].head.sessionKey).not.toBe(original.sessionKey)
  }finally{await pool.query('UPDATE public.collaboration_session_participants SET revision=1 WHERE user_id=1')}
 })

 test('Team final commit fences serialize authority, delivery and missing-row privacy writers',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),consumer=await runtime.connect(),writer=await pool.connect()
  try{
   for(const root of [{kind:'team_collaboration' as const,key:'call'},{kind:'team_delivery' as const,key:deliverySession}]){
    const current=await reader.checkAuthority(scope,root)
    await consumer.query('BEGIN')
    expect((await consumer.query('SELECT shared.lock_memory_team_source_commit($1::jsonb,$2,$3,$4::jsonb,true) AS locked',[JSON.stringify(scope),root.kind,root.key,JSON.stringify(current.version)])).rows[0].locked).toBe(true)
    const mutations=["UPDATE public.collaboration_team_memberships SET state='removed'","UPDATE public.collaboration_session_participants SET state='removed'","UPDATE public.team_memory_bindings SET state='revoked'","UPDATE public.collaboration_calls SET state='running'","UPDATE public.extension_providers SET status='disabled'","UPDATE shared.memory_source_modes SET generation=generation+1"]
    if(root.kind==='team_delivery')mutations.push("UPDATE public.team_acceptance_decisions SET decision='rejected'","UPDATE public.team_task_submissions SET state='withdrawn'","UPDATE public.team_delivery_memory_sources SET withdrawn_at=NOW()")
    for(const sql of mutations){
     await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='50ms'")
     await expect(writer.query(sql)).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK')
    }
    await writer.query('BEGIN')
    await expect(writer.query("INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'privacy',now())",[inst,root.kind==='team_delivery'?root.key:legacyTeamSourceSessionId({teamSessionId:'ts',bindingRevision:1,participantRevision:1})])).rejects.toMatchObject({code:'55P03'})
    await writer.query('ROLLBACK')
    await writer.query('BEGIN')
    expect((await writer.query("SELECT pg_try_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0)) AS locked",[inst])).rows[0].locked).toBe(false)
    await writer.query('ROLLBACK');await consumer.query('COMMIT')
    await consumer.query('BEGIN')
    expect((await consumer.query('SELECT shared.lock_memory_team_source_commit($1::jsonb,$2,$3,$4::jsonb,true) AS locked',[JSON.stringify(scope),root.kind,root.key,JSON.stringify({...current.version,content:'999999'})])).rows[0].locked).toBe(false)
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='50ms'");await writer.query("UPDATE public.collaboration_team_memberships SET state='active'");await writer.query('ROLLBACK')
    await consumer.query('ROLLBACK')
   }
  }finally{await consumer.query('ROLLBACK');await writer.query('ROLLBACK');consumer.release();writer.release()}
 })
 test('owner, participant/binding versions, current membership and provider disable all fail closed',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),root={kind:'team_collaboration' as const,key:'call'}
  await expect(reader.listHeads({...scope,principalUserId:'2'},root)).rejects.toMatchObject({code:'revoked'})
  for(const field of ['participantRevision','bindingRevision'] as const)await expect(reader.listHeads({...scope,[field]:'2'},root)).rejects.toMatchObject({code:'revoked'})
  const page=await reader.listHeads(scope,root)
  for(const [sql,restore] of [["UPDATE public.collaboration_team_memberships SET state='removed'","UPDATE public.collaboration_team_memberships SET state='active'"],["UPDATE public.extension_providers SET status='disabled'","UPDATE public.extension_providers SET status='enabled'"]]){
   await pool.query(sql);try{await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'revoked'})}finally{await pool.query(restore)}
  }
 })
 test('rejected/withdrawn/revoked artifacts do not remain available from stale heads',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),root={kind:'team_delivery' as const,key:deliverySession},page=await reader.listHeads(scope,root)
  for(const [sql] of [["UPDATE public.team_acceptance_decisions SET decision='changes_requested'","UPDATE public.team_acceptance_decisions SET decision='accepted'"],["UPDATE public.team_delivery_memory_sources SET withdrawn_at=NOW()","UPDATE public.team_delivery_memory_sources SET withdrawn_at=NULL"],["INSERT INTO public.team_artifact_revocations SELECT submission_id FROM public.team_task_submissions","DELETE FROM public.team_artifact_revocations"]]){
   // Each real negative is visible to the restricted runtime on this client,
   // then ROLLBACK restores the entire fixture, including irreversible proof
   // retirement. Clearing withdrawn_at alone must never revive production proof.
   const tx=await pool.connect()
   try{await tx.query('BEGIN');await tx.query(sql)
    if(sql.includes('withdrawn_at'))expect((await tx.query("SELECT retired FROM public.native_source_publications WHERE source_kind='team_delivery' AND source_key=$1",[deliverySession])).rows[0].retired).toBe(true)
    await tx.query('SET LOCAL ROLE shared_team_memory')
    const isolatedReader=createPostgresSharedSourceReader({query:tx.query.bind(tx),connect:async()=>({query:tx.query.bind(tx),release:()=>{}})})
    await expect(isolatedReader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'revoked'})
   }finally{await tx.query('ROLLBACK');tx.release()}
   expect((await reader.resolveBodies(scope,root,page.heads,page.version)).length).toBeGreaterThan(0)
  }
 })
 test('current filters, malformed lineage and Memory tombstones are enforced independently',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),root={kind:'team_collaboration' as const,key:'call'}
  for(const filter of [{daemon_ids:['other']},{agent_types:['codex']},{daemon_ids:'daemon'},{unknown:[]}]){
   await pool.query('UPDATE public.extension_installations SET event_filter=$1::jsonb',[JSON.stringify(filter)])
   try{await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'revoked'})}finally{await pool.query("UPDATE public.extension_installations SET event_filter='{}'")}
  }
  await pool.query('UPDATE public.extension_installations SET event_filter=$1::jsonb',[JSON.stringify({daemon_ids:['daemon'],agent_types:['team_collaboration']})])
  expect((await reader.listHeads(scope,root)).heads).toHaveLength(3);await pool.query("UPDATE public.extension_installations SET event_filter='{}'")
  await pool.query("UPDATE public.collaboration_events SET author_offer_id='foreign' WHERE event_id='reply'")
  try{await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'source_lineage_unavailable'})}finally{await pool.query("UPDATE public.collaboration_events SET author_offer_id='offer' WHERE event_id='reply'")}
  const page=await reader.listHeads(scope,root),session=page.heads[0].sessionKey
  await pool.query("INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'privacy',NOW())",[inst,session])
  try{await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'source_body_reclaimed'})}finally{await pool.query('DELETE FROM memory.memory_session_tombstones')}
 })
 test('accepted delivery cannot borrow another task or offer while keeping valid independent foreign keys',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),root={kind:'team_delivery' as const,key:deliverySession},page=await reader.listHeads(scope,root)
  for(const [sql,restore] of [["UPDATE public.collaboration_calls SET task_id='other-task'","UPDATE public.collaboration_calls SET task_id='task'"],["UPDATE public.collaboration_calls SET offer_id='other-offer'","UPDATE public.collaboration_calls SET offer_id='offer'"]]){
   await pool.query(sql);try{await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'revoked'})}finally{await pool.query(restore)}
  }
 })
 test('legacy virtual session privacy fence cannot be bypassed through current identity format',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),root={kind:'team_collaboration' as const,key:'call'},page=await reader.listHeads(scope,root)
  const legacy=legacyTeamSourceSessionId({teamSessionId:'ts',bindingRevision:1,participantRevision:1})
  await pool.query("INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'privacy',NOW())",[inst,legacy])
  try{await expect(reader.resolveBodies(scope,root,page.heads,page.version)).rejects.toMatchObject({code:'source_body_reclaimed'})}finally{await pool.query('DELETE FROM memory.memory_session_tombstones')}
 })
 test('reclaiming an old call does not deny a different call sharing the same virtual session',async()=>{
  const reader=createPostgresSharedSourceReader(runtime),root={kind:'team_collaboration' as const,key:'call'},page=await reader.listHeads(scope,root),session=page.heads[0].sessionKey
  await pool.query(`INSERT INTO memory.memory_source_retention_receipts(installation_id,turn_id,session_id,episode_id,source_digest,compiler_version,extraction_completed_at,state,finished_at)
   VALUES($1,'team-call:old-call',$2,'70000000-0000-0000-0000-000000000007',decode(repeat('ab',32),'hex'),'fixture',NOW(),'reclaimed',NOW())`,[inst,session])
  try{
   expect((await reader.listHeads(scope,root)).heads).toHaveLength(3)
   await pool.query("UPDATE memory.memory_source_retention_receipts SET turn_id='team-call:call'")
   await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'source_body_reclaimed'})
   expect((await reader.checkAuthority(scope,root,page.version)).state).toBe('current')
   await pool.query("INSERT INTO memory.memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,$2,'privacy',NOW())",[inst,session])
   try{await expect(reader.checkAuthority(scope,root,page.version)).rejects.toMatchObject({code:'source_body_reclaimed'})}finally{await pool.query('DELETE FROM memory.memory_session_tombstones')}
  }finally{await pool.query('DELETE FROM memory.memory_source_retention_receipts')}
 })
 test('team owner scope requires both current extension scope membership and collaboration membership',async()=>{
  const target='40000000-0000-0000-0000-000000000007',org='50000000-0000-0000-0000-000000000007',team='60000000-0000-0000-0000-000000000007'
  await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',NULL,'team',$2,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[target,team])
  await pool.query("INSERT INTO public.extension_organizations VALUES($1,'active');",[org]);await pool.query("INSERT INTO public.extension_teams VALUES($1,$2,'active')",[team,org])
  await pool.query("INSERT INTO public.extension_scope_memberships VALUES('team',$1,1,'active',ARRAY['reader'])",[team])
  await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-shadow',2)",[target])
  await pool.query("UPDATE public.team_memory_bindings SET installation_id=$1,owner_scope_kind='team',owner_scope_id=$2",[target,team])
  const sharedScope={...scope,installationId:target,ownerScopeKind:'team' as const,ownerScopeId:team},reader=createPostgresSharedSourceReader(runtime),root={kind:'team_collaboration' as const,key:'call'}
  try{
   expect((await reader.listHeads(sharedScope,root)).heads).toHaveLength(3)
   const commitReader=await runtime.connect(),privacyWriter=await pool.connect(),current=await reader.checkAuthority(scope,root)
   try{
    await commitReader.query('BEGIN')
    expect((await commitReader.query('SELECT shared.lock_memory_team_source_commit($1::jsonb,$2,$3,$4::jsonb,true) AS locked',[JSON.stringify(scope),root.kind,root.key,JSON.stringify(current.version)])).rows[0].locked).toBe(true)
    await privacyWriter.query('BEGIN')
    await expect(privacyWriter.query("INSERT INTO memory.memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('team',$1,1,'privacy')",[team])).rejects.toMatchObject({code:'55P03'})
   }finally{await privacyWriter.query('ROLLBACK');await commitReader.query('ROLLBACK');commitReader.release();privacyWriter.release()}
   await pool.query("INSERT INTO memory.memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('team',$1,1,'privacy')",[team])
   try{
    await expect(reader.listHeads(sharedScope,root)).rejects.toMatchObject({code:'revoked'})
    await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'revoked'})
   }finally{await pool.query('DELETE FROM memory.memory_scope_tombstones')}

   const personal=await reader.listHeads(scope,root);expect(personal.heads).toHaveLength(3)
   const personalBodies=await reader.resolveBodies(scope,root,personal.heads,personal.version)
   expect((personalBodies[0].payload as any).team_source.read_scope.target_installation_id).toBe(target)
   expect((personalBodies[0].payload as any).team_source.read_scope.target_owner_scope_kind).toBe('team')
   await pool.query("UPDATE public.extension_installations SET status='paused' WHERE installation_id=$1",[target])
   try{await expect(reader.listHeads(scope,root)).rejects.toMatchObject({code:'revoked'})}finally{await pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=$1",[target])}
   for(const [sql,restore] of [["UPDATE public.extension_organizations SET state='suspended'","UPDATE public.extension_organizations SET state='active'"],["UPDATE public.extension_scope_memberships SET roles=ARRAY['policy_administrator']","UPDATE public.extension_scope_memberships SET roles=ARRAY['reader']"]]){
    await pool.query(sql);try{await expect(reader.listHeads(sharedScope,root)).rejects.toMatchObject({code:'revoked'})}finally{await pool.query(restore)}
   }
  }finally{await pool.query("UPDATE public.team_memory_bindings SET installation_id=$1,owner_scope_kind='personal',owner_scope_id=$1",[inst])}
 })
 test('shared Git export and registered-base restoration keep typed Team evidence and reject revoked lineage before committing',async()=>{
  const {randomUUID,createHash}=await import('node:crypto'),{gitDbFixture,gitClaimFixture,insertGitConnection}=await import('../../testing/phase6-db-fixture.js')
  const {createGitExportService}=await import('../../git-sync/export-service.js'),{attestationFixture}=await import('../../testing/phase6-attestation-fixture.js'),{loadSkillConfig}=await import('../../skills/config.js')
  const {createReviewPolicyRepository,DEFAULT_TEAM_REVIEW_POLICY}=await import('../../governance/review-policy.js')
  const seed=createMemoryPool({databaseUrl:url!,databaseNamespace:'memory',dbPoolMax:2}),f=await gitDbFixture(seed),org=randomUUID(),source=randomUUID(),episode=randomUUID()
  try{
   f.grant.userId=1
   await pool.query("INSERT INTO public.extension_installations VALUES($1,'pocketctl-memory',NULL,'team',$2,'active',1,1,ARRAY['session:events:read'],ARRAY['memory.manage'],'{}')",[f.installationId,f.scopeId])
   await pool.query("INSERT INTO public.extension_organizations VALUES($1,'active')",[org]);await pool.query("INSERT INTO public.extension_teams VALUES($1,$2,'active')",[f.scopeId,org])
   await pool.query("INSERT INTO public.extension_scope_memberships(scope_kind,scope_id,user_id,state,roles,membership_id) VALUES('team',$1,1,'active',ARRAY['scope_administrator'],$2)",[f.scopeId,f.membershipId])
   await pool.query("INSERT INTO shared.memory_source_modes(installation_id,mode,generation) VALUES($1,'shared-active',2)",[f.installationId])
   await pool.query("UPDATE public.team_memory_bindings SET installation_id=$1,owner_scope_kind='team',owner_scope_id=$2",[f.installationId,f.scopeId])
   const reader=createPostgresSharedSourceReader(runtime),sharedScope={...scope,installationId:f.installationId,ownerScopeKind:'team' as const,ownerScopeId:f.scopeId},root={kind:'team_collaboration' as const,key:'call'}
   const page=await reader.listHeads(sharedScope,root),head=page.heads.find(h=>h.eventType==='agent_text')!,resolved=(await reader.resolveBodies(sharedScope,root,[head],page.version))[0]
   const payload=resolved.payload as any,session=head.sessionKey,excerpt=payload.text
   await seed.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,now(),now())',[f.installationId,session])
   await seed.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,source_provenance,
    source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
    VALUES($1,$2,'team',$3,$4,'team-call:call','agent_text',now(),'{}',decode($5,'hex'),$6,$7,'team_collaboration',$3,$4,$8,decode($5,'hex'),'canonical-json-sha256-v1','verified','v1')`,[source,f.installationId,head.canonicalKey,session,head.contentHash,head.classification,{team:payload.team_source},page.version])
   await seed.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,outcome,ready_at,compiler_version,repository_id,source_digest,document,evidence_manifest,document_compiler_version,compiled_at)
    VALUES($1,$2,$3,'team-call:call','ready','completed',now(),'fixture',$4,decode(repeat('a',64),'hex'),'{}',$5,'v1',now())`,[f.installationId,episode,session,f.repositoryId,{e1:{kind:'event',source_event_id:source}}])
   const claim=await gitClaimFixture(seed,f),policy=await createReviewPolicyRepository(seed).ensurePolicySet(f.installationId,DEFAULT_TEAM_REVIEW_POLICY)
   await seed.query('UPDATE knowledge_versions SET source_promotion_candidate_id=$2 WHERE version_id=$1',[claim.versionId,randomUUID()])
   await seed.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,source_event_id,evidence_kind,excerpt,excerpt_hash,occurred_at,ordinal,visibility)
    VALUES($1,$2,$3,$4,$5,'event',$6,$7,now(),0,'shared')`,[randomUUID(),f.installationId,claim.versionId,episode,source,excerpt,createHash('sha256').update(excerpt).digest()])
   await seed.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,'personal','fixture')`,[randomUUID(),f.installationId,claim.versionId,randomUUID(),policy.policyVersionId,[randomUUID()],f.membershipId])
   const connectionId=await insertGitConnection(seed,f),service=createGitExportService({pool:runtime,keys:attestationFixture().registry,skill:{context:{globalMode:'enabled',sharedMode:'shadow',config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})},cases:{loadCases:async()=>[]}}})
   const request={installationId:f.installationId,connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'local_preview',assets:[{kind:'claim',id:claim.claimId}]}
   const sourceId=(asset:import('../../git-sync/types.js').PortableAsset)=>{if(!('evidence' in asset.serverOnly))throw Error('expected_claim_asset');return asset.serverOnly.evidence[0].sourceEventId}
   const bundle=await service.export(f.grant,request)
   expect(bundle.assets).toHaveLength(1);expect(sourceId(bundle.assets[0].asset)).toBe(source)
   expect(await service.export(f.grant,request)).toMatchObject({exportId:bundle.exportId})
   const registered={installationId:f.installationId,connectionId,expectedGeneration:'1',exportId:bundle.exportId}
   expect(await service.withReadBase(f.grant,registered,async context=>sourceId(context.current[0].asset))).toBe(source)
   const count=async()=>(await seed.query('SELECT count(*)::text n FROM memory_git_snapshots WHERE installation_id=$1',[f.installationId])).rows[0].n,before=await count()
   await pool.query("UPDATE public.collaboration_session_participants SET state='removed' WHERE user_id=1")
   await expect(service.export(f.grant,request)).rejects.toThrow('git_source_stale')
   await expect(service.withReadBase(f.grant,registered,async()=>true)).rejects.toThrow('git_source_stale')
   expect(await count()).toBe(before)
  }finally{await pool.query("UPDATE public.collaboration_session_participants SET state='active' WHERE user_id=1");await pool.query("UPDATE public.team_memory_bindings SET installation_id=$1,owner_scope_kind='personal',owner_scope_id=$1",[inst]);await seed.end()}
 })

 test('canonical producer reuses exact legacy projection UUIDs and gives a new participant proof a distinct reference',async()=>{
  const {randomUUID}=await import('node:crypto'),{withSourceJobExecution}=await import('../../sources/source-execution.js')
  const {prepareCanonicalReferencePage,persistCanonicalReferencePage}=await import('../../sources/canonical-references.js')
  const {prepareSourceReferences}=await import('../../sources/prepared-sources.js')
  const reader=createPostgresSharedSourceReader(runtime),root={kind:'team_collaboration' as const,key:'call'},old=randomUUID(),jobs:string[]=[],refs:string[]=[old]
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
  await pool.query("SELECT shared.mark_memory_control_dirty('installation',$1)",[inst])
  const currentScope={...scope,modeGeneration:'3'}
  const page=await reader.listHeads(currentScope,root),head=page.heads[0],body=(await reader.resolveBodies(currentScope,root,[head],page.version))[0]
  const job=async()=>{const id=randomUUID();jobs.push(id);await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1::uuid,$2,'project_shared_source',($1::uuid)::text,52,'running','projection-identity',1,clock_timestamp()+interval '5 minutes')",[id,inst]);return id}
  try{
   await runtime.query(`INSERT INTO source_events(source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,classification,source_provenance,
    source_kind,canonical_key,canonical_session_key,source_version,content_hash,hash_version,mapping_state,adapter_version)
    VALUES($1,$2,'team',$3,$4,$5,$6,$7,$8,$9,$10,$11,'team_collaboration',$3,$4,$12,$9,'canonical-json-sha256-v1','verified','v1')`,[old,inst,head.canonicalKey,head.sessionKey,head.turnKey,head.eventType,head.occurredAt,body.payload,Buffer.from(head.contentHash,'hex'),head.classification,(head.provenance as any).team,page.version])
   const firstJob=await job()
   await withSourceJobExecution(runtime,{jobId:firstJob,claimedBy:'projection-identity',claimEpoch:1},async()=>{
    const prepared=await prepareCanonicalReferencePage(runtime,currentScope,root,{keys:[head.canonicalKey]})
    expect(await persistCanonicalReferencePage(runtime,prepared)).toEqual([{sourceEventId:old,canonicalKey:head.locator!.teamProjectionKey,sessionId:head.sessionKey,created:false}])
   })
   expect((await prepareSourceReferences(runtime,inst,[old])).events[0].source_event_id).toBe(old)
   await pool.query('UPDATE public.collaboration_session_participants SET revision=2 WHERE user_id=1')
   await pool.query("SELECT shared.mark_memory_control_dirty('installation',$1)",[inst])
   const secondScope={...currentScope,participantRevision:'2'},secondJob=await job()
   let next=''
   await withSourceJobExecution(runtime,{jobId:secondJob,claimedBy:'projection-identity',claimEpoch:1},async()=>{
    const prepared=await prepareCanonicalReferencePage(runtime,secondScope,root,{keys:[head.canonicalKey]})
    const result=await persistCanonicalReferencePage(runtime,prepared);next=result[0].sourceEventId;refs.push(next)
    expect(result[0].created).toBe(true);expect(next).not.toBe(old)
   })
   await expect(prepareSourceReferences(runtime,inst,[old])).rejects.toMatchObject({code:'revoked'})
   expect((await prepareSourceReferences(runtime,inst,[next])).events[0].source_event_id).toBe(next)
   const preserved=(await runtime.query('SELECT canonical_key,source_provenance,payload_hash FROM source_events WHERE source_event_id=$1',[old])).rows[0]
   expect(preserved).toEqual({canonical_key:head.canonicalKey,source_provenance:(head.provenance as any).team,payload_hash:Buffer.from(head.contentHash,'hex')})
  }finally{
   await pool.query('UPDATE public.collaboration_session_participants SET revision=1 WHERE user_id=1')
   await runtime.query('DELETE FROM source_events WHERE source_event_id=ANY($1::uuid[])',[refs])
   await runtime.query('DELETE FROM memory_jobs WHERE job_id=ANY($1::uuid[])',[jobs])
   await pool.query("UPDATE shared.memory_source_modes SET mode='shared-shadow',generation=2 WHERE installation_id=$1",[inst])
  }
 })

 test('canonical Team refs preserve v1/v2 lineage while raw business compilation remains dormant',async()=>{
  const {randomUUID}=await import('node:crypto'),{withSourceJobExecution}=await import('../../sources/source-execution.js')
  const {prepareCanonicalReferencePage,persistCanonicalReferencePage}=await import('../../sources/canonical-references.js')
  const {sourceReferenceFromEvents}=await import('../../episodes/compiler.js'),{manifestSourceRoots}=await import('../../episodes/source-lineage.js')
  const {createEpisodeRepository}=await import('../../episodes/repository.js')
  const job=randomUUID()
  await pool.query('UPDATE shared.memory_source_contract SET activation_ready=TRUE')
  await pool.query("SELECT shared.transition_memory_source_mode($1,2,'shared-active')",[inst])
  // This minimal Team fixture does not install the full Relay mode-capture
  // roster. Emit its actual control contract before capturing the job.
  await pool.query("SELECT shared.mark_memory_control_dirty('installation',$1)",[inst])
  await runtime.query("INSERT INTO memory_jobs(job_id,installation_id,job_type,idempotency_key,priority,state,claimed_by,claim_epoch,claim_expires_at) VALUES($1,$2,'project_shared_source',$3,52,'running','team-producer',1,clock_timestamp()+interval '5 minutes')",[job,inst,job])
  try{
   await withSourceJobExecution(runtime,{jobId:job,claimedBy:'team-producer',claimEpoch:1},async()=>{
    for(const root of [{kind:'team_collaboration' as const,key:'call'},{kind:'team_delivery' as const,key:deliverySession}]){
     const page=await prepareCanonicalReferencePage(runtime,{...scope,modeGeneration:'3'},root)
     await persistCanonicalReferencePage(runtime,page,{project:true,checkpoint:true,stabilizationMs:0})
     const rows=(await runtime.query('SELECT source_event_id,turn_id,payload,source_provenance FROM source_events WHERE installation_id=$1 AND source_kind=$2 ORDER BY source_sequence',[inst,root.kind])).rows
     expect(rows).toHaveLength(3)
     for(const row of rows){expect(row.payload).toBeNull();expect(row.source_provenance.source_kind).toBe('team_session');expect(row.source_provenance.source_version).toBe(root.kind==='team_delivery'?2:1);expect(row.source_provenance.team).toBeUndefined()}
     const reference=sourceReferenceFromEvents(rows)
     expect(reference).toMatchObject({source_kind:'team_session',source_version:root.kind==='team_delivery'?2:1,team_call_id:'call'})
     if(root.kind==='team_delivery')expect(reference).toHaveProperty('accepted_delivery.submission_id',submission)
     expect(manifestSourceRoots(Object.fromEntries(rows.map((r,i)=>['e'+i,r])),root.key,job)).toEqual([expect.stringMatching(/^team:/)])
     // The bounded metadata distribution seal does not enable raw Team
     // business compilation, which remains outside the finite launch profile.
     await pool.query('UPDATE shared.memory_source_work SET lease_owner=NULL,lease_token=NULL,lease_until=NULL,claimed_revision=NULL WHERE source_kind=$1 AND root_key=$2',[root.kind,root.key])
     const worker='team-consumer-admission-fixture'
     const claim=(await runtime.query('SELECT source_kind,root_key,lease_token::text,claimed_revision::text FROM shared.claim_memory_source_work($1,30,128)',[worker])).rows.find(r=>r.source_kind===root.kind&&r.root_key===root.key)!
     let seal:any=null
     for(let n=0;n<5;n++){
      seal=(await runtime.query('SELECT shared.step_memory_source_distribution($1,$2,$3,$4,$5,$6,$7,64) AS page',[root.kind,root.key,claim.lease_token,worker,claim.claimed_revision,seal?.scanId??null,seal?.cursor??''])).rows[0].page
      if(seal.state==='sealed')break
     }
     expect(seal.state).toBe('sealed')
     await runtime.query('SELECT shared.ack_memory_source_work($1,$2,$3,$4,$5)',[root.kind,root.key,claim.lease_token,worker,claim.claimed_revision])
     await createEpisodeRepository(runtime,{stabilizationMs:0}).compileTurn(inst,rows[0].turn_id)
     const episode=(await runtime.query('SELECT summary,evidence_manifest,document_compiler_version FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',[inst,rows[0].turn_id])).rows[0]
     expect(episode).toBeUndefined()
     expect((await runtime.query('SELECT state FROM memory_canonical_projection_progress WHERE installation_id=$1 AND source_kind=$2',[inst,root.kind])).rows.map(r=>r.state)).toEqual(['raw_ready'])
    }
   })
  }finally{
   await pool.query("UPDATE shared.memory_source_modes SET mode='shared-shadow',generation=2 WHERE installation_id=$1",[inst])
  }
 })

 test('accepted delivery capsule commits fence global withdrawal in Memory and Relay, independently of access revocation',async()=>{
  const {randomUUID}=await import('node:crypto'),{guardRetainedVersions}=await import('../../sources/retained-versions.js'),{retainedSourceRead}=await import('../../sources/retained-read.js')
  const claim=randomUUID(),version=randomUUID(),capsule=randomUUID(),evidence=randomUUID(),reader=createPostgresSharedSourceReader(runtime),deliveryRoot={kind:'team_delivery' as const,key:deliverySession}
  const heads=await reader.listHeads(scope,deliveryRoot),body=(await reader.resolveBodies(scope,deliveryRoot,heads.heads,heads.version))[0]
  const provenance=(await runtime.query("SELECT source_provenance FROM source_events WHERE installation_id=$1 AND source_kind='team_delivery' LIMIT 1",[inst])).rows[0]?.source_provenance??(body.head.provenance as any).team
  expect(provenance.source_version).toBe(2)
  await runtime.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1,$2,'test_invariant','installation','global','delivery-fence','active')",[claim,inst])
  await runtime.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'Retained delivery result','user_accepted',1)",[version,inst,claim])
  await runtime.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
  await runtime.query("INSERT INTO knowledge_evidence_capsules(capsule_id,installation_id,version_id,retention_basis,source_content_hash) VALUES($1,$2,$3,'user_accepted',sha256(convert_to('delivery','UTF8')))",[capsule,inst,version])
  await runtime.query("INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,capsule_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at,locator) VALUES($1,$2,$3,$4,1,'accepted_excerpt','delivery',sha256(convert_to('delivery','UTF8')),now(),$5)",[evidence,inst,version,capsule,{source_provenance:provenance}])
  const read=()=>retainedSourceRead(runtime,{installationId:inst,authorityGrant:{installationId:inst,configVersion:'1',userId:1}},async db=>{await guardRetainedVersions(db,inst,[version],{requireAvailable:true,requireCurrent:true});return true})
  expect(await read()).toBe(true)
  const consumer=await runtime.connect(),writer=await pool.connect()
  try{
   await consumer.query('BEGIN');await guardRetainedVersions(consumer,inst,[version],{requireAvailable:true,requireCurrent:true})
   for(const sql of ["INSERT INTO memory.memory_team_delivery_withdrawals(team_id,team_session_id,submission_id,decision_id) VALUES('team','ts',$1,$2)","INSERT INTO public.team_delivery_memory_withdrawals VALUES('team','ts',$1,$2)"]){
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
    await expect(writer.query(sql,[submission,decision])).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK')
   }
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
   await expect(writer.query('INSERT INTO public.team_artifact_revocations VALUES($1)',[submission])).rejects.toMatchObject({code:'55P03'});await writer.query('ROLLBACK')
   await consumer.query('COMMIT')
   for(const [insert,remove,args] of [
    ["INSERT INTO memory.memory_team_delivery_withdrawals(team_id,team_session_id,submission_id,decision_id) VALUES('team','ts',$1,$2)",'DELETE FROM memory.memory_team_delivery_withdrawals',[submission,decision]],
    ["INSERT INTO public.team_delivery_memory_withdrawals VALUES('team','ts',$1,$2)",'DELETE FROM public.team_delivery_memory_withdrawals',[submission,decision]],
    ['INSERT INTO public.team_artifact_revocations VALUES($1)','DELETE FROM public.team_artifact_revocations',[submission]],
   ] as const){await writer.query(insert,[...args]);try{expect(await read()).toBeUndefined()}finally{await writer.query(remove)}}
  }finally{await consumer.query('ROLLBACK');await writer.query('ROLLBACK');consumer.release();writer.release()}
 })

})
