import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {createHash,randomUUID} from 'node:crypto'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPromotionRepository} from '../governance/promotion-repository.js'
import {createPublicationService} from '../governance/publication-service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('immutable revision evidence bundle',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 async function setup(){
  const f=await governanceFixture(pool),proposal=await f.proposed(),repository=createPromotionRepository(pool)
  const edit={targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedRevision:1,
   statement:'Revised transaction invariant',structuredContent:{checks:['authorization']},contentHash:'caller-must-not-control-hash',createdByMembershipId:f.proposer,
   evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]},grant:f.proposeInput.grant}
  return{f,proposal,repository,edit}
 }
 test('edit carries explicitly retained evidence into an immutable new bundle',async()=>{
  const {f,proposal,repository,edit}=await setup()
  const result=await repository.appendRevision(edit)
  const old=await repository.getLatestRevision(proposal.candidate.candidate_id)
  expect((await repository.listEvidence(result.candidateRevisionId))).toHaveLength(1)
  expect(old?.content_hash).toBe(createHash('sha256').update(edit.statement).digest('hex'))
  const row=(await pool.query('SELECT revision_bundle,revision_bundle_hash FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[result.candidateRevisionId])).rows[0]
  expect(row.revision_bundle.statement).toBe(edit.statement)
  expect(row.revision_bundle.evidence).toHaveLength(1)
  expect(row.revision_bundle_hash).toMatch(/^[a-f0-9]{64}$/)
  const first=(await pool.query('SELECT statement,revision_bundle_hash FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])).rows[0]
  expect(first.statement).toBe('Transactional fixture invariant')
  expect(first.revision_bundle_hash).not.toBe(row.revision_bundle_hash)
  expect(JSON.stringify(row.revision_bundle)).not.toContain(f.evidence)
 })
 test('missing, empty or ambiguous evidence selection cannot create a revision',async()=>{
  const {repository,edit}=await setup()
  for(const selection of [undefined,{retainedOrdinals:[],removedOrdinals:[1],newEvidenceIds:[]},{retainedOrdinals:[1],removedOrdinals:[1],newEvidenceIds:[]}]){
   await expect(repository.appendRevision({...edit,evidenceSelection:selection} as never)).rejects.toThrow(/evidence/)
  }
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidate_versions')).rows[0].n).toBe(1)
 })
 test('new evidence is checked against source ownership and re-redacted',async()=>{
  const {f,repository,edit}=await setup(),id=randomUUID(),episode=(await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1',[f.personal])).rows[0].episode_id
  const excerpt='The invariant is demonstrated; token=private-secret-value'
  await pool.query(`INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at)
   VALUES($1,$2,$3,$4,2,'episode',$5,$6,NOW())`,[id,f.personal,f.version,episode,excerpt,createHash('sha256').update(excerpt).digest()])
  await expect(repository.appendRevision({...edit,evidenceSelection:{retainedOrdinals:[],removedOrdinals:[1],newEvidenceIds:[randomUUID()]}} as never)).rejects.toThrow(/evidence/)
  const result=await repository.appendRevision({...edit,evidenceSelection:{retainedOrdinals:[],removedOrdinals:[1],newEvidenceIds:[id]}} as never)
  const evidence=await repository.listEvidence(result.candidateRevisionId)
  expect(evidence).toHaveLength(1);expect(evidence[0].excerpt).toContain('[redacted]');expect(evidence[0].excerpt).not.toContain('private-secret-value')
 })
 test('tampered bundle or copied evidence cannot acquire review authority',async()=>{
  const {f,proposal}=await setup(),publication=createPublicationService(pool)
  await pool.query("UPDATE memory_promotion_evidence SET excerpt='Substituted evidence' WHERE candidate_revision_id=$1",[proposal.candidateRevision.candidate_revision_id])
  await expect(publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})).rejects.toMatchObject({code:'state_conflict'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_review_decisions')).rows[0].n).toBe(0)
 })
 test.each(['evidence','applicability'])('edit cannot re-sign corrupted predecessor %s',async(kind)=>{
  const {proposal,repository,edit}=await setup()
  if(kind==='evidence')await pool.query("UPDATE memory_promotion_evidence SET excerpt='Corrupted predecessor' WHERE candidate_revision_id=$1",[proposal.candidateRevision.candidate_revision_id])
  else await pool.query("UPDATE memory_promotion_candidate_versions SET revision_bundle=jsonb_set(revision_bundle,'{applicability,scopeKey}',to_jsonb('broadened'::text)) WHERE candidate_revision_id=$1",[proposal.candidateRevision.candidate_revision_id])
  await expect(repository.appendRevision(edit)).rejects.toThrow(/integrity/)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidate_versions')).rows[0].n).toBe(1)
 })
 test('explicit legacy repair creates a new bundle while preserving the old null revision',async()=>{
  const {f,proposal,repository,edit}=await setup()
  await pool.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=NULL,revision_bundle_hash=NULL WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])
  await expect(repository.appendRevision(edit)).rejects.toThrow(/explicit remediation/)
  const result=await repository.appendRevision({...edit,repairLegacyBundle:true} as never)
  const next=(await pool.query('SELECT revision_bundle,revision_bundle_hash FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[result.candidateRevisionId])).rows[0]
  expect(next.revision_bundle.statement).toBe(edit.statement)
  expect(next.revision_bundle.sourceContentHash).toBe(proposal.candidate.source_content_hash)
  expect(next.revision_bundle.evidence).toHaveLength(1)
  expect(JSON.stringify(next.revision_bundle)).not.toContain(f.evidence)
  expect((await pool.query('SELECT revision_bundle,revision_bundle_hash FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])).rows[0]).toEqual({revision_bundle:null,revision_bundle_hash:null})
 })
 test('legacy revision missing evidence can be repaired only with explicit new owned evidence',async()=>{
  const {f,proposal,repository,edit}=await setup()
  await pool.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=NULL,revision_bundle_hash=NULL WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])
  await pool.query('DELETE FROM memory_promotion_evidence WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])
  const result=await repository.appendRevision({...edit,repairLegacyBundle:true,evidenceSelection:{retainedOrdinals:[],removedOrdinals:[],newEvidenceIds:[f.evidence]}} as never)
  expect(await repository.listEvidence(result.candidateRevisionId)).toHaveLength(1)
  expect(await repository.listEvidence(proposal.candidateRevision.candidate_revision_id)).toHaveLength(0)
 })
 test.each(['source_permission','source_changed','evidence_changed'])('legacy repair refuses unproven %s',async(reason)=>{
  const {f,proposal,repository,edit}=await setup()
  await pool.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=NULL,revision_bundle_hash=NULL WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])
  const grant=structuredClone(edit.grant)
  if(reason==='source_permission')grant.scopeBindings=grant.scopeBindings.filter(b=>b.installation_id!==f.personal)
  else if(reason==='source_changed')await pool.query("UPDATE knowledge_versions SET statement='Source changed after the proposal' WHERE version_id=$1",[f.version])
  else await pool.query("UPDATE memory_promotion_evidence SET excerpt='Tampered legacy copy' WHERE candidate_revision_id=$1",[proposal.candidateRevision.candidate_revision_id])
  await expect(repository.appendRevision({...edit,grant,repairLegacyBundle:true} as never)).rejects.toThrow(/source|integrity/)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidate_versions')).rows[0].n).toBe(1)
 })
 test.each(['legacy','v2'])('a %s revision cannot re-add corrupted source evidence under its old hash',async(kind)=>{
  const {f,proposal,repository,edit}=await setup()
  if(kind==='legacy')await pool.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=NULL,revision_bundle_hash=NULL WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])
  await pool.query("UPDATE knowledge_evidence SET excerpt='Corrupt raw evidence under unchanged hash' WHERE evidence_id=$1",[f.evidence])
  await expect(repository.appendRevision({...edit,repairLegacyBundle:kind==='legacy',evidenceSelection:{retainedOrdinals:[],removedOrdinals:[1],newEvidenceIds:[f.evidence]}} as never)).rejects.toThrow(/integrity/)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidate_versions')).rows[0].n).toBe(1)
 })
 test('approval on previous revision cannot authorize the edited bundle',async()=>{
  const {f,proposal,repository,edit}=await setup(),publication=createPublicationService(pool)
  await publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
  await repository.appendRevision(edit)
  await expect(publication.publish({grant:f.grant(f.publisher,['read','review','publish']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:2,resolution:'new'})).rejects.toMatchObject({code:'quorum_failed'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_authority_records')).rows[0].n).toBe(0)
 })
 test('time-only revision freezes new metadata, requires new votes and publishes the reviewed times',async()=>{
  const {f,proposal,repository,edit}=await setup(),publication=createPublicationService(pool)
  await publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:edit.candidateId,expectedCandidateRevision:1,decision:'approve'})
  const metadataPatch={sourceValidFrom:'2025-01-01T00:00:00Z',sourceValidUntil:'2030-01-01T00:00:00Z'}
  const next=await repository.appendRevision({...edit,statement:proposal.candidateRevision.statement,structuredContent:proposal.candidateRevision.structured_content,metadataPatch} as never)
  const bundle=(await repository.getLatestRevision(edit.candidateId))!.revision_bundle!
  expect(bundle.sourceValidFrom).toBe('2025-01-01T00:00:00.000Z')
  expect(bundle.sourceValidUntil).toBe('2030-01-01T00:00:00.000Z')
  await expect(publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:edit.candidateId,expectedCandidateRevision:2,resolution:'new'})).rejects.toMatchObject({code:'quorum_failed'})
  await publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:edit.candidateId,expectedCandidateRevision:2,decision:'approve'})
  const published=await publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:edit.candidateId,expectedCandidateRevision:2,resolution:'new'})
  const row=(await pool.query('SELECT valid_from,valid_until,freshness_at FROM knowledge_versions WHERE version_id=$1',[published.versionId])).rows[0]
  expect(row.valid_from.toISOString()).toBe(bundle.sourceValidFrom);expect(row.valid_until.toISOString()).toBe(bundle.sourceValidUntil)
  expect(row.freshness_at.toISOString()).toBe(bundle.sourceFreshnessAt)
  expect(next.candidateRevisionId).not.toBe(proposal.candidateRevision.candidate_revision_id)
  expect((await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle.sourceValidFrom).toBeNull()
 })
 test('explicit source refresh captures applicability and freshness only in a new revision',async()=>{
  const {f,proposal,repository,edit}=await setup()
  const app={scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,status:'requires_review'}
  await pool.query("UPDATE knowledge_versions SET applicability=$2,freshness_at='2025-02-01' WHERE version_id=$1",[f.version,app])
  await repository.appendRevision({...edit,refreshSourceMetadata:true} as never)
  const bundle=(await repository.getLatestRevision(edit.candidateId))!.revision_bundle!
  expect(bundle.applicability).toEqual(app);expect(bundle.sourceFreshnessAt).toBe('2025-02-01T00:00:00.000Z')
  const old=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
  expect(old.applicability.status).toBe('verified');expect(old.sourceFreshnessAt).not.toBe(bundle.sourceFreshnessAt)
 })
 test('applicability-only revision updates the exact snapshot proof before target mapping',async()=>{
  const f=await governanceFixture(pool),sourceRepo=randomUUID(),targetRepo=randomUUID(),sourceA=randomUUID(),sourceB=randomUUID(),targetA=randomUUID(),targetB=randomUUID()
  for(const [installation,id,key] of [[f.personal,sourceRepo,'source'],[f.team,targetRepo,'target']])await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at)
   VALUES($1,$2,$3,'https://github.com/Acme/Repo.git',NOW(),NOW())`,[installation,id,key])
  for(const [installation,repository,id,commit] of [[f.personal,sourceRepo,sourceA,'a'],[f.personal,sourceRepo,sourceB,'b'],[f.team,targetRepo,targetA,'a'],[f.team,targetRepo,targetB,'b']])await pool.query(`INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())`,[installation,repository,id,commit.repeat(40)])
  const app={scopeKind:'snapshot',scopeKey:sourceA,canonicalRepositoryKey:'github.com/Acme/Repo',repositoryId:sourceRepo,snapshotId:sourceA,branch:'main',status:'verified'}
  await pool.query('UPDATE knowledge_claims SET scope_kind=$2,scope_key=$3,canonical_repository_key=$4 WHERE claim_id=$1',[f.claim,app.scopeKind,app.scopeKey,app.canonicalRepositoryKey])
  await pool.query("UPDATE knowledge_versions SET repository_id=$2,repo_snapshot_id=$3,branch='main',applicability=$4 WHERE version_id=$1",[f.version,sourceRepo,sourceA,app])
  const proposal=await f.proposed(),nextApp={...app,scopeKey:sourceB,snapshotId:sourceB}
  await pool.query('UPDATE knowledge_claims SET scope_key=$2 WHERE claim_id=$1',[f.claim,sourceB])
  await pool.query('UPDATE knowledge_versions SET repo_snapshot_id=$2,applicability=$3 WHERE version_id=$1',[f.version,sourceB,nextApp])
  const repository=createPromotionRepository(pool)
  await repository.appendRevision({targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedRevision:1,statement:proposal.candidateRevision.statement,
   structuredContent:{},createdByMembershipId:f.proposer,grant:f.proposeInput.grant,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]},metadataPatch:{applicability:nextApp}} as never)
  const bundle=(await repository.getLatestRevision(proposal.candidate.candidate_id))!.revision_bundle!
  expect(bundle.sourceSnapshotCommitSha).toBe('b'.repeat(40));expect(bundle.sourceRepositoryKey).toBe('source')
  const publication=createPublicationService(pool)
  await publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:2,decision:'approve'})
  const result=await publication.publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:2,resolution:'new'})
  expect((await pool.query('SELECT repo_snapshot_id FROM knowledge_versions WHERE version_id=$1',[result.versionId])).rows[0].repo_snapshot_id).toBe(targetB)
  const old=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
  expect(old.sourceSnapshotCommitSha).toBe('a'.repeat(40));expect(old.applicability.snapshotId).toBe(sourceA)
 })
 test.each(['permission','foreign_repository','invalid_time','forged_policy','forged_freshness'])('metadata editing rejects %s without appending',async reason=>{
  const {f,repository,edit}=await setup(),grant=structuredClone(edit.grant)
  if(reason==='permission')grant.scopeBindings=grant.scopeBindings.filter(b=>b.installation_id!==f.personal)
  const metadataPatch=reason==='foreign_repository'?{applicability:{scopeKind:'repository',scopeKey:randomUUID(),repositoryId:randomUUID(),snapshotId:null,canonicalRepositoryKey:'github.com/Acme/Other',branch:null,status:'verified'}}
   :reason==='invalid_time'?{sourceValidFrom:'2030-01-01T00:00:00Z',sourceValidUntil:'2025-01-01T00:00:00Z'}
   :reason==='forged_policy'?{originPolicyHash:'a'.repeat(64)}:reason==='forged_freshness'?{sourceFreshnessAt:'2027-01-01T00:00:00Z'}:{sourceValidFrom:null}
  await expect(repository.appendRevision({...edit,grant,metadataPatch} as never)).rejects.toThrow(/metadata|source|time|authorization/)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_promotion_candidate_versions')).rows[0].n).toBe(1)
 })
})
