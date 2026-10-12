import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createSearchService} from '../retrieval/search-service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('shared applicability capture and consumption (dedicated PostgreSQL)',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 test.each(['verified','legacy_unknown','requires_review'])('proposal captures explicit source %s applicability without guessing or changing source times',async status=>{
  const f=await governanceFixture(pool)
  const app={scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,status}
  await pool.query("UPDATE knowledge_versions SET applicability=$2,valid_from='2025-01-01',valid_until='2030-01-01',freshness_at='2025-02-01' WHERE version_id=$1",[f.version,app])
  const proposal=await f.proposed()
  const bundle=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
  expect(bundle.applicability).toEqual(app)
  expect(bundle.sourceValidFrom).toBe('2025-01-01T00:00:00.000Z')
  expect(bundle.sourceValidUntil).toBe('2030-01-01T00:00:00.000Z')
  expect(bundle.sourceFreshnessAt).toBe('2025-02-01T00:00:00.000Z')
 })
 test.each(['repository','snapshot','branch','task'] as const)('actual %s source capture/search requires matching applicability context',async scopeKind=>{
  const f=await governanceFixture(pool),repo=randomUUID(),snapshot=randomUUID(),canonical='github.com/Acme/Repo'
  await pool.query('INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,$3,$4,NOW(),NOW())',[f.personal,repo,canonical,'https://'+canonical+'.git'])
  await pool.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())",[f.personal,repo,snapshot,'a'.repeat(40)])
  const scoped=scopeKind!=='task',scopeKey=scopeKind==='repository'?repo:scopeKind==='snapshot'?snapshot:scopeKind==='branch'?'main':'turn-a'
  const app={scopeKind,scopeKey,canonicalRepositoryKey:scoped?canonical:null,repositoryId:scoped?repo:null,snapshotId:scoped?snapshot:null,branch:scoped?'main':null,status:'verified'}
  await pool.query('UPDATE knowledge_claims SET scope_kind=$2,scope_key=$3,canonical_repository_key=$4 WHERE claim_id=$1',[f.claim,scopeKind,scopeKey,app.canonicalRepositoryKey])
  await pool.query('UPDATE knowledge_versions SET repository_id=$2,repo_snapshot_id=$3,branch=$4,applicability=$5 WHERE version_id=$1',[f.version,app.repositoryId,app.snapshotId,app.branch,app])
  const proposed=await f.proposed()
  expect((await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposed.candidateRevision.candidate_revision_id])).rows[0].revision_bundle.applicability).toEqual(app)
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:50,cursorSigningKey:'scoped-applicability'}),input={installationId:f.personal,query:'invariant',...(scoped?{repositoryId:repo}:{}),...(scopeKind==='snapshot'?{repoSnapshotId:snapshot}:{}),...(scopeKind==='branch'?{branch:'main'}:{}),...(scopeKind==='task'?{taskScopeKey:'turn-a'}:{})}
  expect((await search.search(input)).hits.map(hit=>hit.claimId)).toEqual([f.claim])
  expect((await search.search({installationId:f.personal,query:'invariant'})).hits).toEqual([])
  if(scopeKind==='branch')expect((await search.search({...input,branch:'Main'})).hits).toEqual([])
  if(scopeKind==='task')expect((await search.search({...input,taskScopeKey:'turn-b'})).hits).toEqual([])
 })
 test.each(['identity_requires_review','repository_mapping_missing'])('actual SQL search cannot consume a %s held claim',async reason=>{
  const f=await governanceFixture(pool)
  await pool.query('UPDATE knowledge_claims SET consumption_hold_reason=$2 WHERE claim_id=$1',[f.claim,reason])
  const result=await createSearchService({pool,recallEmbeddingTimeoutMs:50,cursorSigningKey:'isolated-applicability'}).search({installationId:f.personal,query:'invariant'})
  expect(result.hits).toEqual([])
 })
 test.each(['repository','installation'])('%s applicability is not narrowed by snapshot/branch provenance',async scopeKind=>{
  const f=await governanceFixture(pool),repo=randomUUID(),snapshot=randomUUID(),otherSnapshot=randomUUID()
  const app={scopeKind,scopeKey:scopeKind==='repository'?repo:'',canonicalRepositoryKey:'github.com/Acme/Repo',repositoryId:repo,snapshotId:snapshot,branch:'old-branch',status:'verified'}
  await pool.query("INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,$2::uuid::text,'https://github.com/Acme/Repo.git',NOW(),NOW())",[f.personal,repo])
  for(const [id,commit] of [[snapshot,'a'.repeat(40)],[otherSnapshot,'b'.repeat(40)]])await pool.query('INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,observed_at) VALUES($1,$2,$3,$4,NOW())',[f.personal,repo,id,commit])
  await pool.query('UPDATE knowledge_claims SET scope_kind=$2,scope_key=$3,canonical_repository_key=$4 WHERE claim_id=$1',[f.claim,scopeKind,app.scopeKey,app.canonicalRepositoryKey])
  await pool.query('UPDATE knowledge_versions SET repository_id=$2,repo_snapshot_id=$3,branch=$4,applicability=$5 WHERE version_id=$1',[f.version,repo,snapshot,app.branch,app])
  const hits=(await createSearchService({pool,recallEmbeddingTimeoutMs:50,cursorSigningKey:'provenance-scope'}).search({installationId:f.personal,query:'invariant',repositoryId:repo,repoSnapshotId:otherSnapshot,branch:'new-branch'})).hits
  expect(hits.map(h=>h.claimId)).toEqual([f.claim])
 })
 test.each(['legacy_unknown','requires_review'])('actual SQL search excludes explicit %s metadata',async status=>{
  const f=await governanceFixture(pool)
  await pool.query('UPDATE knowledge_versions SET applicability=$2 WHERE version_id=$1',[f.version,{scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,status}])
  expect((await createSearchService({pool,recallEmbeddingTimeoutMs:50,cursorSigningKey:'isolated-applicability'}).search({installationId:f.personal,query:'invariant'})).hits).toEqual([])
 })
})
