import {describe,test,expect,vi} from 'vitest'
import {randomUUID,createHash} from 'node:crypto'
import {task8ConsumerFixFixture} from './task8-team-semantic-consumer-fix-fixture.js'
import {createEpisodeRepository} from '../../episodes/repository.js'
import {prepareEvidenceSources} from '../../sources/evidence-sources.js'
import * as evidenceSources from '../../sources/evidence-sources.js'
import {readBoundEvidence} from '../../claims/evidence-on-demand.js'
import {withSourceJobExecution} from '../../sources/source-execution.js'
const value=process.env.TASK8_TEAM_SEMANTIC_CONSUMER_CONFIG,suite=value?describe:describe.skip
suite('Task8 actual semantic evidence material boundary',()=>{
 test('original evidence API expiry crossing final semantic commit guard refuses material',async()=>{
  if(!value)throw Error('explicit_task8_fixture_required')
  const f=await task8ConsumerFixFixture(JSON.parse(value))
  try{
   const g=await f.group(),installation=await f.personal(g.users[0])
   await f.sealAll(installation,[g.root]);for(const job of await f.sourceJobs(installation,g.root))await f.runSourceJob(job)
   const p=(await f.runtime.query("SELECT * FROM memory_team_semantic_publications WHERE installation_id=$1 AND disposition='published'",[installation])).rows[0]
   const worker='task8-evidence-'+randomUUID(),job=(await f.runtime.query("UPDATE memory_jobs SET state='running',claimed_by=$3,claim_epoch=claim_epoch+1,claim_expires_at=clock_timestamp()+interval '5 minutes' WHERE installation_id=$1 AND job_type='compile_episode' AND idempotency_key=$2 RETURNING *",[installation,'compile_episode:'+p.semantic_turn_id,worker])).rows[0]
   await withSourceJobExecution(f.runtime,{jobId:job.job_id,claimedBy:worker,claimEpoch:job.claim_epoch},()=>createEpisodeRepository(f.runtime,{lifecycleMode:'off',stabilizationMs:0}).compileTurn(installation,p.semantic_turn_id),{branch:'canonical'})
   const episode=(await f.runtime.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1 AND turn_id=$2',[installation,p.semantic_turn_id])).rows[0].episode_id
   const source=(await f.runtime.query('SELECT source_provenance,occurred_at FROM source_events WHERE installation_id=$1 AND source_event_id=$2',[installation,p.reply_ref_id])).rows[0]
   const claim=randomUUID(),version=randomUUID(),evidence=randomUUID(),excerpt='semantic reply.',hash=createHash('sha256').update(excerpt).digest()
   // Exact new synthetic accepted fixture only; no existing knowledge/history
   // is rewritten. Service under test is the real preparation/read boundary.
   await f.runtime.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state) VALUES($1::uuid,$2::uuid,'test_invariant','installation',$2::text,$1::text,'active')",[claim,installation])
   await f.runtime.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence) VALUES($1,$2,$3,1,'Bounded Team excerpt','{}','user_accepted',1)",[version,installation,claim])
   await f.runtime.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
   await f.runtime.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,source_event_id,evidence_kind,locator,excerpt,excerpt_hash,occurred_at,ordinal)
    VALUES($1,$2,$3,$4,$5,'event',$6::jsonb,$7,$8,$9,0)`,[evidence,installation,version,episode,p.reply_ref_id,JSON.stringify({source_provenance:source.source_provenance,span:{field:'text',start:9,end:24}}),excerpt,hash,source.occurred_at])
   const original=evidenceSources.prepareEvidenceSources
   const spy=vi.spyOn(evidenceSources,'prepareEvidenceSources').mockImplementation(async(...args)=>{
    const prepared=await original(...args)
    return {...prepared,async assertCurrent(client,options){
     await prepared.assertCurrent(client,options)
     if(options?.forCommit)await client.query('SELECT pg_sleep(0.30)')
    }}
   })
   try{
    const expiresAt=Number((await f.runtime.query('SELECT extract(epoch from clock_timestamp())::double precision+0.25 AS expires')).rows[0].expires)
    expect(await readBoundEvidence(f.runtime,{installationId:installation,evidenceId:evidence,userId:g.users[0],configVersion:'1',expiresAt},false)).toBeNull()
   }finally{spy.mockRestore()}
  }finally{await f.close()}
 })
})
