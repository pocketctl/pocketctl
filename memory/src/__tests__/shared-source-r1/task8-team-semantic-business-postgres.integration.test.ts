import {describe,test,expect} from 'vitest'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {createMemoryPool} from '../../db.js'
import {prepareSourceReferences} from '../../sources/prepared-sources.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {manifestSourceRoots,teamOriginalRoot} from '../../episodes/source-lineage.js'
import {withSourceJobExecution} from '../../sources/source-execution.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 actual semantic business consumer ports',()=>{
 test('actual source resolver and episode transaction preserve explicit semantic identity and original native roots',async()=>{
  if(!value)throw Error('explicit_task8_fixture_required')
  const config=JSON.parse(value),u=new URL(config.databaseUrl)
  if(!/^task8_team_semantic_consumer_retry[23]_test$/.test(u.pathname.slice(1))||u.hostname!=='127.0.0.1')throw Error('exact_task8_fixture_required')
  const admin=new pg.Pool({connectionString:u.href,max:1,statement_timeout:5000,lock_timeout:1000}),runtime=createMemoryPool({databaseUrl:config.runtimeDatabaseUrls.memoryRole,databaseNamespace:'memory',dbPoolMax:4})
  try{
   expect((await admin.query(`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS role,inet_server_addr()::text AS "serverAddress",inet_server_port()::text AS "serverPort"`)).rows[0]).toEqual(config.expected)
   expect((await runtime.query('SELECT current_user AS role')).rows[0].role).toBe(config.roles.memoryRole)
   const p=(await runtime.query("SELECT * FROM memory_team_semantic_publications WHERE disposition='published' ORDER BY installation_id LIMIT 1")).rows[0]
   expect(p).toBeTruthy()
   const ids=[p.goal_ref_id,p.reply_ref_id,p.outcome_ref_id]
   const prepared=await prepareSourceReferences(runtime,p.installation_id,ids)
   expect(prepared.events).toHaveLength(3)
   expect(prepared.events.every(e=>e.source_kind==='team_semantic'&&e.source_provenance.source_kind==='team_semantic')).toBe(true)
   const providers=(await admin.query('SELECT count(*)::int AS n FROM shared.memory_source_provider_attempts')).rows[0].n
   const worker='task8-episode-'+randomUUID(),job=(await runtime.query("UPDATE memory_jobs SET state='running',claimed_by=$3,claim_epoch=claim_epoch+1,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE installation_id=$1 AND job_type='compile_episode' AND idempotency_key=$2 RETURNING *",[p.installation_id,'compile_episode:'+p.semantic_turn_id,worker])).rows[0]
   expect(job).toBeTruthy()
   await withSourceJobExecution(runtime,{jobId:job.job_id,claimedBy:worker,claimEpoch:job.claim_epoch},()=>createEpisodeRepository(runtime,{stabilizationMs:0,lifecycleMode:'off'}).compileTurn(p.installation_id,p.semantic_turn_id),{branch:'canonical'})
   const episode=(await runtime.query('SELECT episode_id::text,summary,evidence_manifest FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',[p.installation_id,p.semantic_turn_id])).rows[0]
   expect(episode).toBeTruthy()
   expect(episode.summary.references.source?.source_kind).toBe('team_semantic')
   const refs=Object.values(episode.evidence_manifest) as Record<string,any>[]
   expect(refs.filter(e=>e.source_event_id).every(e=>ids.includes(e.source_event_id)&&e.source_provenance?.source_kind==='team_semantic')).toBe(true)
   const roots=manifestSourceRoots(episode.evidence_manifest,p.semantic_session_id,episode.episode_id)
   const original=teamOriginalRoot(prepared.events[0].source_provenance.native)
   expect(original).toBeTruthy();expect(roots).toEqual([original])
   expect((await admin.query('SELECT count(*)::int AS n FROM shared.memory_source_provider_attempts')).rows[0].n).toBe(providers)
  }finally{await runtime.end();await admin.end()}
 })
})
