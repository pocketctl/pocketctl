import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {createPromotionService} from '../governance/promotion-service.js'
import {createPublicationService} from '../governance/publication-service.js'
import {createSearchService} from '../retrieval/search-service.js'
import {publicationApplicability} from '../governance/publication-applicability.js'
import {createSourceRepository} from '../codegraph/source-repository.js'
import {gitImportFixture} from '../testing/phase6-import-fixture.js'
import {createGitImportService} from '../git-sync/import-service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('cross-scope publication applicability projection',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function repo(installation:string,key:string,canonical='github.com/Acme/Repo',commit='a'.repeat(40)){
  const repositoryId=randomUUID(),snapshotId=randomUUID()
  await pool.query('INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,$3,$4,NOW(),NOW())',[installation,repositoryId,key,'https://'+canonical+'.git'])
  await pool.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())",[installation,repositoryId,snapshotId,commit])
  return{repositoryId,snapshotId}
 }
 async function fixture(scopeKind:'installation'|'repository'|'snapshot'|'branch'|'task',mode='matched'){
  const f=await governanceFixture(pool),source=await repo(f.personal,'source-cwd')
  const target=mode==='missing'?null:await repo(f.team,'target-cwd','github.com/Acme/Repo',mode==='wrong_commit'?'b'.repeat(40):'a'.repeat(40))
  if(mode==='ambiguous')await repo(f.team,'another-target-cwd')
  const scoped=!['installation','task'].includes(scopeKind),scopeKey=scopeKind==='repository'?source.repositoryId:scopeKind==='snapshot'?source.snapshotId:scopeKind==='branch'?'main':scopeKind==='task'?'personal-turn':''
  const app={scopeKind,scopeKey,canonicalRepositoryKey:scoped?'github.com/Acme/Repo':null,repositoryId:scoped?source.repositoryId:null,snapshotId:scoped?source.snapshotId:null,branch:scoped?'main':null,status:'verified'}
  await pool.query('UPDATE knowledge_claims SET scope_kind=$2,scope_key=$3,canonical_repository_key=$4 WHERE claim_id=$1',[f.claim,scopeKind,scopeKey,app.canonicalRepositoryKey])
  await pool.query("UPDATE knowledge_versions SET repository_id=$2,repo_snapshot_id=$3,branch=$4,applicability=$5,valid_from='2025-01-01',valid_until='2030-01-01',freshness_at='2025-02-01' WHERE version_id=$1",[f.version,app.repositoryId,app.snapshotId,app.branch,app])
  const proposal=await f.approved(),publisher=f.grant(f.publisher,['read','publish'])
  publisher.scopeBindings=publisher.scopeBindings.filter(b=>b.installation_id===f.team)
  const publish=()=>createPublicationService(pool).publish({grant:publisher,targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
  return{...f,source,target,app,proposal,publish}
 }
 test.each(['installation','repository','snapshot','branch'] as const)('%s publication preserves fact/source time and uses only target-local FKs',async scopeKind=>{
  const f=await fixture(scopeKind),result=await f.publish()
  const row=(await pool.query('SELECT c.scope_kind,c.scope_key,c.canonical_repository_key,c.consumption_hold_reason,v.repository_id,v.repo_snapshot_id,v.branch,v.valid_from,v.valid_until,v.freshness_at,v.applicability FROM knowledge_claims c JOIN knowledge_versions v ON v.version_id=c.current_version_id WHERE c.claim_id=$1',[result.claimId])).rows[0]
  const scoped=scopeKind!=='installation',scopeKey=scopeKind==='repository'?f.target!.repositoryId:scopeKind==='snapshot'?f.target!.snapshotId:scopeKind==='branch'?'main':''
  expect(row).toMatchObject({scope_kind:scopeKind,scope_key:scopeKey,canonical_repository_key:f.app.canonicalRepositoryKey,consumption_hold_reason:null,repository_id:scoped?f.target!.repositoryId:null,repo_snapshot_id:scoped?f.target!.snapshotId:null,branch:f.app.branch})
  expect(row.applicability).toEqual({...f.app,scopeKey,repositoryId:scoped?f.target!.repositoryId:null,snapshotId:scoped?f.target!.snapshotId:null})
  expect(row.valid_from.toISOString()).toBe('2025-01-01T00:00:00.000Z');expect(row.valid_until.toISOString()).toBe('2030-01-01T00:00:00.000Z');expect(row.freshness_at.toISOString()).toBe('2025-02-01T00:00:00.000Z')
  const input={installationId:f.team,query:'invariant',...(scoped?{repositoryId:f.target!.repositoryId}:{}),...(scopeKind==='snapshot'?{repoSnapshotId:f.target!.snapshotId}:{}),...(scopeKind==='branch'?{branch:'main'}:{})}
  expect((await createSearchService({pool,recallEmbeddingTimeoutMs:50,cursorSigningKey:'projection-search'}).search(input)).hits.map(h=>h.claimId)).toEqual([result.claimId])
 })
 test.each(['missing','ambiguous','wrong_commit'])('%s target mapping cannot produce authority or broaden scope',async mode=>{
  const f=await fixture('snapshot',mode)
  await expect(f.publish()).rejects.toMatchObject({code:'state_conflict'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_authority_records')).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_claims WHERE installation_id=$1',[f.team])).rows[0].n).toBe(0)
 })
 test('a source-local task cannot become shared installation-wide knowledge without a task mapping',async()=>{
  const f=await fixture('task')
  await expect(f.publish()).rejects.toMatchObject({code:'state_conflict'})
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_authority_records')).rows[0].n).toBe(0)
 })
 test('snapshot commit proof is frozen at proposal time, not reread using publisher source access',async()=>{
  const f=await fixture('snapshot')
  const bundle=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[f.proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
  expect(bundle.sourceSnapshotCommitSha).toBe('a'.repeat(40))
  await pool.query('UPDATE repo_snapshots SET commit_sha=$2 WHERE repo_snapshot_id=$1',[f.source.snapshotId,'c'.repeat(40)])
  expect((await f.publish()).versionId).toBeTruthy()
 })
 test.each(['insert','remote_update'])('canonical registry %s writers wait until a publication mapping transaction ends',async mode=>{
  const f=await fixture('repository'),reader=await pool.connect(),writer=await pool.connect()
  if(mode==='remote_update')await repo(f.team,'concurrent-alias','github.com/Other/Repo')
  let pending:Promise<string>|undefined
  try{
   await reader.query('BEGIN');await writer.query('BEGIN')
   const bundle=(await reader.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[f.proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
   const mapped=await publicationApplicability(reader,bundle,f.team)
   expect(mapped.repositoryId).toBe(f.target!.repositoryId)
   const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   pending=createSourceRepository(pool).resolveRepository({installationId:f.team,repositoryKey:'concurrent-alias',canonicalRemote:'https://github.com/Acme/Repo.git'},writer)
   let waiting=false
   for(let i=0;i<50;i++){
    waiting=(await pool.query("SELECT wait_event='advisory' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true
    if(waiting)break
    await new Promise(resolve=>setTimeout(resolve,10))
   }
   expect(waiting).toBe(true)
   await reader.query('COMMIT')
   expect(await pending).toBeTruthy()
   await writer.query('COMMIT')
  }finally{
   await reader.query('ROLLBACK');await pending?.catch(()=>undefined);await writer.query('ROLLBACK');reader.release();writer.release()
  }
 })
 test('personal to Team to Organization preserves mapped scope, source times and upstream review policy',async()=>{
  const f=await fixture('branch'),teamPublished=await f.publish(),org=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
  const orgRepo=await repo(org,'organization-cwd'),members=[randomUUID(),randomUUID(),randomUUID(),randomUUID()]
  for(const [i,member] of members.entries())await pool.query('INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,$3)',[org,member,[i===0?'contributor':i===3?'scope_administrator':'reviewer']])
  const grant=(i:number,permissions:string[])=>({primaryInstallationId:org,configVersion:'1',scopeBindings:[
   {installation_id:f.team,owner_scope_kind:'team' as const,owner_scope_id:f.team,membership_id:f.proposer,membership_revision:'1',authorization_epoch:'1',permissions:['read']},
   {installation_id:org,owner_scope_kind:'organization' as const,owner_scope_id:org,membership_id:members[i],membership_revision:'1',authorization_epoch:'1',permissions}]})
  const evidence=(await pool.query('SELECT evidence_id FROM knowledge_evidence WHERE version_id=$1',[teamPublished.versionId])).rows[0].evidence_id
  const proposed=await createPromotionService(pool).propose({grant:grant(0,['read','contribute']),sourceInstallationId:f.team,sourceClaimId:teamPublished.claimId,evidenceIds:[evidence],idempotencyDigest:randomUUID()})
  const bundle=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposed.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
  const original=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[f.proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
  expect(bundle.originPolicyHash).toBe(original.reviewPolicyHash)
  const publication=createPublicationService(pool)
  for(const i of [1,2])await publication.decide({grant:grant(i,['read','review']),targetInstallationId:org,candidateId:proposed.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
  const published=await publication.publish({grant:grant(3,['read','publish']),targetInstallationId:org,candidateId:proposed.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
  const row=(await pool.query('SELECT repository_id,repo_snapshot_id,branch,valid_from,valid_until,freshness_at,applicability FROM knowledge_versions WHERE version_id=$1',[published.versionId])).rows[0]
  expect(row).toMatchObject({repository_id:orgRepo.repositoryId,repo_snapshot_id:orgRepo.snapshotId,branch:'main',applicability:{status:'verified',scopeKind:'branch'}})
  expect(row.valid_from.toISOString()).toBe('2025-01-01T00:00:00.000Z');expect(row.valid_until.toISOString()).toBe('2030-01-01T00:00:00.000Z');expect(row.freshness_at.toISOString()).toBe('2025-02-01T00:00:00.000Z')
 })
 test.each(['available','connection_off','missing_binding'])('Git-revised Team source with %s policy proof preserves applicability and requires proof for Organization publication',async mode=>{
  let app={scopeKind:'installation',scopeKey:'global',canonicalRepositoryKey:null as string|null,repositoryId:null as string|null,snapshotId:null as string|null,branch:null as string|null,status:'verified'}
  const s=await gitImportFixture(pool,['rule'],false,async f=>{
   app={...app,canonicalRepositoryKey:'github.com/Acme/Repo',repositoryId:f.repositoryId,snapshotId:f.skill.snapshotId,branch:'private-branch'}
   await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Acme/Repo.git' WHERE repository_id=$1",[f.repositoryId])
   await pool.query("UPDATE knowledge_claims SET scope_kind='installation',scope_key='global',canonical_repository_key=$2 WHERE claim_id=$1",[f.rule.claimId,app.canonicalRepositoryKey])
   await pool.query('UPDATE knowledge_versions SET repository_id=$2,repo_snapshot_id=$3,applicability=$4 WHERE version_id=$1',[f.rule.versionId,app.repositoryId,app.snapshotId,app])
  })
  await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
  const imports=createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const}),{proposals:[p]}=await s.plan()
  const request={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:p.proposalId,expectedRevision:'1'}
  await imports.review(s.f.skill.reviewer.grant,{...request,decision:'approve'})
  const applied=await imports.apply(s.f.skill.publisher.grant,request)
  expect.soft((await pool.query('SELECT applicability FROM knowledge_versions WHERE version_id=$1',[applied.versionId])).rows[0].applicability).toEqual(app)
  const upstream=(await pool.query('SELECT g.policy_hash FROM memory_authority_records a JOIN memory_git_governed_revisions g ON g.revision_id=a.candidate_revision_id WHERE a.version_id=$1',[applied.versionId])).rows[0].policy_hash
  if(mode==='connection_off')await pool.query("UPDATE memory_git_connections SET sync_mode='off' WHERE connection_id=$1",[s.f.connectionId])
  if(mode==='missing_binding')await pool.query('DELETE FROM memory_git_claim_authority WHERE installation_id=$1 AND version_id=$2',[s.f.installationId,applied.versionId])
  const org=randomUUID(),member=randomUUID()
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[org])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[org])
  await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['contributor'])",[org,member])
  const grant={primaryInstallationId:org,configVersion:'1',scopeBindings:[...s.f.grant.scopeBindings,{installation_id:org,owner_scope_kind:'organization' as const,owner_scope_id:org,membership_id:member,membership_revision:'1',authorization_epoch:'1',permissions:['read','contribute']}]}
  const evidence=(await pool.query('SELECT evidence_id FROM knowledge_evidence WHERE version_id=$1',[applied.versionId])).rows[0].evidence_id
  const proposal=await createPromotionService(pool).propose({grant,sourceInstallationId:s.f.installationId,sourceClaimId:s.f.rule.claimId,evidenceIds:[evidence],idempotencyDigest:randomUUID()})
  const bundle=(await pool.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[proposal.candidateRevision.candidate_revision_id])).rows[0].revision_bundle
  expect(bundle.applicability).toEqual(app)
  expect(bundle.originPolicyHash).toBe(mode==='missing_binding'?null:upstream)
  await repo(org,'organization-cwd')
  const actor=async(roles:string[],permissions:string[])=>{
   const id=randomUUID()
   await pool.query('INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,$3)',[org,id,roles])
   return{...grant,scopeBindings:grant.scopeBindings.map(b=>b.installation_id===org?{...b,membership_id:id,permissions}:b)}
  }
  const publication=createPublicationService(pool)
  for(let i=0;i<2;i++)await publication.decide({grant:await actor(['reviewer'],['read','review']),targetInstallationId:org,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,decision:'approve'})
  const publish=publication.publish({grant:await actor(['scope_administrator'],['read','publish']),targetInstallationId:org,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})
  if(mode!=='missing_binding')await expect(publish).resolves.toMatchObject({claimId:expect.any(String)})
  else{
   await expect(publish).rejects.toMatchObject({code:'state_conflict',details:{reason:'origin_policy_proof_required'}})
   expect((await pool.query('SELECT 1 FROM memory_authority_records WHERE installation_id=$1',[org])).rowCount).toBe(0)
  }
 })
 test.each(['legacy_unknown','requires_review'])('explicit %s cannot publish even after quorum',async status=>{
  const f=await governanceFixture(pool)
  await pool.query('UPDATE knowledge_versions SET applicability=$2 WHERE version_id=$1',[f.version,{scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,status}])
  const proposal=await f.approved()
  await expect(createPublicationService(pool).publish({grant:f.grant(f.publisher,['read','publish']),targetInstallationId:f.team,candidateId:proposal.candidate.candidate_id,expectedCandidateRevision:1,resolution:'new'})).rejects.toMatchObject({code:'state_conflict'})
 })
})
