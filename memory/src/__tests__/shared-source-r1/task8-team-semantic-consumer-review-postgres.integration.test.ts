import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {task8ConsumerFixFixture} from './task8-team-semantic-consumer-fix-fixture.js'
import {prepareSourceAuthorities,prepareSourceReferences} from '../../sources/prepared-sources.js'
import {discoverTeamSemanticGroup} from '../../sources/team-semantic-discovery.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 actual first consumer review C1 C2 C3 regressions',()=>{
 let f:Awaited<ReturnType<typeof task8ConsumerFixFixture>>
 beforeAll(async()=>{if(!value)throw Error('explicit_task8_fixture_required');f=await task8ConsumerFixFixture(JSON.parse(value))})
 afterAll(async()=>{await f?.close()})
 const publish=async(installation:string,roots:Parameters<typeof f.sealAll>[1])=>{
  await f.sealAll(installation,roots)
  for(const root of roots){const jobs=await f.sourceJobs(installation,root);for(const job of jobs)await f.runSourceJob(job)}
 }
 const retained=async(installation:string,ids:string[])=>{
  const prepared=await prepareSourceAuthorities(f.runtime,installation,ids),c=await f.runtime.connect()
  try{await c.query('BEGIN');await prepared.assertCurrent(c,{forCommit:true});await c.query('COMMIT')}
  catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
 }
 test('C1 actual retained entry and COMMIT deny last-support revocation',async()=>{
  const g=await f.group();await publish(g.installation,[g.root])
  const p=(await f.runtime.query("SELECT * FROM memory_team_semantic_publications WHERE installation_id=$1 AND disposition='published'",[g.installation])).rows[0],ids=[p.goal_ref_id,p.reply_ref_id,p.outcome_ref_id]
  await retained(g.installation,ids)
  await f.publisher.query("UPDATE public.collaboration_session_participants SET state='removed',revision=revision+1,removed_at=clock_timestamp() WHERE team_session_id=$1 AND user_id=ANY($2::int[])",[g.session.id,g.users.slice(0,2)])
  await f.sealAll(g.installation,[g.root])
  await expect(retained(g.installation,ids)).rejects.toThrow()
 })
 test('C1 A revoked/B current permits only new semantic refs and preserves mixed raw AND denial',async()=>{
  const g=await f.group();await publish(g.installation,[g.root])
  const p=(await f.runtime.query("SELECT * FROM memory_team_semantic_publications WHERE installation_id=$1 AND disposition='published'",[g.installation])).rows[0],ids=[p.goal_ref_id,p.reply_ref_id,p.outcome_ref_id]
  const raw=(await f.runtime.query("SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND source_kind='team_collaboration' AND event_type='user_goal' AND source_provenance->'read_scope'->>'participant_user_id'=$2",[g.installation,String(g.users[0])])).rows[0].source_event_id
  const before=(await f.runtime.query("SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND source_kind='team_semantic' ORDER BY source_event_id",[g.installation])).rows
  const audit={execution:p.publication_execution_id,support:p.support_digest.toString('hex'),roster:p.source_roster}
  await f.publisher.query("UPDATE public.collaboration_session_participants SET state='removed',revision=revision+1,removed_at=clock_timestamp() WHERE team_session_id=$1 AND user_id=$2",[g.session.id,g.users[0]])
  await publish(g.installation,[g.root])
  expect((await prepareSourceReferences(f.runtime,g.installation,ids)).events).toHaveLength(3)
  await retained(g.installation,ids)
  await expect(prepareSourceReferences(f.runtime,g.installation,[raw,ids[0]])).rejects.toThrow()
  await expect(retained(g.installation,[raw,ids[0]])).rejects.toThrow()
  expect((await f.runtime.query("SELECT source_event_id::text FROM source_events WHERE installation_id=$1 AND source_kind='team_semantic' ORDER BY source_event_id",[g.installation])).rows).toEqual(before)
  const after=(await f.runtime.query('SELECT publication_execution_id,support_digest,source_roster FROM memory_team_semantic_publications WHERE installation_id=$1',[g.installation])).rows[0]
  expect({execution:after.publication_execution_id,support:after.support_digest.toString('hex'),roster:after.source_roster}).toEqual(audit)
  expect((await f.runtime.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode'",[g.installation])).rows[0].n).toBe(1)
 })
 test('C2 actual accepted A+B receipts retain outside-personal roots while both personal and shared receivers publish',async()=>{
  const g=await f.group({delivery:true}),a=await f.accepted(g),personal=await f.personal(g.users[0])
  await f.sealAll(personal,a.roots)
  const roster=await discoverTeamSemanticGroup(f.runtime,personal,a.roots[0])
  expect(roster.roots).toHaveLength(2)
  expect(roster.roots.filter(r=>r.contexts.length===0)).toHaveLength(1)
  await publish(personal,[a.roots[0]])
  await publish(g.installation,a.roots)
  for(const installation of [personal,g.installation]){
   expect((await f.runtime.query("SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1 AND source_kind='team_semantic'",[installation])).rows[0].n).toBe(3)
   expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_turns WHERE installation_id=$1',[installation])).rows[0].n).toBe(1)
  }
 })
 test('C1 v2 global withdrawal independently denies generic retained authority after all receipts become negative',async()=>{
  const g=await f.group({delivery:true}),a=await f.accepted(g);await publish(g.installation,a.roots)
  const p=(await f.runtime.query("SELECT * FROM memory_team_semantic_publications WHERE installation_id=$1 AND disposition='published'",[g.installation])).rows[0],ids=[p.goal_ref_id,p.reply_ref_id,p.outcome_ref_id]
  await retained(g.installation,ids)
  await a.delivery.revokeArtifact(g.task.task_id,g.users[0],a.submission,'proof',{request_id:'task8-withdraw-'+g.call,expected_revision:3,reason:'Task8 synthetic global withdrawal'})
  await f.sealAll(g.installation,a.roots)
  await expect(retained(g.installation,ids)).rejects.toThrow()
 })
 test('C3 original old v1/new from_now receiver excludes without raw staging and newer eligible group progresses',async()=>{
  const g=await f.group(),personal=await f.personal(g.users[0],true)
  await publish(personal,[g.root])
  const excluded=(await f.runtime.query('SELECT disposition,goal_ref_id,reply_ref_id,outcome_ref_id FROM memory_team_semantic_publications WHERE installation_id=$1',[personal])).rows
  expect(excluded).toEqual([{disposition:'policy_excluded',goal_ref_id:null,reply_ref_id:null,outcome_ref_id:null}])
  expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1',[personal])).rows[0].n).toBe(0)
  expect((await f.runtime.query('SELECT count(*)::int AS n FROM source_turns WHERE installation_id=$1',[personal])).rows[0].n).toBe(0)
  expect((await f.runtime.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND job_type='compile_episode'",[personal])).rows[0].n).toBe(0)
  expect((await f.admin.query('SELECT processed_revision>=dispatched_revision AS done FROM shared.memory_source_progress WHERE installation_id=$1 AND source_kind=$2 AND root_key=$3',[personal,g.root.kind,g.root.key])).rows[0].done).toBe(true)
  const next=await f.nextCall(g);await publish(personal,[next.root])
  expect((await f.runtime.query("SELECT count(*)::int AS n FROM source_events WHERE installation_id=$1 AND source_kind='team_semantic'",[personal])).rows[0].n).toBe(3)
 })
})
