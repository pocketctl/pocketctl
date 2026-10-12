import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,test,expect} from 'vitest'
import {confirmRepositoryApplicabilityFixture} from '../testing/governance-applicability-fixture.js'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPromotionRepository} from '../governance/promotion-repository.js'
import {createPublicationService} from '../governance/publication-service.js'
import {normalizedClaimKey} from '../retrieval/query-normalizer.js'
import {claimIdentityV2} from '../claims/identity.js'
import {createMemoryPool} from '../db.js'
import {assertMemoryRuntimeCompatibility} from '../migrations/governance-v2/compatibility.js'
import {insertKnowledgeTombstones} from '../claims/tombstones.js'
import {gitImportFixture} from '../testing/phase6-import-fixture.js'
import {createGitImportService} from '../git-sync/import-service.js'
import {randomUUID} from 'node:crypto'
import {changeMetadata} from '../testing/phase6-fixtures.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('current-head identity writers',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})
 test('edited proposal publication derives both aliases from the latest reviewed body',async()=>{
  const f=await governanceFixture(pool),p=await f.proposed(),statement='Renamed Transaction Invariant'
  await createPromotionRepository(pool).appendRevision({targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedRevision:1,statement,structuredContent:{},
   grant:f.proposeInput.grant,createdByMembershipId:f.proposer,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}})
  const service=createPublicationService(pool)
  await service.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:2,decision:'approve'})
  const result=await service.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:2,resolution:'new'})
  const row=(await pool.query('SELECT normalized_key,normalized_key_v2,topic_key_v2,duplicate_digest_v2,identity_generation FROM knowledge_claims WHERE claim_id=$1',[result.claimId])).rows[0]
  expect(row.normalized_key).toBe(normalizedClaimKey({claimType:'test_invariant',scopeKey:'',statement}))
  expect(row.normalized_key_v2).toBe(claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,snapshotId:null,branch:null,status:'verified',statement}).key)
  expect(row.topic_key_v2).toMatch(/^[a-f0-9]{64}$/);expect(row.duplicate_digest_v2).toMatch(/^[a-f0-9]{64}$/);expect(row.identity_generation).toBe(1)
 })
 test.each(['v1','v2'])('shared publication honors an old rotated %s privacy tombstone',async kind=>{
  const f=await governanceFixture(pool),p=await f.approved(),keys=[{version:'old',key:'old-publication-privacy-key'},{version:'new',key:'new-publication-privacy-key'}]
  const statement=p.candidateRevision.statement,key=claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,snapshotId:null,branch:null,status:'verified',statement}).key
  await insertKnowledgeTombstones(pool,{installationId:f.team,normalizedKeys:kind==='v1'?[normalizedClaimKey({claimType:'test_invariant',scopeKey:'',statement})]:[],normalizedKeysV2:kind==='v2'?[key]:[],keys:[keys[0]],reason:'privacy_delete'})
  await expect(createPublicationService(pool,{tombstoneHmacKeys:keys}).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})).rejects.toMatchObject({code:'state_conflict',details:{reason:'tombstoned_identity'}})
  expect((await pool.query('SELECT 1 FROM knowledge_claims WHERE installation_id=$1',[f.team])).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM memory_authority_records')).rowCount).toBe(0)
 })
 test('omitting a configured key version cannot bypass shared publication privacy',async()=>{
  const f=await governanceFixture(pool),p=await f.approved()
  await insertKnowledgeTombstones(pool,{installationId:f.team,normalizedKeys:['unrelated-protected-old-key'],keys:[{version:'old',key:'old-key'}],reason:'privacy_delete'})
  await expect(createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})).rejects.toMatchObject({details:{reason:'tombstone_hmac_keyring_incomplete'}})
 })
 test('adaptive producer writes generation two while retaining all staged indexes and protects old aliases',async()=>{
  const f=await governanceFixture(pool),runtime=createMemoryPool({databaseUrl:url!,dbPoolMax:4})
  try{
   await pool.query("INSERT INTO memory_governance_v2_states(installation_id,identity_generation,phase,writer_floor) VALUES($1,2,'active','identity_v2') ON CONFLICT(installation_id) DO UPDATE SET identity_generation=2,phase='active',writer_floor='identity_v2'",[f.team])
   await assertMemoryRuntimeCompatibility(runtime)
   const p=await (await import('../governance/promotion-service.js')).createPromotionService(runtime).propose(f.proposeInput)
   const publication=createPublicationService(runtime)
   await publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
   const result=await publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
   const row=(await pool.query('SELECT * FROM knowledge_claims WHERE claim_id=$1',[result.claimId])).rows[0]
   expect(row.identity_generation).toBe(2);expect(row.normalized_key_v2).toMatch(/^[a-f0-9]{64}$/);expect(row.duplicate_digest_v2).toMatch(/^[a-f0-9]{64}$/)
   expect((await pool.query("SELECT to_regclass('knowledge_claims_active_identity_variant_idx') IS NOT NULL AS kept")).rows[0].kept).toBe(true)
   await assertMemoryRuntimeCompatibility(runtime)
   const bridge=new pg.Pool({connectionString:url,options:'-c pocketctl.writer_capability=bridge_v2 -c pocketctl.writer_identity_generation=1'})
   try{await expect(bridge.query('UPDATE knowledge_versions SET confidence=0.8 WHERE version_id=$1',[result.versionId])).rejects.toMatchObject({code:'55000'})}finally{await bridge.end()}
   await pool.query("UPDATE knowledge_versions SET valid_from='2025-01-01' WHERE version_id=$1",[f.version])
   const second=await (await import('../governance/promotion-service.js')).createPromotionService(runtime).propose({...f.proposeInput,idempotencyDigest:randomUUID()})
   expect(second.classification).toBe('related')
   expect(second.candidate.state).toBe('conflict') // Same identity still requires explicit publication resolution.
   await createPromotionRepository(runtime).appendRevision({targetInstallationId:f.team,candidateId:second.candidate.candidate_id,expectedRevision:1,statement:second.candidateRevision.statement,structuredContent:second.candidateRevision.structured_content,grant:f.proposeInput.grant,createdByMembershipId:f.proposer,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}})
   await publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:second.candidate.candidate_id,expectedCandidateRevision:2,decision:'approve'})
   await expect(publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:second.candidate.candidate_id,expectedCandidateRevision:2,resolution:'new'})).rejects.toMatchObject({code:'invalid_resolution'})
   // Internal whitespace is exact v2 content while the retained v1
   // normalization loses that distinction. Report its actual barrier.
   await pool.query("UPDATE knowledge_versions SET statement=replace(statement,' ','  ') WHERE version_id=$1",[f.version])
   const third=await (await import('../governance/promotion-service.js')).createPromotionService(runtime).propose({...f.proposeInput,idempotencyDigest:randomUUID()})
   expect(third.classification).toBe('related') // Topic similarity cannot certify exact v2 equality.
   await publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:third.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
   await expect(publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:third.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})).rejects.toMatchObject({code:'state_conflict',details:{reason:'identity_migration_required'}})

  }finally{await runtime.end()}
 })
 test.each(['claim','rule'] as const)('real Git %s content edit updates current aliases and full duplicate projection',async kind=>{
  const s=await gitImportFixture(pool,[kind],false,async f=>{
   const claim=f.keys.find(key=>key.kind===kind)!
   await pool.query('UPDATE knowledge_versions SET repo_snapshot_id=NULL,branch=NULL WHERE claim_id=$1',[claim.id])
   await confirmRepositoryApplicabilityFixture(pool,f.installationId,claim.id,[])
  })
  await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
  const files=s.bundle.files.map(file=>file.path.endsWith('/manifest.yaml')?file:changeMetadata([file],v=>{if(v.key?.kind===kind)v.editable.statement='Governed renamed invariant'})[0])
  const {proposals:[p]}=await s.plan(files),service=createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const})
  const request={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:p.proposalId,expectedRevision:'1'}
  await service.review(s.f.skill.reviewer.grant,{...request,decision:'approve'})
  const result=await service.apply(s.f.skill.publisher.grant,request)
  const row=(await pool.query('SELECT c.*,v.statement FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.version_id=c.current_version_id WHERE c.current_version_id=$1',[result.versionId])).rows[0]
  expect(row.normalized_key).toBe(normalizedClaimKey({claimType:row.claim_type,scopeKey:row.scope_key,statement:row.statement}))
  expect(row.normalized_key_v2).toMatch(/^[a-f0-9]{64}$/);expect(row.topic_key_v2).toMatch(/^[a-f0-9]{64}$/);expect(row.duplicate_digest_v2).toMatch(/^[a-f0-9]{64}$/)
 })
 test('a legacy writer changing the current body cannot hide stale shadows from new identity admission',async()=>{
  const f=await governanceFixture(pool),p=await f.approved(),publication=createPublicationService(pool)
  const existing=await publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
  const statement='A body changed by a retained legacy producer'
  await pool.query('UPDATE knowledge_versions SET statement=$2 WHERE version_id=ANY($1::uuid[])',[[existing.versionId,f.version],statement])
  const next=await (await import('../governance/promotion-service.js')).createPromotionService(pool).propose({...f.proposeInput,idempotencyDigest:randomUUID()})
  expect(next.classification).toBe('new') // stale mirrors cannot certify duplicate equivalence
  await publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:next.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
  await expect(publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:next.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})).rejects.toMatchObject({code:'state_conflict',details:{reason:'identity_requires_review'}})
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_claims WHERE installation_id=$1',[f.team])).rows[0].n).toBe(1)
 })
 test('the staged v2 unique index serializes concurrent identical facts independently of the retained v1 index',async()=>{
  const f=await governanceFixture(pool),runtime=createMemoryPool({databaseUrl:url!,dbPoolMax:3})
  await pool.query("INSERT INTO memory_governance_v2_states(installation_id,identity_generation,phase,writer_floor) VALUES($1,2,'active','identity_v2')",[f.team])
  const first=await runtime.connect(),second=await runtime.connect(),claim=randomUUID(),version=randomUUID()
  const {projectClaimIdentity}=await import('../claims/identity-writer.js')
  try{
   await first.query('BEGIN');await second.query('BEGIN')
   const projection=await projectClaimIdentity(first,{installationId:f.team,claimType:'test_invariant',statement:'Exact concurrency invariant',structuredContent:{},
    applicability:{scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,status:'verified'},validFrom:null,validUntil:null})
   const sql="INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2,state) VALUES($1,$2,'test_invariant','installation','',$3,2,$4,$5,$6,'active')"
   await first.query(sql,[claim,f.team,'old-alias-a',projection.keyV2,projection.topicKeyV2,projection.duplicateDigestV2])
   await first.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence) VALUES($1,$2,$3,1,'Exact concurrency invariant','team_published',0.9)",[version,f.team,claim])
   await first.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claim,version])
   let settled=false
   const competing=second.query(sql,[randomUUID(),f.team,'old-alias-b',projection.keyV2,projection.topicKeyV2,projection.duplicateDigestV2]).then(()=>null,error=>error).finally(()=>{settled=true})
   await new Promise(resolve=>setTimeout(resolve,100))
   expect(settled).toBe(false)
   await first.query('COMMIT')
   expect(await competing).toMatchObject({code:'23505',constraint:'knowledge_claims_active_identity_v2_idx'})
   await second.query('ROLLBACK')
   expect((await pool.query("SELECT to_regclass('knowledge_claims_active_identity_variant_idx') IS NOT NULL AS kept")).rows[0].kept).toBe(true)
  }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();await runtime.end()}
 })
 test('runtime refuses a correctly named but incorrectly defined identity index',async()=>{
  const runtime=createMemoryPool({databaseUrl:url!,dbPoolMax:2})
  try{
   await pool.query('BEGIN')
   await pool.query('DROP INDEX knowledge_claims_active_identity_v2_idx')
   await pool.query('CREATE UNIQUE INDEX knowledge_claims_active_identity_v2_idx ON knowledge_claims(claim_id)')
   await pool.query('COMMIT')
   await expect(assertMemoryRuntimeCompatibility(runtime)).rejects.toThrow('identity_generation')
  }finally{
   await pool.query('ROLLBACK')
   await pool.query('DROP INDEX knowledge_claims_active_identity_v2_idx')
   await pool.query("CREATE UNIQUE INDEX knowledge_claims_active_identity_v2_idx ON knowledge_claims(installation_id,duplicate_digest_v2,conflict_variant) WHERE state='active' AND identity_generation=2")
   await runtime.end()
  }
 })
})
