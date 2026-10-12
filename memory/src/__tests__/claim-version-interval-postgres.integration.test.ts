import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createClaimRepository} from '../claims/repository.js'
import {createSearchService} from '../retrieval/search-service.js'
import {createMemoryReadService} from '../retrieval/read-service.js'
import {asOfClaimVersionSql} from '../claims/version-selection.js'
import {contextClaimFacts,eligibleContextFacts} from '../context/consumption.js'
import {queryHookPool} from './helpers/query-hook-pool.js'
import {gitImportFixture} from '../testing/phase6-import-fixture.js'
import {createGitImportService} from '../git-sync/import-service.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('revision intervals remain separate from fact validity',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function correct(f:Awaited<ReturnType<typeof governanceFixture>>,revision=1,statement='Corrected transactional fixture invariant'){
  const episode=(await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1',[f.personal])).rows[0].episode_id
  return createClaimRepository(pool).correctClaim({installationId:f.personal,claimId:f.claim,expectedRevision:revision,statement,
   evidence:[{episodeId:episode,evidenceKind:'episode',locator:{},excerpt:'Reviewed corrected invariant',occurredAt:new Date()}]})
 }
 test('manual correction preserves both original and new fact validity',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("UPDATE knowledge_versions SET valid_from='2020-01-01 00:00:00.123456+00',valid_until='2099-01-01 00:00:00.654321+00' WHERE version_id=$1",[f.version])
  const result=await correct(f);expect(result.ok).toBe(true)
  const rows=(await pool.query("SELECT valid_from::text,valid_until::text FROM knowledge_versions WHERE claim_id=$1 ORDER BY version_number",[f.claim])).rows
  expect(rows).toEqual([{valid_from:'2020-01-01 00:00:00.123456+00',valid_until:'2099-01-01 00:00:00.654321+00'},{valid_from:'2020-01-01 00:00:00.123456+00',valid_until:'2099-01-01 00:00:00.654321+00'}])
 })
 test('manual correction closes the old revision at the exact new boundary',async()=>{
  const f=await governanceFixture(pool),result=await correct(f);expect(result.ok).toBe(true)
  const rows=(await pool.query('SELECT effective_from::text,effective_until::text FROM knowledge_versions WHERE claim_id=$1 ORDER BY version_number',[f.claim])).rows
  expect(rows[0].effective_from).not.toBeNull();expect(rows[0].effective_until).not.toBeNull()
  expect(rows[0].effective_until).toBe(rows[1].effective_from);expect(rows[1].effective_until).toBeNull()
 })
 test('current search never includes two legacy revisions with open fact windows',async()=>{
  const f=await governanceFixture(pool)
  const v=(await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence)
    VALUES(gen_random_uuid(),$1,$2,2,'Corrected transactional fixture invariant','user_corrected',0.9) RETURNING version_id`,[f.personal,f.claim])).rows[0].version_id
  await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at)
   SELECT gen_random_uuid(),installation_id,$2,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at FROM knowledge_evidence WHERE version_id=$1`,[f.version,v])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[f.claim,v])
  const result=await createSearchService({pool,recallEmbeddingTimeoutMs:500,cursorSigningKey:'revision-test'}).search({installationId:f.personal,query:'transactional fixture invariant'})
  expect(result.hits.map(h=>h.versionId)).toEqual([v])
 })
 test('current management list rejects a pointer to a future revision',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("UPDATE knowledge_versions SET effective_from=clock_timestamp()+interval '1 day' WHERE version_id=$1",[f.version])
  const result=await createMemoryReadService(pool,'revision-test').listActiveClaims(f.personal)
  expect(result.claims).toEqual([]);expect(result.total_count).toBe(0)
 })
 test('one microsecond before and exactly at the boundary select different revisions',async()=>{
  const f=await governanceFixture(pool),result=await correct(f);expect(result.ok).toBe(true);if(!result.ok)return
  const boundary=(await pool.query('SELECT effective_from::text at FROM knowledge_versions WHERE version_id=$1',[result.versionId])).rows[0].at
  async function selected(delta:string){return(await pool.query(`SELECT v.version_id FROM knowledge_claims c JOIN knowledge_versions v USING(installation_id,claim_id)
   WHERE c.claim_id=$1 AND ${asOfClaimVersionSql('c','v',"($2::timestamptz+$3::interval)")}`,[f.claim,boundary,delta])).rows.map(r=>r.version_id)}
  expect(await selected('-1 microsecond')).toEqual([f.version]);expect(await selected('0 microseconds')).toEqual([result.versionId])
  expect(await createMemoryReadService(pool,'revision-test').selectClaimVersion(f.personal,f.claim)).toMatchObject({version_id:result.versionId})
  const detail=await createMemoryReadService(pool,'revision-test').getClaim(f.personal,f.claim)
  expect(detail!.versions.map(v=>v.selection_status)).toEqual(['stale','current'])
 })
 test('historical search retains past facts after a present-day correction',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("UPDATE knowledge_versions SET created_at='2020-01-01',valid_from='2020-01-01',valid_until='2099-01-01' WHERE version_id=$1",[f.version])
  const result=await correct(f);expect(result.ok).toBe(true)
  const svc=createSearchService({pool,recallEmbeddingTimeoutMs:500,cursorSigningKey:'revision-test'})
  const old=await svc.search({installationId:f.personal,query:'transactional fixture invariant',asOf:new Date('2021-01-01')})
  expect(old.hits.map(h=>h.versionId)).toEqual([f.version])
  const read=await createMemoryReadService(pool,'revision-test').selectClaimVersion(f.personal,f.claim,{asOf:new Date('2021-01-01')})
  expect(read?.version_id).toBe(f.version)
 })
 test('historical pagination keeps its selection mode when only the signed cursor is repeated',async()=>{
  const first=await governanceFixture(pool)
  const other=(await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state)
   VALUES(gen_random_uuid(),$1,'test_invariant','installation','','second-historical','active') RETURNING claim_id`,[first.personal])).rows[0].claim_id
  const otherVersion=(await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,created_at)
   SELECT gen_random_uuid(),installation_id,$2,1,statement,authority,confidence,'2020-01-01' FROM knowledge_versions WHERE version_id=$1 RETURNING version_id`,[first.version,other])).rows[0].version_id
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[other,otherVersion])
  await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at)
   SELECT gen_random_uuid(),installation_id,$2,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at FROM knowledge_evidence WHERE version_id=$1`,[first.version,otherVersion])
  await pool.query("UPDATE knowledge_versions SET created_at='2020-01-01' WHERE version_id=$1",[first.version])
  expect((await correct(first)).ok).toBe(true);expect((await correct({...first,claim:other,version:otherVersion},1,'Second corrected transactional fixture invariant')).ok).toBe(true)
  const svc=createSearchService({pool,recallEmbeddingTimeoutMs:500,cursorSigningKey:'revision-test'}),input={installationId:first.personal,query:'transactional fixture invariant',limit:1}
  const page=await svc.search({...input,asOf:new Date('2021-01-01')});expect(page.nextCursor).toBeTruthy()
  const next=await svc.search({...input,cursor:page.nextCursor})
  expect(new Set([...page.hits,...next.hits].map(h=>h.versionId))).toEqual(new Set([first.version,otherVersion]))
 })
 test('correcting an expired fact never revives it or falls back to older text',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("UPDATE knowledge_versions SET valid_from='2020-01-01',valid_until='2021-01-01' WHERE version_id=$1",[f.version])
  expect((await correct(f)).ok).toBe(true)
  expect(await createMemoryReadService(pool,'revision-test').selectClaimVersion(f.personal,f.claim)).toBeNull()
  const result=await createSearchService({pool,recallEmbeddingTimeoutMs:500,cursorSigningKey:'revision-test'}).search({installationId:f.personal,query:'transactional fixture invariant'})
  expect(result.hits).toEqual([])
 })
 test('concurrent corrections accept exactly one revision token',async()=>{
  const f=await governanceFixture(pool),out=await Promise.all([correct(f),correct(f)])
  expect(out.filter(r=>r.ok)).toHaveLength(1);expect(out.filter(r=>!r.ok)).toMatchObject([{ok:false,error:{code:'revision_conflict'}}])
  const rows=(await pool.query('SELECT effective_from::text,effective_until::text FROM knowledge_versions WHERE claim_id=$1 ORDER BY version_number',[f.claim])).rows
  expect(rows).toHaveLength(2);expect(rows[0].effective_until).toBe(rows[1].effective_from)
 })
 test('failure after interval closure rolls back intervals, evidence, version and pointer',async()=>{
  const f=await governanceFixture(pool),before=(await pool.query('SELECT to_jsonb(v) doc FROM knowledge_versions v WHERE version_id=$1',[f.version])).rows[0].doc
  const hook=queryHookPool(pool,async text=>{if(text.includes('SET current_version_id = $2')&&text.includes('normalized_key'))throw new Error('injected pointer failure')})
  const episode=(await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1',[f.personal])).rows[0].episode_id
  await expect(createClaimRepository(hook).correctClaim({installationId:f.personal,claimId:f.claim,expectedRevision:1,statement:'rollback invariant',
   evidence:[{episodeId:episode,evidenceKind:'episode',locator:{},excerpt:'rollback',occurredAt:new Date()}]})).rejects.toThrow('injected pointer failure')
  const rows=(await pool.query('SELECT to_jsonb(v) doc FROM knowledge_versions v WHERE claim_id=$1',[f.claim])).rows
  expect(rows).toEqual([{doc:before}]);expect((await pool.query('SELECT current_version_id FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0].current_version_id).toBe(f.version)
 })
 test('closed current intervals deny Context without a generation write as time passes',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("UPDATE knowledge_versions SET effective_from=created_at,effective_until=clock_timestamp()-interval '1 microsecond' WHERE version_id=$1",[f.version])
  const fact=(await contextClaimFacts(pool,f.personal,[f.version])).get(f.version)!
  expect(fact.current).toBe(false);expect(eligibleContextFacts(fact,{repositoryId:null,repoSnapshotId:null,branch:null,taskScopeKey:null})).toBe(false)
 })
 test('future legacy source clocks are left for migration review',async()=>{
  const f=await governanceFixture(pool)
  await pool.query("UPDATE knowledge_versions SET created_at=clock_timestamp()+interval '1 day' WHERE version_id=$1",[f.version])
  expect(await correct(f)).toMatchObject({ok:false,error:{code:'revision_interval_requires_review'}})
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[f.claim])).rows[0].n).toBe(1)
 })
 test('real governed Git import closes revision time and preserves source fact clocks',async()=>{
  const s=await gitImportFixture(pool,['rule'],false,async f=>{
   await pool.query("UPDATE knowledge_versions SET valid_from='2020-01-01',valid_until='2099-01-01' WHERE version_id=$1",[f.rule.versionId])
  })
  await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
  const imports=createGitImportService({...s.deps,applicationMode:async()=>'enabled' as const}),{proposals:[p]}=await s.plan()
  const subject={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:p.proposalId,expectedRevision:'1'}
  await imports.review(s.f.skill.reviewer.grant,{...subject,decision:'approve'})
  expect(await imports.apply(s.f.skill.publisher.grant,subject)).toMatchObject({outcome:'published'})
  const rows=(await pool.query('SELECT effective_from::text,effective_until::text,valid_from::text,valid_until::text,freshness_at::text FROM knowledge_versions WHERE claim_id=$1 ORDER BY version_number',[s.f.rule.claimId])).rows
  expect(rows).toHaveLength(2);expect(rows[0].effective_from).not.toBeNull();expect(rows[0].effective_until).toBe(rows[1].effective_from);expect(rows[1].effective_until).toBeNull()
  expect(rows[0].valid_from).toBe(rows[1].valid_from);expect(rows[0].valid_until).toBe(rows[1].valid_until);expect(rows[0].freshness_at).toBe(rows[1].freshness_at)
  expect(await imports.apply(s.f.skill.publisher.grant,subject)).toMatchObject({outcome:'published'})
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE claim_id=$1',[s.f.rule.claimId])).rows[0].n).toBe(2)
 })
})
