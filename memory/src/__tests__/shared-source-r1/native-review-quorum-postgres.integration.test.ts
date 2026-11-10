import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {governanceFixture} from '../../testing/governance-fixture.js'
import {createTransactionBoundPool} from '../../api/transaction-bound-pool.js'
import {createPublicationService} from '../../governance/publication-service.js'
import Fastify from 'fastify'
import {registerGovernanceRoutes} from '../../api/governance-routes.js'
import {copyHistoricalAuthorityFixture} from '../../testing/publication-reviewer-window-fixture.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('publication quorum uses current native reviewer authority',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!)},60000)
 afterAll(async()=>{await f?.close()})
 async function approved(){
  const g=await governanceFixture(f.runtime),org=randomUUID()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'native quorum synthetic')",[org])
  await f.pool.query("INSERT INTO public.extension_teams(team_id,organization_id,name) VALUES($1,$2,'native quorum synthetic')",[g.team,org])
  const owner=(await f.pool.query("INSERT INTO public.users(email,password_hash) VALUES($1,'synthetic-only') RETURNING id",[randomUUID()+'@quorum.invalid'])).rows[0].id
  for(const [id,kind]of [[g.personal,'personal'],[g.team,'team']])await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_user_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,$3,$1,'active','{}','{}',ARRAY['memory.manage'],'retained_history')",[id,kind==='personal'?owner:null,kind])
  for(const [id,role]of [[g.proposer,'contributor'],[g.reviewer,'reviewer'],[g.publisher,'scope_administrator']]){
   const user=(await f.pool.query("INSERT INTO public.users(email,password_hash) VALUES($1,'synthetic-only') RETURNING id",[randomUUID()+'@quorum.invalid'])).rows[0].id
   await f.pool.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'team',$2,$3,ARRAY[$4]::text[])",[id,g.team,user,role])
  }
  const proposal=await g.approved()
  // The native organization exists even when the local ancestry has not
  // refreshed: its two-approval floor must be satisfied by this fixture.
  await createPublicationService(f.runtime).decide({grant:g.grant(g.publisher,['read','review']),targetInstallationId:g.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:proposal.candidate.revision,decision:'approve'})
  const publish=()=>createPublicationService(f.runtime).publish({grant:g.grant(g.publisher,['read','publish']),targetInstallationId:g.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:proposal.candidate.revision,resolution:'new'})
  return {...g,proposal,publish}
 }
 test('an unchanged native reviewer permits an actual publication',async()=>{const g=await approved();expect(await g.publish()).toHaveProperty('versionId')})
 test('revoked native reviewer cannot count through an active stale local mirror',async()=>{
  const g=await approved()
  await f.pool.query("UPDATE public.extension_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1",[g.reviewer])
  expect((await f.runtime.query('SELECT state,membership_revision::text FROM memory_scope_memberships WHERE membership_id=$1',[g.reviewer])).rows[0]).toEqual({state:'active',membership_revision:'1'})
  await expect(g.publish()).rejects.toMatchObject({code:'quorum_failed'})
  expect((await f.runtime.query('SELECT state FROM memory_promotion_candidates WHERE candidate_id=$1',[g.proposal.candidate.candidate_id])).rows[0].state).not.toBe('published')
 })
 test('native role downgrade invalidates a stored approval before mirror refresh',async()=>{
  const g=await approved();await f.pool.query("UPDATE public.extension_scope_memberships SET roles=ARRAY['reader'],membership_revision=2 WHERE membership_id=$1",[g.reviewer])
  await expect(g.publish()).rejects.toMatchObject({code:'quorum_failed'})
 })
 test('native reviewer state remains authoritative over a stale local revoked mirror',async()=>{
  const g=await approved();await f.runtime.query("UPDATE memory_scope_memberships SET state='revoked' WHERE membership_id=$1",[g.reviewer])
  expect(await g.publish()).toHaveProperty('versionId')
 })
 test('an existing local reviewer validity deadline still excludes an approval',async()=>{
  const g=await approved();await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[g.reviewer])
  await expect(g.publish()).rejects.toMatchObject({code:'quorum_failed'})
 })
 test('counted native reviewer locks survive until the actual publication commit',async()=>{
  const g=await approved(),blocker=await f.pool.connect(),writer=await f.pool.connect();let pending:ReturnType<typeof g.publish>|undefined
  try{
   await blocker.query('BEGIN');await blocker.query('LOCK TABLE memory.knowledge_claims IN SHARE MODE');pending=g.publish();void pending.catch(()=>undefined)
   let waiting=false
   for(let n=0;n<100;n++){
    if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO knowledge_claims%' LIMIT 1")).rowCount){waiting=true;break}
    await new Promise(r=>setTimeout(r,10))
   }
   expect(waiting).toBe(true);await writer.query('BEGIN')
   await expect(writer.query('SELECT 1 FROM public.extension_scope_memberships WHERE membership_id=$1 FOR UPDATE NOWAIT',[g.reviewer])).rejects.toMatchObject({code:'55P03'})
   await writer.query('ROLLBACK');await blocker.query('COMMIT');expect(await pending).toHaveProperty('versionId')
  }finally{await writer.query('ROLLBACK');writer.release();await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined)}
 })

 test('idempotent transaction-bound publication holds reviewer locks until the outer COMMIT',async()=>{
  const g=await approved(),outer=await f.runtime.connect(),writer=await f.pool.connect()
  try{
   await outer.query('BEGIN')
   const result=await createPublicationService(createTransactionBoundPool(outer)).publish({grant:g.grant(g.publisher,['read','publish']),targetInstallationId:g.team,candidateId:g.proposal.candidate.candidate_id,expectedCandidateRevision:g.proposal.candidate.revision,resolution:'new'})
   expect(result).toHaveProperty('versionId');await writer.query('BEGIN')
   await expect(writer.query('SELECT 1 FROM public.extension_scope_memberships WHERE membership_id=$1 FOR UPDATE NOWAIT',[g.reviewer])).rejects.toMatchObject({code:'55P03'})
   await writer.query('ROLLBACK');await outer.query('COMMIT');await writer.query('BEGIN')
   expect((await writer.query('SELECT 1 FROM public.extension_scope_memberships WHERE membership_id=$1 FOR UPDATE NOWAIT',[g.reviewer])).rowCount).toBe(1)
  }finally{await writer.query('ROLLBACK');writer.release();await outer.query('ROLLBACK');outer.release()}
 })

 test('a reviewer date deadline elapsed during blocked publication rolls back the entire write',async()=>{
  const g=await approved(),blocker=await f.pool.connect();let pending:ReturnType<typeof g.publish>|undefined
  try{
   await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()+interval '500 milliseconds' WHERE membership_id=$1",[g.reviewer])
   await blocker.query('BEGIN');await blocker.query('LOCK TABLE memory.knowledge_claims IN SHARE MODE');pending=g.publish();void pending.catch(()=>undefined)
   let waiting=false
   for(let n=0;n<100;n++){
    if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO knowledge_claims%' LIMIT 1")).rowCount){waiting=true;break}
    await new Promise(r=>setTimeout(r,10))
   }
   expect(waiting).toBe(true);await blocker.query('SELECT pg_sleep(0.6)');await blocker.query('COMMIT')
   await expect(pending).rejects.toMatchObject({code:'quorum_failed'})
   expect((await f.runtime.query('SELECT state FROM memory_promotion_candidates WHERE candidate_id=$1',[g.proposal.candidate.candidate_id])).rows[0].state).not.toBe('published')
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined)}
 })

 test('reviewer validity elapsed after savepoint release rejects the physical outer COMMIT',async()=>{
  const g=await approved(),outer=await f.runtime.connect()
  try{
   await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()+interval '500 milliseconds' WHERE membership_id=$1",[g.reviewer])
   await outer.query('BEGIN')
   await createPublicationService(createTransactionBoundPool(outer)).publish({grant:g.grant(g.publisher,['read','publish']),targetInstallationId:g.team,candidateId:g.proposal.candidate.candidate_id,expectedCandidateRevision:g.proposal.candidate.revision,resolution:'new'})
   await outer.query('SELECT pg_sleep(0.6)')
   await expect(outer.query('COMMIT')).rejects.toMatchObject({code:'55000',message:'reviewer_validity_expired'})
   expect((await f.runtime.query('SELECT state FROM memory_promotion_candidates WHERE candidate_id=$1',[g.proposal.candidate.candidate_id])).rows[0].state).not.toBe('published')
  }finally{await outer.query('ROLLBACK');outer.release()}
 })
 test('actual HTTP receipt wait expiry returns quorum_failed and rolls back publication and idempotency receipt',async()=>{
  const g=await approved(),app=Fastify(),blocker=await f.pool.connect();let pending:Promise<Awaited<ReturnType<typeof app.inject>>>|undefined
  registerGovernanceRoutes(app,{pool:f.runtime,guard:{guardV2:async()=>g.grant(g.publisher,['read','publish'])} as never,sharedScopesEnabled:true,cursorSigningKey:'native-review-clock-fixture'})
  await f.pool.query(`CREATE FUNCTION memory.fixture_block_publication_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(91811261110::bigint);RETURN NEW;END $$;
    CREATE TRIGGER fixture_block_publication_receipt BEFORE UPDATE ON memory.memory_idempotency_keys FOR EACH ROW EXECUTE FUNCTION memory.fixture_block_publication_receipt()`)
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(91811261110::bigint)')
   await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()+interval '1 second' WHERE membership_id=$1",[g.reviewer])
   pending=app.inject({method:'POST',url:`/api/v1/memory/governance/proposals/${g.proposal.candidate.candidate_id}/publish`,headers:{authorization:'Bearer synthetic-guard','idempotency-key':'native-review-clock-'+g.team},payload:{target_installation_id:g.team,expected_revision:g.proposal.candidate.revision,resolution:'new'}})
   let waiting=false
   for(let n=0;n<100;n++){
    if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE memory_idempotency_keys%' LIMIT 1")).rowCount){waiting=true;break}
    await new Promise(r=>setTimeout(r,10))
   }
   expect(waiting).toBe(true);await blocker.query('SELECT pg_sleep(1.1)');await blocker.query('COMMIT')
   const response=await pending;expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe('quorum_failed')
   expect((await f.runtime.query('SELECT state FROM memory_promotion_candidates WHERE candidate_id=$1',[g.proposal.candidate.candidate_id])).rows[0].state).not.toBe('published')
   expect((await f.runtime.query('SELECT 1 FROM memory_authority_records WHERE installation_id=$1',[g.team])).rowCount).toBe(0)
   expect((await f.runtime.query("SELECT 1 FROM memory_idempotency_keys WHERE installation_id=$1 AND operation='governance.publish'",[g.team])).rowCount).toBe(0)
  }finally{await blocker.query('ROLLBACK');blocker.release();await pending?.catch(()=>undefined);await app.close();await f.pool.query('DROP TRIGGER fixture_block_publication_receipt ON memory.memory_idempotency_keys;DROP FUNCTION memory.fixture_block_publication_receipt()')}
 })
 test('historical native authority copy retains expired reviewer provenance without a live mutation stamp',async()=>{
  const g=await approved(),result=await g.publish()
  await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE membership_id=$1",[g.reviewer])
  const copied=await copyHistoricalAuthorityFixture(f.runtime,result.versionId)
  expect((await f.runtime.query('SELECT 1 FROM memory_authority_records WHERE version_id=$1',[copied])).rowCount).toBe(1)
 })
})
