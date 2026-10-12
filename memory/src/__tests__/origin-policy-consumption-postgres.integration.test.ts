import {queryHookPool} from './helpers/query-hook-pool.js'
import {originPolicyDecisions} from '../governance/origin-policy.js'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createSearchService} from '../retrieval/search-service.js'
import {contextClaimFacts,eligibleContextFacts} from '../context/consumption.js'
import {randomUUID} from 'node:crypto'
import {resolveSkillSource,assertCurrentSkillSourceClock} from '../skills/source-resolver.js'
import {insertWikiCandidateFixture} from './helpers/phase4-wiki-fixture.js'
import {createWikiPublicationService} from '../wiki/publication-service.js'
import {resolveSelectedContextReferences} from '../context/compiler.js'
import {createAdmissionService} from '../context/admission-service.js'
import {gitImportFixture} from '../testing/phase6-import-fixture.js'
import {createGitExportService} from '../git-sync/export-service.js'
import {createGitImportService} from '../git-sync/import-service.js'
import {loadSkillConfig} from '../skills/config.js'
import {originContextFixture} from './helpers/origin-context-fixture.js'
import {createReviewPolicyRepository,DEFAULT_TEAM_REVIEW_POLICY,DEFAULT_ORGANIZATION_REVIEW_POLICY} from '../governance/review-policy.js'
import {originPolicyFixture} from './helpers/origin-policy-fixture.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('live upstream origin policy consumption',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})
 const frame={repositoryId:null,repoSnapshotId:null,branch:null,taskScopeKey:null}
 test('an unchanged verified upstream policy permits the published copy',async()=>{
  const f=await originPolicyFixture(pool)
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'origin-test'})
  expect((await search.search({installationId:f.org,query:'Transactional fixture'})).hits.map(h=>h.versionId)).toEqual([f.published.versionId])
 })
 test('changed origin policy removes the copy from search with a bounded reason',async()=>{
  const f=await originPolicyFixture(pool);await f.change()
  const result=await createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'origin-test'}).search({installationId:f.org,query:'Transactional fixture'})
  expect(result.hits).toHaveLength(0);expect(result.degradedComponents).toContain('origin_policy_changed')
  expect((await pool.query('SELECT state FROM knowledge_claims WHERE claim_id=$1',[f.published.claimId])).rows[0].state).toBe('active')
 })
 test('Context facts reject a changed origin without rewriting the published Version',async()=>{
  const f=await originPolicyFixture(pool),before=(await pool.query('SELECT statement,applicability FROM knowledge_versions WHERE version_id=$1',[f.published.versionId])).rows[0]
  await f.change()
  const facts=(await contextClaimFacts(pool,f.org,[f.published.versionId])).get(f.published.versionId)!
  expect(eligibleContextFacts(facts,frame)).toBe(false)
  expect((await pool.query('SELECT statement,applicability FROM knowledge_versions WHERE version_id=$1',[f.published.versionId])).rows[0]).toEqual(before)
 })
 test('unchanged origin permits a real native-hidden compile, admission and single-use consume',async()=>{
  const f=await originPolicyFixture(pool),c=await originContextFixture(pool,f.org),pack=await c.compile()
  expect(pack.kind).toBe('ready');if(pack.kind!=='ready')throw new Error('fixture not ready')
  const ticket=await c.admit(pack.packId);expect(ticket.ok).toBe(true);if(!ticket.ok||!('nonce' in ticket))throw new Error('fixture not admitted')
  expect((await c.consume(pack.packId,ticket.injectionId,ticket.nonce)).ok).toBe(true)
  expect((await c.consume(pack.packId,ticket.injectionId,ticket.nonce)).ok).toBe(false)
 })
 test('source policy change expires an already admitted nonce while frozen pack bytes survive',async()=>{
  const f=await originPolicyFixture(pool),c=await originContextFixture(pool,f.org),pack=await c.compile()
  if(pack.kind!=='ready')throw new Error('fixture not ready')
  const ticket=await c.admit(pack.packId);if(!ticket.ok||!('nonce' in ticket))throw new Error('fixture not admitted')
  const before=(await pool.query('SELECT stable_text,dynamic_text,stable_hash,dynamic_hash FROM memory_context_packs WHERE pack_id=$1',[pack.packId])).rows[0]
  await f.change()
  expect(await c.consume(pack.packId,ticket.injectionId,ticket.nonce)).toEqual({ok:false,error:'expired'})
  expect((await pool.query('SELECT stable_text,dynamic_text,stable_hash,dynamic_hash FROM memory_context_packs WHERE pack_id=$1',[pack.packId])).rows[0]).toEqual(before)
 })
 test('a policy change and rollback cannot reuse a previously cached ready pack',async()=>{
  const f=await originPolicyFixture(pool),c=await originContextFixture(pool,f.org),one=await c.compile()
  if(one.kind!=='ready')throw new Error('fixture not ready')
  await f.change();await f.policies.rollback({installationId:f.team,targetVersionId:f.head.activeVersionId,expectedRevision:f.head.revision+1})
  const two=await c.compile();expect(two.kind).toBe('ready');if(two.kind!=='ready')throw new Error('fixture not ready')
  expect(two.packId).not.toBe(one.packId)
  expect((await c.admit(one.packId)).ok).toBe(false)
  expect((await c.admit(two.packId)).ok).toBe(true)
 })

 test('Skill source digest changes after origin policy rollback while the source body stays unchanged',async()=>{
  const f=await originPolicyFixture(pool,'work_method'),repositoryId=randomUUID(),repoSnapshotId=randomUUID()
  await pool.query("INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,'origin-skill',NOW(),NOW())",[f.org,repositoryId])
  await pool.query("INSERT INTO repo_snapshots(installation_id,repository_id,repo_snapshot_id,commit_sha,branch,observed_at) VALUES($1,$2,$3,$4,'main',NOW())",[f.org,repositoryId,repoSnapshotId,'a'.repeat(40)])
  const context={globalMode:'enabled' as const,sharedMode:'shadow' as const,config:loadSkillConfig({MEMORY_SKILL_MODE:'shadow'})}
  const resolve=async()=>{const client=await pool.connect();try{await client.query('BEGIN');const result=await resolveSkillSource(client,{installationId:f.org,grant:f.grant(0,['read','contribute']),source:{kind:'claim_version',versionId:f.published.versionId,repositoryId,repoSnapshotId}},context);await client.query('COMMIT');return result}finally{await client.query('ROLLBACK');client.release()}}
  const first=await resolve()
  await f.change();await expect(resolve()).rejects.toThrow('origin_policy_changed')
  await f.policies.rollback({installationId:f.team,targetVersionId:f.head.activeVersionId,expectedRevision:f.head.revision+1})
  const next=await resolve();expect(next.sources).toEqual(first.sources);expect(next.sourceDigest).not.toBe(first.sourceDigest);expect(next.inputDigest).not.toBe(first.inputDigest)
 })

 test('an absent-Memory parent tombstone committed between origin precheck and nonce transition expires the nonce',async()=>{
  const parentOrganizationId=randomUUID(),f=await originPolicyFixture(pool,'test_invariant',{parentOrganizationId})
  const c=await originContextFixture(pool,f.org),pack=await c.compile();if(pack.kind!=='ready')throw new Error('fixture not ready')
  const ticket=await c.admit(pack.packId);if(!ticket.ok||!('nonce' in ticket))throw new Error('fixture not admitted')
  let intercepted=false
  const hookedPool=queryHookPool(pool,async(sql:string,params:unknown[])=>{
   if(/UPDATE memory_context_injections j\s+SET state = 'prepared'/.test(sql)){
    intercepted=true;await pool.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'parent deleted')",[parentOrganizationId])
   }
  })
  const admission=createAdmissionService({pool:hookedPool,nonceHmacKey:Buffer.alloc(32,7)})
  expect(await admission.consume({installationId:f.org,sessionId:'origin-context-session',packId:pack.packId,injectionId:ticket.injectionId,nonce:ticket.nonce})).toEqual({ok:false,error:'expired'})
  expect(intercepted).toBe(true)
 })
 test('a reviewed native Team Git correction remains searchable without Team-to-Organization origin proof',async()=>{
  const s=await gitImportFixture(pool,['rule'],false,async f=>{
   const app={scopeKind:'installation',scopeKey:'global',canonicalRepositoryKey:'github.com/Acme/Repo',repositoryId:f.repositoryId,snapshotId:f.skill.snapshotId,branch:'private-branch',status:'verified'}
   await pool.query("UPDATE repositories SET canonical_remote='https://github.com/Acme/Repo.git' WHERE repository_id=$1",[f.repositoryId])
   await pool.query("UPDATE knowledge_claims SET scope_kind='installation',scope_key='global',canonical_repository_key=$2 WHERE claim_id=$1",[f.rule.claimId,app.canonicalRepositoryKey])
   await pool.query('UPDATE knowledge_versions SET repository_id=$2,repo_snapshot_id=$3,applicability=$4 WHERE version_id=$1',[f.rule.versionId,app.repositoryId,app.snapshotId,app])
  })
  await pool.query("UPDATE memory_git_connections SET sync_mode='enabled' WHERE connection_id=$1",[s.f.connectionId])
  const imports=createGitImportService({...s.deps,applicationMode:async()=> 'enabled' as const}),{proposals:[p]}=await s.plan()
  const request={installationId:s.f.installationId,connectionId:s.f.connectionId,expectedGeneration:'1',exportId:s.bundle.exportId,proposalId:p.proposalId,expectedRevision:'1'}
  await imports.review(s.f.skill.reviewer.grant,{...request,decision:'approve'})
  const applied=await imports.apply(s.f.skill.publisher.grant,request)
  expect((await pool.query('SELECT source_scope_kind FROM memory_authority_records WHERE version_id=$1',[applied.versionId])).rows[0].source_scope_kind).toBe('team')
  const hits=(await createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'origin-git'}).search({installationId:s.f.installationId,query:'Governed Git edit'})).hits
  expect(hits.map(h=>h.versionId)).toContain(applied.versionId)
 })

 test('the final Skill mutation clock rejects an origin policy changed after source resolution',async()=>{
  const f=await originPolicyFixture(pool,'work_method')
  await assertCurrentSkillSourceClock(pool,{installationId:f.org,versionId:f.published.versionId})
  await f.change()
  await expect(assertCurrentSkillSourceClock(pool,{installationId:f.org,versionId:f.published.versionId})).rejects.toThrow('origin_policy_changed')
 })
 test.each(['review','publish'])('Organization %s rejects a frozen source policy superseded after proposal',async stage=>{
  const change=async(team:string)=>{const policies=createReviewPolicyRepository(pool),head=(await policies.getHead(team))!;await policies.publishVersion({installationId:team,document:{...DEFAULT_TEAM_REVIEW_POLICY,max_shared_evidence:7},expectedRevision:head.revision,createdByMembershipId:null})}
  const options=stage==='review'?{beforeOrganizationReview:change}:{beforeOrganizationPublish:change}
  await expect(originPolicyFixture(pool,'test_invariant',options)).rejects.toMatchObject({code:'state_conflict',details:{reason:'origin_policy_changed'}})
  expect((await pool.query("SELECT 1 FROM knowledge_claims c JOIN memory_owner_scopes s USING(installation_id) WHERE s.owner_scope_kind='organization'")).rowCount).toBe(0)
 })

 test.each(['dissolved','revoked','tombstoned','proof_corrupt'])('a %s source cannot automatically feed its retained Organization copy',async mode=>{
  const f=await originPolicyFixture(pool)
  if(mode==='dissolved')await pool.query("UPDATE memory_owner_scopes SET state='dissolved' WHERE installation_id=$1",[f.team])
  if(mode==='revoked')await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.team])
  if(mode==='tombstoned')await pool.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('team',$1,1,'source deleted')",[f.team])
  if(mode==='proof_corrupt')await pool.query("UPDATE memory_promotion_candidate_versions SET revision_bundle=revision_bundle||'{\"originPolicyHash\":null}'::jsonb WHERE candidate_revision_id=$1",[f.proposed.candidateRevision.candidate_revision_id])
  const result=await createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'origin-life'}).search({installationId:f.org,query:'Transactional fixture'})
  expect(result.hits).toHaveLength(0);expect(result.degradedComponents).toContain(mode==='proof_corrupt'?'origin_policy_requires_review':'origin_policy_unavailable')
  const fact=(await contextClaimFacts(pool,f.org,[f.published.versionId])).get(f.published.versionId)!
  expect(eligibleContextFacts(fact,frame)).toBe(false)
  expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[f.published.versionId])).rows[0].statement).toBe('Transactional fixture invariant')
 })

 test.each(['claim_version','evidence'])('a Wiki derived from an ineligible origin %s cannot publish or enter Context',async sourceKind=>{
  const f=await originPolicyFixture(pool),w=await insertWikiCandidateFixture(pool,'origin-derived',f.org)
  const evidence=(await pool.query('SELECT evidence_id FROM knowledge_evidence WHERE version_id=$1',[f.published.versionId])).rows[0].evidence_id
  await pool.query('UPDATE memory_wiki_build_sources SET source_kind=$2,source_ref_id=$3 WHERE run_id=$1',[w.runId,sourceKind,sourceKind==='claim_version'?f.published.versionId:evidence])
  const publish=()=>createWikiPublicationService(pool).publish({grant:f.grant(3,['read','publish']),targetInstallationId:f.org,wikiId:w.wikiId,runId:w.runId,expectedGeneration:1,expectedHeadRevision:0})
  const published=await publish(),section=(await pool.query('SELECT section_id FROM memory_wiki_sections WHERE wiki_version_id=$1',[published.wikiVersionId])).rows[0]
  const reference={source_kind:'wiki_section' as const,source_id:section.section_id,source_version:published.wikiVersionId,owner_scope_id:f.org,installation_id:f.org}
  const frame={repositoryId:w.repositoryId,repoSnapshotId:null,branch:null,taskScopeKey:null,commitSha:w.commitSha}
  expect(await resolveSelectedContextReferences(pool,f.org,[reference],frame)).not.toBeNull()
  await f.change()
  expect.soft(await resolveSelectedContextReferences(pool,f.org,[reference],frame)).toBeNull()
  await pool.query("UPDATE memory_wiki_build_runs SET state='candidate' WHERE run_id=$1",[w.runId])
  await expect(createWikiPublicationService(pool).publish({grant:f.grant(3,['read','publish']),targetInstallationId:f.org,wikiId:w.wikiId,runId:w.runId,expectedGeneration:1,expectedHeadRevision:published.revision})).rejects.toMatchObject({code:'source_missing'})
 })

 test.each(['hold','unproven_origin'])('Git external export rejects %s while preserving the governed body',async mode=>{
  const s=await gitImportFixture(pool,['rule']),f=s.f
  const request={installationId:f.installationId,connectionId:f.connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export' as const,assets:[{kind:'rule' as const,id:f.rule.claimId}]}
  const grants=f.grant
  if(mode==='hold')await pool.query("UPDATE knowledge_claims SET consumption_hold_reason='identity_requires_review' WHERE claim_id=$1",[f.rule.claimId])
  else{
   await pool.query('DELETE FROM memory_git_connections WHERE connection_id=$1',[f.connectionId])
   await pool.query("UPDATE memory_owner_scopes SET owner_scope_kind='organization' WHERE installation_id=$1",[f.installationId])
   await pool.query("INSERT INTO memory_git_connections(connection_id,installation_id,repository_id,owner_scope_kind,owner_scope_id,provider,provider_repository_id,target_id,target_branch,credential_ref,sync_mode,write_mode) VALUES($1,$2,$3,'organization',$2,'github','123','fixture-org-target','main','fixture-credential','shadow','off')",[f.connectionId,f.installationId,f.repositoryId])
   await pool.query("UPDATE knowledge_claims SET owner_scope_kind='organization' WHERE claim_id=$1",[f.rule.claimId])
   await pool.query("UPDATE knowledge_versions SET authority='organization_published' WHERE version_id=$1",[f.rule.versionId])
   await pool.query("UPDATE memory_authority_records SET source_scope_kind='team' WHERE version_id=$1",[f.rule.versionId])
   for(const binding of grants.scopeBindings)if(binding.installation_id===f.installationId)binding.owner_scope_kind='organization'
  }
  await expect(createGitExportService(s.deps).export(grants,request)).rejects.toThrow('git_source_stale')
  expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[f.rule.versionId])).rows[0].statement).toBe('Synthetic statement')
 })

 test('an inherited parent policy can tighten a retained source without granting parent body access',async()=>{
  const parentOrganizationId=randomUUID(),f=await originPolicyFixture(pool,'test_invariant',{parentOrganizationId})
  await pool.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[parentOrganizationId])
  await pool.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'organization',$1)",[parentOrganizationId])
  const policies=createReviewPolicyRepository(pool)
  await policies.ensurePolicySet(parentOrganizationId,DEFAULT_ORGANIZATION_REVIEW_POLICY)
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'parent-origin'})
  expect((await search.search({installationId:f.org,query:'Transactional fixture'})).hits.map(h=>h.versionId)).toContain(f.published.versionId)
  const parentHead=(await policies.getHead(parentOrganizationId))!
  await policies.publishVersion({installationId:parentOrganizationId,document:{...DEFAULT_TEAM_REVIEW_POLICY,minimum_approvals:3},createdByMembershipId:null,expectedRevision:parentHead.revision})
  const result=await search.search({installationId:f.org,query:'Transactional fixture'})
  expect(result.hits).toHaveLength(0);expect(result.degradedComponents).toContain('origin_policy_changed')
 })

 test('Git final export fence rejects an upstream policy committed after asset resolution',async()=>{
  const deps=(await gitImportFixture(pool,['rule'])).deps,f=await originPolicyFixture(pool,'test_invariant',{scopeKey:'global'}),repositoryId=randomUUID(),connectionId=randomUUID()
  await pool.query("INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,'origin-git-export',NOW(),NOW())",[f.org,repositoryId])
  // Attach a known owned repository as Git transport provenance; applicability remains installation-wide.
  await pool.query("UPDATE knowledge_versions SET repository_id=$2,applicability=jsonb_set(applicability,'{repositoryId}',to_jsonb($2::uuid)) WHERE version_id=$1",[f.published.versionId,repositoryId])
  await pool.query("INSERT INTO memory_git_connections(connection_id,installation_id,repository_id,owner_scope_kind,owner_scope_id,provider,provider_repository_id,target_id,target_branch,credential_ref,sync_mode,write_mode) VALUES($1,$2,$3,'organization',$2,'github','123','origin-export-target','main','fixture-credential','shadow','off')",[connectionId,f.org,repositoryId])
  const grant={...f.grant(3,['read','contribute','publish','scope_admin']),scopeBindings:f.grant(3,['read','contribute','publish','scope_admin']).scopeBindings.filter(b=>b.installation_id===f.org)}
  const request={installationId:f.org,connectionId,expectedGeneration:'1',baseCommit:'a'.repeat(40),purpose:'external_export' as const,assets:[{kind:'claim' as const,id:f.published.claimId}]}
  expect((await createGitExportService(deps).export(grant,request)).assets).toHaveLength(1)
  let changed=false
  const hookedPool={connect:async()=>{const client=await pool.connect(),originalQuery=client.query,originalRelease=client.release,query=client.query.bind(client);client.release=(error?:Error|boolean)=>{client.query=originalQuery;client.release=originalRelease;return originalRelease(error)};client.query=(async(sql:string,params:unknown[])=>{
   if(!changed&&/SELECT version_id FROM knowledge_versions WHERE installation_id/.test(sql)){changed=true;await f.change()}
   return query(sql,params)
  }) as typeof client.query;return client}} as unknown as pg.Pool
  await expect(createGitExportService({...deps,pool:hookedPool}).export(grant,request)).rejects.toThrow('git_source_stale')
  expect(changed).toBe(true)
 })

 test('a Skill mutation cannot commit under a source stamp observed before policy change and rollback',async()=>{
  const f=await originPolicyFixture(pool),decision=(await originPolicyDecisions(pool,f.org,[f.published.versionId])).get(f.published.versionId)!
  await f.change();await f.policies.rollback({installationId:f.team,targetVersionId:f.head.activeVersionId,expectedRevision:f.head.revision+1})
  await expect(assertCurrentSkillSourceClock(pool,{installationId:f.org,versionId:f.published.versionId,originPolicyStamp:decision.stamp!})).rejects.toThrow('origin_policy_changed')
 })

 test.each([['claim_version','fact'],['evidence','fact'],['claim_version','revision'],['evidence','revision']])('Wiki nonce cannot outlive its cited %s %s validity window',async(sourceKind,clock)=>{
  const f=await originPolicyFixture(pool),w=await insertWikiCandidateFixture(pool,'origin-expiring-wiki',f.org)
  const evidence=(await pool.query('SELECT evidence_id FROM knowledge_evidence WHERE version_id=$1',[f.published.versionId])).rows[0].evidence_id
  await pool.query('UPDATE memory_wiki_build_sources SET source_kind=$2,source_ref_id=$3 WHERE run_id=$1',[w.runId,sourceKind,sourceKind==='claim_version'?f.published.versionId:evidence])
  await pool.query(clock==='fact'?"UPDATE knowledge_versions SET valid_until=clock_timestamp()+INTERVAL '2 seconds' WHERE version_id=$1":
   "UPDATE knowledge_versions SET effective_until=clock_timestamp()+INTERVAL '2 seconds' WHERE version_id=$1",[f.published.versionId])
  const published=await createWikiPublicationService(pool).publish({grant:f.grant(3,['read','publish']),targetInstallationId:f.org,wikiId:w.wikiId,runId:w.runId,expectedGeneration:1,expectedHeadRevision:0})
  const section=(await pool.query('SELECT section_id FROM memory_wiki_sections WHERE wiki_version_id=$1',[published.wikiVersionId])).rows[0]
  const c=await originContextFixture(pool,f.org)
  const pack=await c.compiler.compile({installationId:f.org,sessionId:'origin-context-session',clientRequestId:'origin-context-request',agent:'codex',adapterCapability:'native_hidden_v1',repositoryId:w.repositoryId,commitSha:w.commitSha,query:'wiki',requestKey:{keyId:'k',hmacKey:Buffer.alloc(32,3)},selectedReferences:[{source_kind:'wiki_section',source_id:section.section_id,source_version:published.wikiVersionId,owner_scope_id:f.org,installation_id:f.org}]})
  if(pack.kind!=='ready')throw new Error('expiring Wiki not ready '+JSON.stringify(pack))
  const ticket=await c.admit(pack.packId);if(!ticket.ok||!('nonce' in ticket))throw new Error('expiring Wiki not admitted')
  const locker=await pool.connect();await locker.query('BEGIN');await locker.query('SELECT 1 FROM memory_context_injections WHERE injection_id=$1 FOR UPDATE',[ticket.injectionId])
  let signal!:()=>void;const started=new Promise<void>(resolve=>{signal=resolve})
  const hooked=queryHookPool(pool,async(sql)=>{if(sql.includes('FOR UPDATE OF j'))signal()})
  const consume=createAdmissionService({pool:hooked,nonceHmacKey:Buffer.alloc(32,7)}).consume({installationId:f.org,sessionId:'origin-context-session',packId:pack.packId,injectionId:ticket.injectionId,nonce:ticket.nonce})
  try{
   await started
   await pool.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (${clock==='fact'?'valid_until':'effective_until'}-clock_timestamp())))::double precision+0.03) FROM knowledge_versions WHERE version_id=$1`,[f.published.versionId])
   await locker.query('COMMIT');expect(await consume).toEqual({ok:false,error:'expired'})
  }finally{await locker.query('ROLLBACK');locker.release()}
 })

 test('same-scope Organization authority history cannot erase Team origin when its candidate proof is removed',async()=>{
  const f=await originPolicyFixture(pool),versionId=randomUUID()
  // Exact database contract of a same-scope governed revision: retained candidate,
  // new own-scope authority, original Team authority remains immutable history.
  await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,source_promotion_candidate_id,applicability)
   SELECT $1,installation_id,claim_id,2,statement,structured_content,authority,confidence,source_promotion_candidate_id,applicability FROM knowledge_versions WHERE version_id=$2`,[versionId,f.published.versionId])
  await pool.query(`INSERT INTO memory_authority_records(authority_id,installation_id,version_id,candidate_revision_id,review_policy_version_id,counted_decision_ids,publisher_membership_id,source_scope_kind,source_content_hash)
   SELECT gen_random_uuid(),installation_id,$1,gen_random_uuid(),review_policy_version_id,counted_decision_ids,publisher_membership_id,'organization',source_content_hash FROM memory_authority_records WHERE version_id=$2`,[versionId,f.published.versionId])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[f.published.claimId,versionId])
  expect(eligibleContextFacts((await contextClaimFacts(pool,f.org,[versionId])).get(versionId)!,frame)).toBe(true)
  await pool.query('DELETE FROM memory_promotion_candidates WHERE candidate_id=$1',[f.proposed.candidate.candidate_id])
  expect(eligibleContextFacts((await contextClaimFacts(pool,f.org,[versionId])).get(versionId)!,frame)).toBe(false)
 })
 test('a reviewed origin bundle removed after nonce precheck cannot deliver frozen copied bytes',async()=>{
  const f=await originPolicyFixture(pool),c=await originContextFixture(pool,f.org),pack=await c.compile();if(pack.kind!=='ready')throw new Error('fixture not ready')
  const ticket=await c.admit(pack.packId);if(!ticket.ok||!('nonce' in ticket))throw new Error('fixture not admitted')
  const hookedPool=queryHookPool(pool,async(sql:string,params:unknown[])=>{
   if(/UPDATE memory_context_injections j\s+SET state = 'prepared'/.test(sql))await pool.query('DELETE FROM memory_promotion_candidates WHERE candidate_id=$1',[f.proposed.candidate.candidate_id])
  })
  expect(await createAdmissionService({pool:hookedPool,nonceHmacKey:Buffer.alloc(32,7)}).consume({installationId:f.org,sessionId:'origin-context-session',packId:pack.packId,injectionId:ticket.injectionId,nonce:ticket.nonce})).toEqual({ok:false,error:'expired'})
 })

})
