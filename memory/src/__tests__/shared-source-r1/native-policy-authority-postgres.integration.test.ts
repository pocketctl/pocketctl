import {randomUUID} from 'node:crypto'
import type pg from 'pg'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {afterAll,afterEach,beforeAll,describe,expect,test} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {createReviewPolicyRepository,loadEffectiveReviewPolicySnapshot,canonicalReviewPolicyHash,DEFAULT_TEAM_REVIEW_POLICY,DEFAULT_ORGANIZATION_REVIEW_POLICY} from '../../governance/review-policy.js'
import {currentOriginPolicy,originPolicyFenceSql,lockOriginPolicyFences,type OriginPolicyFence} from '../../governance/origin-policy.js'
import {lockGitPolicyScopes} from '../../git-sync/authorization.js'
import {createTransactionBoundPool} from '../../api/transaction-bound-pool.js'
import {nativeOriginKnowledgeFixture} from './native-origin-context-fixture.js'
import {originContextFixture} from '../helpers/origin-context-fixture.js'
import {createEvidenceService} from '../../claims/evidence-service.js'
import {retainedSourceRead} from '../../sources/retained-read.js'
import {guardRetainedEvidence} from '../../sources/retained-authority.js'
import {revisionBundleHash,bundleEvidence} from '../../governance/revision-bundle.js'
import {createGitRepository} from '../../git-sync/repository.js'
import {collectGitLifecycleSources,readGitAssets,type GitReaderInput} from '../../git-sync/asset-reader.js'
import type {ClaimAsset} from '../../git-sync/types.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
suite('policy inheritance follows native owner and parent facts',()=>{
 let f:DirectLaunchFixture,child:string,team:string,oldScope:string,newScope:string,oldParent:string,newParent:string,oldHead:string,newHead:string
 const snapshot=async()=>{const c=await f.runtime.connect();try{await c.query('BEGIN');return await loadEffectiveReviewPolicySnapshot(c,child)}finally{await c.query('ROLLBACK');c.release()}}
 const nonceFence=async(c:pg.PoolClient,fences:readonly OriginPolicyFence[])=>await lockOriginPolicyFences(c,fences,'memory')?(await c.query(`SELECT ${originPolicyFenceSql('$1','memory')} AS valid`,[JSON.stringify(fences)])).rows[0].valid as boolean:false
 beforeAll(async()=>{
  f=await directLaunchFixture(url!);child=randomUUID();team=randomUUID();oldScope=randomUUID();newScope=randomUUID();oldParent=randomUUID();newParent=randomUUID()
  await (await import(pathToFileURL(resolve('../relay/dist/shared-source/control-capture.js')).href)).applyRelayControlCapture(f.pool)
  for(const id of [oldScope,newScope])await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,$1::uuid::text)",[id])
  await f.pool.query("INSERT INTO public.extension_teams(team_id,organization_id,name) VALUES($1,$2,'native policy synthetic')",[team,oldScope])
  for(const [installation,kind,scope,parent]of [[child,'team',team,oldScope],[oldParent,'organization',oldScope,null],[newParent,'organization',newScope,null]]){
   await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory',$2,$3,'active','{}','{}','{}','from_now')",[installation,kind,scope])
   await f.runtime.query("INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)",[installation])
   await f.runtime.query("INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id,parent_organization_id,state,authorization_epoch) VALUES($1,$2,$3,$4,'active',1)",[installation,kind,scope,parent])
  }
  const policies=createReviewPolicyRepository(f.runtime)
  await policies.ensurePolicySet(child,{...DEFAULT_TEAM_REVIEW_POLICY})
  oldHead=(await policies.ensurePolicySet(oldParent,{...DEFAULT_ORGANIZATION_REVIEW_POLICY})).policyVersionId
  newHead=(await policies.ensurePolicySet(newParent,{...DEFAULT_ORGANIZATION_REVIEW_POLICY,minimum_approvals:3})).policyVersionId
 },60000)
 afterEach(async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,oldScope])
  await f.pool.query("UPDATE public.extension_organizations SET state='active' WHERE organization_id=ANY($1::uuid[])",[[oldScope,newScope]])
  await f.pool.query("UPDATE public.extension_installations SET status='active' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent,newParent]])
  await f.runtime.query("UPDATE memory_owner_scopes SET state='active' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent,newParent]])
  await f.runtime.query("UPDATE memory_installations SET relay_status='active',local_status='ready' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent,newParent]])
 })
 afterAll(async()=>{await f?.close()})
 test('the unchanged native parent contributes its actual policy version',async()=>{expect(await snapshot()).toMatchObject({parentActiveVersionId:oldHead,policy:{minimum_approvals:2}})})
 test('native parent move uses the new parent policy before local mirror refresh',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  expect(await snapshot()).toMatchObject({parentActiveVersionId:newHead,policy:{minimum_approvals:3}})
 })
 test('native parent suspension defeats an active local parent cache',async()=>{
  await f.pool.query("UPDATE public.extension_organizations SET state='suspended' WHERE organization_id=$1",[oldScope])
  await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
 })
 test('native target revocation defeats a ready active local cache',async()=>{
  await f.pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[child])
  await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
 })
 test('Git inheritance locks the actual native parent instead of the stale cached parent',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope]);const c=await f.runtime.connect()
  try{await c.query('BEGIN');expect((await lockGitPolicyScopes(c,{primaryInstallationId:child,configVersion:'1',scopeBindings:[]},child)).sort()).toEqual([child,newParent].sort())}finally{await c.query('ROLLBACK');c.release()}
 })
 test('current parent local privacy tombstone is enforced even with stale cached ancestry',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-privacy')",[newScope])
  try{await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')}finally{await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[newScope])}
 })
 test('native parent installation revocation cannot fall back to the organization floor',async()=>{
  await f.pool.query("UPDATE public.extension_installations SET status='revoked' WHERE installation_id=$1",[oldParent])
  await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
 })
 test('local cached native states are not a second authority',async()=>{
  await f.runtime.query("UPDATE memory_owner_scopes SET state='suspended' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent]])
  await f.runtime.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=ANY($1::uuid[])",[[child,oldParent]])
  expect(await snapshot()).toMatchObject({parentActiveVersionId:oldHead,policy:{minimum_approvals:2}})
 })
 test('local parent purge remains an independent deny gate',async()=>{
  await f.runtime.query("UPDATE memory_installations SET local_status='purging' WHERE installation_id=$1",[oldParent])
  await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
 })
 test('a pre-extension grant contract fails closed instead of falling back to cached policy ancestry',async()=>{
  const definition=(await f.pool.query("SELECT pg_get_functiondef('shared.memory_current_grant_states(uuid[],uuid[])'::regprocedure) AS definition")).rows[0].definition as string
  try{
   await f.pool.query(definition.replace("'policy_contract_version',1,", "'previous_policy_contract_version',1,"))
   await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
  }finally{await f.pool.query(definition)}
 })
 test('installed native parent tombstones fence a stale cached ancestry until COMMIT',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  const c=await f.runtime.connect(),tombstone=()=>f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-parent')",[newScope])
  try{
   await c.query('BEGIN');await loadEffectiveReviewPolicySnapshot(c,child)
   await expect(tombstone()).rejects.toMatchObject({code:'55P03'})
   await c.query('COMMIT');await tombstone();await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
  }finally{await c.query('ROLLBACK');c.release();await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[newScope])}
 })
 test('native ancestry locks remain held after a service savepoint until physical COMMIT',async()=>{
  const c=await f.runtime.connect(),other=await f.pool.connect()
  try{
   await c.query('BEGIN');const alias=await createTransactionBoundPool(c).connect();await alias.query('BEGIN')
   expect(await loadEffectiveReviewPolicySnapshot(alias,child)).toMatchObject({parentActiveVersionId:oldHead})
   await alias.query('COMMIT');alias.release()
   await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='100ms'")
   await expect(other.query('SELECT team_id FROM public.extension_teams WHERE team_id=$1 FOR UPDATE NOWAIT',[team])).rejects.toMatchObject({code:'55P03'})
   await other.query('ROLLBACK');await c.query('COMMIT')
   await other.query('BEGIN');await other.query('SELECT team_id FROM public.extension_teams WHERE team_id=$1 FOR UPDATE NOWAIT',[team]);await other.query('ROLLBACK')
  }finally{await c.query('ROLLBACK');await other.query('ROLLBACK');c.release();other.release()}
 })
 test('native installed parent wins over historical terminal installations',async()=>{
  const historical=randomUUID()
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'revoked','{}','{}','{}','from_now')",[historical,oldScope])
  try{expect(await snapshot()).toMatchObject({parentActiveVersionId:oldHead})}finally{await f.pool.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[historical])}
 })
 test('genuinely uninstalled parent uses the existing organization floor and fences installation phantoms',async()=>{
  const scope=randomUUID(),installation=randomUUID(),c=await f.runtime.connect()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'uninstalled parent synthetic')",[scope])
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,scope])
  const insert=()=>f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}','{}','{}','from_now')",[installation,scope])
  try{
   await c.query('BEGIN');expect(await loadEffectiveReviewPolicySnapshot(c,child)).toMatchObject({parentActiveVersionId:null,policy:{minimum_approvals:2}})
   await expect(insert()).rejects.toMatchObject({code:'55P03'})
   await c.query('COMMIT');await insert()
   await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
  }finally{await c.query('ROLLBACK');c.release();await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,oldScope]);await f.pool.query('DELETE FROM public.extension_installations WHERE installation_id=$1',[installation]);await f.pool.query('DELETE FROM public.extension_organizations WHERE organization_id=$1',[scope])}
 })
 test('uninstalled native parent privacy changes are fenced by its child until physical COMMIT',async()=>{
  const scope=randomUUID(),c=await f.runtime.connect()
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'uninstalled private parent synthetic')",[scope])
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,scope])
  const tombstone=()=>f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic')",[scope])
  try{
   await c.query('BEGIN');await loadEffectiveReviewPolicySnapshot(c,child)
   await expect(tombstone()).rejects.toMatchObject({code:'55P03'})
   await c.query('COMMIT');await tombstone();await expect(snapshot()).rejects.toThrow('review_policy_scope_stale')
  }finally{await c.query('ROLLBACK');c.release();await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[scope]);await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,oldScope]);await f.pool.query('DELETE FROM public.extension_organizations WHERE organization_id=$1',[scope])}
 })
 test('origin metadata uses the current native parent policy from a bare runtime pool',async()=>{
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  expect((await currentOriginPolicy(f.runtime,child))?.hash).toBe(canonicalReviewPolicyHash((await snapshot()).policy))
 })
 test('native origin parent suspension cannot remain eligible through an active cached parent',async()=>{
  await f.pool.query("UPDATE public.extension_organizations SET state='suspended' WHERE organization_id=$1",[oldScope])
  expect(await currentOriginPolicy(f.runtime,child)).toBeNull()
 })
 test('native origin state remains authoritative over a stale revoked local scope mirror',async()=>{
  await f.runtime.query("UPDATE memory_owner_scopes SET state='suspended' WHERE installation_id=$1",[child])
  expect(await currentOriginPolicy(f.runtime,child)).not.toBeNull()
 })
 test('origin nonce SQL rejects an actual native parent move before local mirrors refresh',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child);expect(policy).not.toBeNull()
  await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  const c=await f.runtime.connect();try{await c.query('BEGIN');expect(await nonceFence(c,policy!.fences)).toBe(false)}finally{await c.query('ROLLBACK');c.release()}
 })
 test('origin nonce native control fence remains held until the physical COMMIT',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child),c=await f.runtime.connect()
  try{
   await c.query('BEGIN');expect(await nonceFence(c,policy!.fences)).toBe(true)
   await expect(f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])).rejects.toMatchObject({code:'55P03'})
   await c.query('COMMIT');await f.pool.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('origin nonce native local privacy fence remains held until the physical COMMIT',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child),c=await f.runtime.connect()
  const insert=()=>f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-origin')",[oldScope])
  try{
   await c.query('BEGIN');expect(await nonceFence(c,policy!.fences)).toBe(true)
   await expect(insert()).rejects.toMatchObject({code:'55P03'});await c.query('COMMIT');await insert()
  }finally{await c.query('ROLLBACK');c.release();await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[oldScope])}
 })
 test('origin nonce policy head locks survive until physical COMMIT for target and native parent',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child),c=await f.runtime.connect(),writer=await f.pool.connect()
  try{
   await c.query('BEGIN');expect(await nonceFence(c,policy!.fences)).toBe(true)
   for(const installation of [child,oldParent]){
    await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
    await expect(writer.query('UPDATE memory.memory_review_policy_heads SET revision=revision+1 WHERE policy_id IN(SELECT policy_id FROM memory.memory_review_policy_sets WHERE installation_id=$1)',[installation])).rejects.toMatchObject({code:'55P03'})
    await writer.query('ROLLBACK')
   }
   await c.query('COMMIT');await writer.query('BEGIN');await writer.query('SELECT h.policy_id FROM memory.memory_review_policy_heads h JOIN memory.memory_review_policy_sets s USING(policy_id) WHERE s.installation_id=$1 FOR UPDATE OF h NOWAIT',[oldParent]);await writer.query('ROLLBACK')
  }finally{await c.query('ROLLBACK');await writer.query('ROLLBACK');c.release();writer.release()}
 })
 test('a concurrent native parent policy writer denies the nonce instead of waiting or accepting stale policy',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child),c=await f.runtime.connect(),writer=await f.pool.connect()
  try{
   await writer.query('BEGIN');await writer.query('SELECT h.policy_id FROM memory.memory_review_policy_heads h JOIN memory.memory_review_policy_sets s USING(policy_id) WHERE s.installation_id=$1 FOR UPDATE OF h',[oldParent])
   await c.query('BEGIN');expect(await nonceFence(c,policy!.fences)).toBe(false)
  }finally{await c.query('ROLLBACK');await writer.query('ROLLBACK');c.release();writer.release()}
 })
 test('a privacy tombstone committed after SQL snapshot but before privacy lock is denied',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child),c=await f.runtime.connect(),blocker=await f.pool.connect();let pending:Promise<boolean>|undefined
  await f.pool.query(`CREATE FUNCTION memory.fixture_origin_privacy_lock(p_key bigint) RETURNS boolean LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_advisory_xact_lock(91812261110::bigint);RETURN pg_try_advisory_xact_lock_shared(p_key);END $$`)
  const wrapped={query:(sql:string,params?:unknown[])=>c.query(sql.replaceAll('pg_try_advisory_xact_lock_shared(','memory.fixture_origin_privacy_lock('),params),release:()=>{}} as unknown as pg.PoolClient
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(91812261110::bigint)');await c.query('BEGIN')
   const pid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
   pending=nonceFence(wrapped,policy!.fences);void pending.catch(()=>undefined)
   let waiting=false
   for(let n=0;n<100;n++){if((await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory'",[pid])).rowCount){waiting=true;break}await new Promise(r=>setTimeout(r,10))}
   expect(waiting).toBe(true)
   await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'snapshot-window')",[oldScope])
   await blocker.query('COMMIT');expect(await pending).toBe(false)
  }finally{await blocker.query('ROLLBACK');await pending?.catch(()=>undefined);await c.query('ROLLBACK');c.release();blocker.release();await f.runtime.query("DELETE FROM memory_scope_tombstones WHERE owner_scope_kind='organization' AND owner_scope_id=$1",[oldScope]);await f.pool.query('DROP FUNCTION memory.fixture_origin_privacy_lock(bigint)')}
 })
 test('actual native Team to Organization knowledge compiles admits and consumes once',async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope),context=await originContextFixture(f.runtime,knowledge.org,{authorityGrant:knowledge.grant(3,['read'])}),pack=await context.compile()
  if(pack.kind!=='ready')throw Error('native_fixture_compile:'+JSON.stringify(pack))
  const ticket=await context.admit(pack.packId);if(!ticket.ok)throw Error('native_fixture_admission:'+JSON.stringify(ticket));expect(ticket.ok).toBe(true);if(!('nonce'in ticket))throw Error('native fixture not admitted')
  expect((await context.consume(pack.packId,ticket.injectionId,ticket.nonce)).ok).toBe(true)
  expect((await context.consume(pack.packId,ticket.injectionId,ticket.nonce)).ok).toBe(false)
 })
 test('unproved episode citations still reject native Context instead of being promoted to retained authority',async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope,{retainedExcerpt:false}),context=await originContextFixture(f.runtime,knowledge.personal,{authorityGrant:knowledge.personalGrant})
  await expect(context.compile()).rejects.toThrow('source_reference_unproven')
 })
 test('native governed evidence supports exact version and evidence reads without a fabricated source UUID',async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope),service=createEvidenceService(f.runtime),input={installationId:knowledge.org,authorityGrant:knowledge.grant(3,['read'])}
  const items=await service.evidenceForVersion({...input,versionId:knowledge.published.versionId});expect(items).toHaveLength(1)
  const item=items[0] as any;expect(item.source_event_id).toBeNull();expect(item.artifact_id).toBeNull();expect(item.evidence_kind).toBe('episode')
  expect(await service.evidenceById({...input,evidenceId:item.evidence_id})).toMatchObject({version_id:knowledge.published.versionId})
 })
 for(const corruption of ['locator','occurred_at','bundle_hash','authority','owner'] as const)test(`native governed retained evidence denies altered ${corruption}`,async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope),input={installationId:knowledge.org,versionId:knowledge.published.versionId,authorityGrant:knowledge.grant(3,['read'])}
  if(corruption==='locator')await f.runtime.query("UPDATE knowledge_evidence SET locator=jsonb_build_object('tampered',true) WHERE version_id=$1",[input.versionId])
  if(corruption==='occurred_at')await f.runtime.query("UPDATE knowledge_evidence SET occurred_at=clock_timestamp()+interval '1 day' WHERE version_id=$1",[input.versionId])
  if(corruption==='bundle_hash')await f.runtime.query("UPDATE memory_promotion_candidate_versions SET revision_bundle_hash=repeat('0',64) WHERE candidate_revision_id=(SELECT candidate_revision_id FROM memory_authority_records WHERE version_id=$1)",[input.versionId])
  if(corruption==='authority')await f.runtime.query('DELETE FROM memory_authority_records WHERE version_id=$1',[input.versionId])
  if(corruption==='owner')await f.runtime.query('UPDATE knowledge_claims SET owner_scope_id=$2 WHERE current_version_id=$1',[input.versionId,randomUUID()])
  expect(await createEvidenceService(f.runtime).evidenceForVersion(input)).toEqual([])
 })
 for(const field of ['version_id','episode_id'] as const)test(`a governed evidence ID cannot exempt a different supplied ${field}`,async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope),row=(await f.runtime.query('SELECT evidence_id::text,version_id::text,episode_id::text,evidence_kind,source_event_id::text,artifact_id::text FROM knowledge_evidence WHERE version_id=$1',[knowledge.published.versionId])).rows[0]
  row[field]=randomUUID()
  expect(await retainedSourceRead(f.runtime,{installationId:knowledge.org,authorityGrant:knowledge.grant(3,['read'])},async db=>{await guardRetainedEvidence(db,knowledge.org,[row]);return true})).toBeUndefined()
 })
 test('evidence API cannot retain an Organization copy after native upstream revocation',async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope),service=createEvidenceService(f.runtime),input={installationId:knowledge.org,versionId:knowledge.published.versionId,authorityGrant:knowledge.grant(3,['read'])}
  const before=await service.evidenceForVersion(input);expect(before).toHaveLength(1)
  await f.pool.query("UPDATE public.extension_organizations SET state='suspended' WHERE organization_id=$1",[oldScope])
  expect(await service.evidenceForVersion(input)).toEqual([])
  expect(await service.evidenceById({installationId:knowledge.org,authorityGrant:input.authorityGrant,evidenceId:(before[0] as any).evidence_id})).toBeNull()
 })
 for(const sourceVersion of [true,'01',[2],{},null] as unknown[])test(`retained evidence API rejects malformed reviewed Team source version ${JSON.stringify(sourceVersion)}`,async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope),versionId=knowledge.published.versionId,locator={source_provenance:{source_kind:'team_session',source_version:sourceVersion}}
  const revisionId=(await f.runtime.query('SELECT candidate_revision_id FROM memory_authority_records WHERE version_id=$1',[versionId])).rows[0].candidate_revision_id
  await f.runtime.query('UPDATE memory_promotion_evidence SET sanitized_locator=$2::jsonb WHERE candidate_revision_id=$1',[revisionId,JSON.stringify(locator)])
  await f.runtime.query('UPDATE knowledge_evidence SET locator=$2::jsonb WHERE version_id=$1',[versionId,JSON.stringify(locator)])
  const bundle=(await f.runtime.query('SELECT revision_bundle FROM memory_promotion_candidate_versions WHERE candidate_revision_id=$1',[revisionId])).rows[0].revision_bundle
  bundle.evidence=bundleEvidence((await f.runtime.query('SELECT * FROM memory_promotion_evidence WHERE candidate_revision_id=$1 ORDER BY ordinal',[revisionId])).rows)
  await f.runtime.query('UPDATE memory_promotion_candidate_versions SET revision_bundle=$2::jsonb,revision_bundle_hash=$3 WHERE candidate_revision_id=$1',[revisionId,JSON.stringify(bundle),revisionBundleHash(bundle)])
  const service=createEvidenceService(f.runtime),input={installationId:knowledge.org,authorityGrant:knowledge.grant(3,['read'])},evidenceId=(await f.runtime.query('SELECT evidence_id FROM knowledge_evidence WHERE version_id=$1',[versionId])).rows[0].evidence_id
  expect(await service.evidenceForVersion({...input,versionId})).toEqual([])
  expect(await service.evidenceById({...input,evidenceId})).toBeNull()
 })
 test('native Context refuses a target statement changed after its reviewed publication',async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope)
  await f.runtime.query("UPDATE knowledge_versions SET statement='Unreviewed replacement statement' WHERE version_id=$1",[knowledge.published.versionId])
  const context=await originContextFixture(f.runtime,knowledge.org,{authorityGrant:knowledge.grant(3,['read'])})
  await expect(context.compile()).rejects.toThrow('source_reference_unproven')
 })
 test('origin final SQL refuses a missing physical transaction and prior lock roster',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child),c=await f.runtime.connect()
  try{
   expect(await lockOriginPolicyFences(c,policy!.fences,'memory')).toBe(false)
   await c.query('BEGIN')
   expect((await c.query(`SELECT ${originPolicyFenceSql('$1','memory')} AS valid`,[JSON.stringify(policy!.fences)])).rows[0].valid).toBe(false)
  }finally{await c.query('ROLLBACK');c.release()}
 })
 test('origin final locks reject a retained REPEATABLE READ snapshot',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child),c=await f.runtime.connect()
  try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');expect(await nonceFence(c,policy!.fences)).toBe(false)}finally{await c.query('ROLLBACK');c.release()}
 })
 test('registered origin nonce aliases retain native control locks until physical COMMIT',async()=>{
  const policy=await currentOriginPolicy(f.runtime,child),c=await f.runtime.connect(),writer=await f.pool.connect()
  try{
   await c.query('BEGIN');const alias=await createTransactionBoundPool(c).connect();await alias.query('BEGIN')
   expect(await nonceFence(alias,policy!.fences)).toBe(true);await alias.query('COMMIT');alias.release()
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
   await expect(writer.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope])).rejects.toMatchObject({code:'55P03'})
   await writer.query('ROLLBACK');await c.query('COMMIT')
   await writer.query('BEGIN');await writer.query('UPDATE public.extension_teams SET organization_id=$2 WHERE team_id=$1',[team,newScope]);await writer.query('COMMIT')
  }finally{await c.query('ROLLBACK');await writer.query('ROLLBACK');c.release();writer.release()}
 })
 test('combined native publication and Git claim export retains exact reviewed evidence IDs',async()=>{
  const knowledge=await nativeOriginKnowledgeFixture(f,oldScope,{repositoryScoped:true}),repositoryId=knowledge.repositories.get(knowledge.org)!,grant=knowledge.grant(3,['read','scope_admin'])
  const repo=createGitRepository({pool:f.runtime,targets:{async resolve(){return{provider:'github',providerRepositoryId:'synthetic-only',branch:'main',credentialRef:'synthetic-unused'}}}})
  const connection=await repo.createConnection(grant,{installationId:knowledge.org,repositoryId,targetId:'synthetic-only',syncMode:'shadow',writeMode:'off'}),keys=[{kind:'claim' as const,id:knowledge.published.claimId}]
  const result=await retainedSourceRead(f.runtime,{installationId:knowledge.org,authorityGrant:grant},async db=>{
   const client=db as pg.PoolClient,lifecycle=await collectGitLifecycleSources(client,knowledge.org,repositoryId,keys)
   // Claim-only export never calls the Skill publication validator.
   return readGitAssets(client,{connection,grant,lifecycle,exportId:randomUUID(),purpose:'local_preview',skill:{} as GitReaderInput['skill']},keys)
  })
  expect(result).toHaveLength(1);expect(result![0].baseVersionId).toBe(knowledge.published.versionId)
  const actual=(await f.runtime.query('SELECT evidence_id::text FROM knowledge_evidence WHERE version_id=$1',[knowledge.published.versionId])).rows.map(row=>row.evidence_id)
  expect(result![0].immutable.evidence.map(evidence=>evidence.evidenceId)).toEqual(actual)
  expect((result![0] as ClaimAsset).serverOnly.evidence.every(evidence=>evidence.sourceEventId===null&&evidence.artifactId===null)).toBe(true)
 })
})
