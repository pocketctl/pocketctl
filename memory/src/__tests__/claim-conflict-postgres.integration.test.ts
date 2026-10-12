import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPromotionService} from '../governance/promotion-service.js'
import {createPublicationService} from '../governance/publication-service.js'
import {createCandidateDeduper} from '../extraction/deduper.js'
import {validateCandidate} from '../extraction/validator.js'
import {createPromotionRepository} from '../governance/promotion-repository.js'
import {createReviewPolicyRepository,DEFAULT_TEAM_REVIEW_POLICY} from '../governance/review-policy.js'
import Fastify from 'fastify'
import {registerGovernanceRoutes} from '../api/governance-routes.js'
import {revisionBundleHash} from '../governance/revision-bundle.js'
const url=process.env.MEMORY_TEST_DATABASE_URL,suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('authorized review-only conflict classification',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function fixture(){
  const f=await governanceFixture(pool)
  await pool.query("UPDATE knowledge_versions SET statement='Memory should enable caching' WHERE version_id=$1",[f.version])
  const approved=await f.approved(),publication=createPublicationService(pool)
  const incumbent=await publication.publish({grant:f.grant(f.publisher,['read','review','publish']),targetInstallationId:f.team,candidateId:approved.candidate.candidate_id,expectedCandidateRevision:approved.candidate.revision,resolution:'new'})
  const propose=(statement:string)=>{return pool.query('UPDATE knowledge_versions SET statement=$2 WHERE version_id=$1',[f.version,statement]).then(()=>createPromotionService(pool).propose({...f.proposeInput,idempotencyDigest:randomUUID()}))}
  return {...f,publication,incumbent,propose}
 }
 test('proposal fact clocks retain ISO compatibility and distinguish PostgreSQL microseconds',async()=>{
  const f=await governanceFixture(pool),publication=createPublicationService(pool)
  await pool.query("UPDATE knowledge_versions SET valid_from='2025-01-01T00:00:00.123456Z',valid_until='2030-01-01T00:00:00.654321Z' WHERE version_id=$1",[f.version])
  const initial=await f.approved()
  await publication.publish({grant:f.grant(f.publisher,['read','review','publish']),targetInstallationId:f.team,candidateId:initial.candidate.candidate_id,expectedCandidateRevision:initial.candidate.revision,resolution:'new'})
  await pool.query("UPDATE knowledge_versions SET valid_from='2025-01-01T00:00:00.123457Z' WHERE version_id=$1",[f.version])
  const p=await createPromotionService(pool).propose({...f.proposeInput,idempotencyDigest:randomUUID()})
  expect(p.candidateRevision.revision_bundle?.sourceValidFrom).toBe('2025-01-01T00:00:00.123457Z')
  expect(p.candidateRevision.revision_bundle?.sourceValidUntil).toBe('2030-01-01T00:00:00.654321Z')
  expect(p.classification).toBe('related');expect(p.candidate.state).toBe('conflict')
 })
 test('opposite shared statements are detected without a full-text equality match',async()=>{
  const f=await fixture(),p=await f.propose('Memory should disable caching')
  expect(p.classification).toBe('potential_conflict')
  expect(p.candidate.state).toBe('conflict')
  expect((p.candidateRevision.revision_bundle as any).relationships.items).toMatchObject([{claimId:f.incumbent.claimId,versionId:f.incumbent.versionId,relation:'potential_conflict'}])
 })
 test('supplementary shared wording produces a related hint and awaits normal review',async()=>{
  const f=await fixture(),p=await f.propose('Memory should enable caching and record cache hit metrics')
  expect(p.classification).toBe('related');expect(p.candidate.state).toBe('proposed')
  expect((p.candidateRevision.revision_bundle as any).relationships.items[0].relation).toBe('related')
 })
 test('publication rechecks current semantic conflicts and requires explicit resolution',async()=>{
  const f=await fixture(),p=await f.propose('Memory should disable caching')
  await f.publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:p.candidate.revision,decision:'approve'})
  await expect(f.publication.publish({grant:f.grant(f.publisher,['read','review','publish']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:p.candidate.revision,resolution:'new'})).rejects.toMatchObject({code:'invalid_resolution'})
  expect((await pool.query('SELECT state FROM knowledge_claims WHERE claim_id=$1',[f.incumbent.claimId])).rows[0].state).toBe('active')
 })
 test('supplementary personal candidates persist related references rather than conflict status',async()=>{
  const f=await governanceFixture(pool),identity={scopeKind:'installation' as const,scopeKey:'',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,status:'verified' as const,structuredContent:{},validFrom:null,validUntil:null}
  await pool.query("UPDATE knowledge_claims SET scope_key='global' WHERE claim_id=$1",[f.claim]);identity.scopeKey='global'
  const statement='Transactional fixture invariant and related source evidence',family=await createCandidateDeduper(pool).activeFamilyFor({installationId:f.personal,claimType:'test_invariant',scopeKey:'global',statement,identity})
  const verdict=validateCandidate({claimType:'test_invariant',statement,scopeKind:'installation',scopeKey:'global',repositoryId:null,repoSnapshotId:null,branch:null,validUntil:null,evidenceHandles:['h1'],normalizedKey:'fixture'},
    {manifestHandles:new Set(['h1']),episode:{turnId:'turn',repositoryId:null,repoSnapshotId:null,branch:null},now:new Date(),tombstonedKeys:new Set(),activeFamily:family.family,exactClaimId:family.exactClaimId})
  expect(verdict.status).toBe('validated');expect((verdict.validation as any).relationships).toMatchObject([{claimId:f.claim,versionId:f.version,relation:'related'}])
 })
 async function approve(f:Awaited<ReturnType<typeof fixture>>,p:Awaited<ReturnType<typeof f.propose>>){
  await f.publication.decide({grant:f.grant(f.reviewer,['read','review']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:p.candidate.revision,decision:'approve'})
  return {grant:f.grant(f.publisher,['read','review','publish']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedCandidateRevision:p.candidate.revision}
 }
 test('parallel explicitly preserves both semantically opposing active versions',async()=>{
  const f=await fixture(),p=await f.propose('Memory should disable caching'),request=await approve(f,p)
  const out=await f.publication.publish({...request,resolution:'parallel'})
  const rows=(await pool.query('SELECT state,conflict_group_id FROM knowledge_claims WHERE claim_id=ANY($1::uuid[])',[ [f.incumbent.claimId,out.claimId] ])).rows
  expect(rows).toHaveLength(2);expect(rows.every(row=>row.state==='active'&&row.conflict_group_id===out.conflictGroupId)).toBe(true)
  const visible=await createPromotionRepository(pool).listConflictClaims(f.team,p.candidate)
  expect(visible.map(c=>c.claim_id)).toContain(f.incumbent.claimId)
 })
 test('semantic hints cannot relax a policy that disables parallel publication',async()=>{
  const f=await fixture(),policies=createReviewPolicyRepository(pool)
  const head=(await pool.query('SELECT h.revision FROM memory_review_policy_heads h JOIN memory_review_policy_sets s USING(policy_id) WHERE s.installation_id=$1',[f.team])).rows[0]
  await policies.publishVersion({installationId:f.team,document:{...DEFAULT_TEAM_REVIEW_POLICY,allow_parallel_conflicts:false},createdByMembershipId:f.publisher,expectedRevision:Number(head.revision)})
  const p=await f.propose('Memory should disable caching'),request=await approve(f,p)
  await expect(f.publication.publish({...request,resolution:'parallel'})).rejects.toMatchObject({code:'invalid_resolution'})
  expect((await pool.query('SELECT state FROM knowledge_claims WHERE claim_id=$1',[f.incumbent.claimId])).rows[0].state).toBe('active')
 })
 test.each(['hold','future_revision','unknown_applicability'])('%s incumbents never provide consumption-grade suggestions',async change=>{
  const f=await fixture()
  if(change==='hold')await pool.query("UPDATE knowledge_claims SET consumption_hold_reason='requires_review' WHERE claim_id=$1",[f.incumbent.claimId])
  if(change==='future_revision')await pool.query("UPDATE knowledge_versions SET effective_from=clock_timestamp()+interval '1 day' WHERE version_id=$1",[f.incumbent.versionId])
  if(change==='unknown_applicability')await pool.query("UPDATE knowledge_versions SET applicability=jsonb_set(applicability,'{status}','\"requires_review\"') WHERE version_id=$1",[f.incumbent.versionId])
  const p=await f.propose('Memory should disable caching')
  expect(p.classification).toBe('new');expect((p.candidateRevision.revision_bundle as any).relationships.items).toEqual([])
 })
 test('contribute without read consent produces no target relationships',async()=>{
  const f=await fixture();await pool.query("UPDATE knowledge_versions SET statement='Memory should disable caching' WHERE version_id=$1",[f.version])
  const grant=f.grant(f.proposer,['contribute']),p=await createPromotionService(pool).propose({...f.proposeInput,grant,idempotencyDigest:randomUUID()})
  expect(p.classification).toBe('new');expect(p.candidateRevision.revision_bundle?.relationships).toBeUndefined()
 })
 test('same digest cannot replay saved target relationships after read consent is removed',async()=>{
  const f=await fixture();await pool.query("UPDATE knowledge_versions SET statement='Memory should disable caching' WHERE version_id=$1",[f.version])
  const svc=createPromotionService(pool),request={...f.proposeInput,idempotencyDigest:randomUUID()},p=await svc.propose(request)
  await expect(svc.propose({...request,grant:f.grant(f.proposer,['contribute'])})).rejects.toMatchObject({code:'not_found'})
  expect((await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[p.candidateRevision.candidate_revision_id])).rows[0].revision_bundle.relationships.items[0].claimId).toBe(f.incumbent.claimId)
 })
 test('HTTP idempotency replay also requires current read consent for saved hints',async()=>{
  const f=await fixture();await pool.query("UPDATE knowledge_versions SET statement='Memory should disable caching' WHERE version_id=$1",[f.version])
  let permissions=['read','contribute'];const app=Fastify()
  registerGovernanceRoutes(app,{pool,guard:{guardV2:async()=>({...f.grant(f.proposer,permissions),version:'v2',installationId:f.team,callerType:'web',services:['memory.search']})} as never,sharedScopesEnabled:true,cursorSigningKey:'classification-fixture'})
  const request={method:'POST' as const,url:'/api/v1/memory/governance/proposals',headers:{authorization:'Bearer fixture','idempotency-key':'current-read-replay'},payload:{expected_revision:1,target_installation_id:f.team,source_installation_id:f.personal,source_claim_id:f.claim,evidence_ids:[f.evidence]}}
  try{
   const first=await app.inject(request);expect(first.statusCode).toBe(201);expect(first.body).toContain(f.incumbent.claimId)
   permissions=['contribute'];const replay=await app.inject(request);expect(replay.statusCode).toBe(404);expect(replay.body).not.toContain(f.incumbent.claimId);expect(replay.body).not.toContain('relationships')
  }finally{await app.close()}
 })
 test('legacy HTTP conflict receipts still require read after a revision clears current conflict fields',async()=>{
  const f=await fixture();await pool.query("UPDATE knowledge_versions SET statement='Memory should disable caching' WHERE version_id=$1",[f.version])
  let permissions=['read','contribute'];const app=Fastify()
  registerGovernanceRoutes(app,{pool,guard:{guardV2:async()=>({...f.grant(f.proposer,permissions),version:'v2',installationId:f.team,callerType:'web',services:['memory.search']})} as never,sharedScopesEnabled:true,cursorSigningKey:'classification-fixture'})
  const request={method:'POST' as const,url:'/api/v1/memory/governance/proposals',headers:{authorization:'Bearer fixture','idempotency-key':'legacy-conflict-replay'},payload:{expected_revision:1,target_installation_id:f.team,source_installation_id:f.personal,source_claim_id:f.claim,evidence_ids:[f.evidence]}}
  try{
   const first=await app.inject(request);expect(first.statusCode).toBe(201);const p=first.json()
   // Recreate pre-classifier history: the receipt knows its classification, but no hint bundle exists.
   const bundle=p.candidate_revision.revision_bundle;delete bundle.relationships
   await pool.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=$2,revision_bundle_hash=$3 WHERE candidate_revision_id=$1',[p.candidate_revision.candidate_revision_id,JSON.stringify(bundle),revisionBundleHash(bundle)])
   await pool.query("UPDATE memory_idempotency_keys SET response_metadata=jsonb_set(response_metadata,'{classification}','\"conflict\"') WHERE installation_id=$1 AND operation='governance.propose'",[f.team])
   await createPromotionRepository(pool).appendRevision({grant:f.grant(f.proposer,['read','contribute']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedRevision:p.candidate.revision,statement:'Memory should enable caching and measure cache hits',structuredContent:{},createdByMembershipId:f.proposer,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}})
   const current=(await pool.query('SELECT conflict_group_id,duplicate_of_claim_id FROM memory_promotion_candidates WHERE candidate_id=$1',[p.candidate.candidate_id])).rows[0]
   expect(current).toEqual({conflict_group_id:null,duplicate_of_claim_id:null})
   permissions=['contribute'];const replay=await app.inject(request);expect(replay.statusCode).toBe(404);expect(replay.body).not.toContain('conflict')
  }finally{await app.close()}
 })
 test('immutable relationship hints replay exactly and are cleared on a new reviewed revision',async()=>{
  const f=await fixture();await pool.query("UPDATE knowledge_versions SET statement='Memory should disable caching' WHERE version_id=$1",[f.version])
  const svc=createPromotionService(pool),request={...f.proposeInput,idempotencyDigest:randomUUID()},p=await svc.propose(request),replay=await svc.propose(request)
  expect(replay.classification).toBe('potential_conflict');expect(replay.candidateRevision.revision_bundle?.relationships).toEqual(p.candidateRevision.revision_bundle?.relationships)
  await createPromotionRepository(pool).appendRevision({grant:f.grant(f.proposer,['read','contribute']),targetInstallationId:f.team,candidateId:p.candidate.candidate_id,expectedRevision:p.candidate.revision,statement:'Memory should enable caching and measure cache hits',structuredContent:{},createdByMembershipId:f.proposer,evidenceSelection:{retainedOrdinals:[1],removedOrdinals:[],newEvidenceIds:[]}})
  const versions=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_id=$1 ORDER BY revision_number',[p.candidate.candidate_id])).rows
  expect(versions[0].revision_bundle.relationships).toEqual(p.candidateRevision.revision_bundle?.relationships)
  expect(versions[1].revision_bundle.relationships).toBeUndefined()
 })
 test('concurrent opposing new publications serialize their empty topic and require resolution for the second',async()=>{
  const f=await fixture();await pool.query("UPDATE knowledge_claims SET state='expired' WHERE claim_id=$1",[f.incumbent.claimId])
  const p1=await f.propose('Memory should enable caching'),p2=await f.propose('Memory should disable caching'),r1=await approve(f,p1),r2=await approve(f,p2)
  const results=await Promise.allSettled([f.publication.publish({...r1,resolution:'new'}),f.publication.publish({...r2,resolution:'new'})])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'invalid_resolution'})
  expect((await pool.query("SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1 AND state='active'",[f.team])).rows[0].n).toBe(1)
 })
})
