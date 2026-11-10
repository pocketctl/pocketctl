import type pg from 'pg'
import {randomUUID} from 'node:crypto'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {beforeAll,afterAll,describe,test,expect} from 'vitest'
import {directLaunchFixture,type DirectLaunchFixture} from './direct-launch-fixture.js'
import {gitDbFixture,gitClaimFixture} from '../../testing/phase6-db-fixture.js'
import {createGitRepository} from '../../git-sync/repository.js'
import {createGitProjectSetupService} from '../../git-sync/project-setup.js'
import {createGitCredentialVault} from '../../git-sync/credential-vault.js'
import {createGitRuntime,createGitPollingScheduler} from '../../git-sync/runtime.js'
import {loadGitSyncConfig} from '../../git-sync/config.js'
import {requireImportActor,requireImportQuorum,type GovernedImport} from '../../git-sync/governance-adapter.js'
import type {RegisteredGitBaseContext} from '../../git-sync/export-service.js'
import {createGitSyncWorker} from '../../git-sync/worker.js'
import {loadEffectiveReviewPolicySnapshot} from '../../governance/review-policy.js'
import {createGitInboxService} from '../../git-sync/inbox-service.js'
import type {GitAuthorizationStamp} from '../../git-sync/authorization.js'
const url=process.env.DIRECT_LAUNCH_MEMORY_TEST_DATABASE_URL,suite=url?describe:describe.skip
const secret='synthetic-git-remaining-authority-secret-32',config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'})
suite('Git native authority remaining boundaries',()=>{
 let f:DirectLaunchFixture
 beforeAll(async()=>{f=await directLaunchFixture(url!)},60000)
 afterAll(async()=>{await f?.close()})
 async function fixture(){
  const g=await gitDbFixture(f.runtime),admin=randomUUID(),project=randomUUID(),connection=randomUUID(),owner=await f.source(),other=await f.source()
  await f.runtime.query("UPDATE memory_owner_scopes SET owner_scope_kind='organization' WHERE installation_id=$1",[g.installationId])
  await f.pool.query("INSERT INTO public.extension_organizations(organization_id,name) VALUES($1,'synthetic Git authority')",[g.scopeId])
  await f.pool.query("INSERT INTO public.extension_installations(installation_id,provider_id,owner_scope_kind,owner_scope_id,status,granted_scopes,subscriptions,enabled_services,start_policy) VALUES($1,'pocketctl-memory','organization',$2,'active','{}','{}','{}','from_now')",[g.installationId,g.scopeId])
  for(const [member,user] of [[g.membershipId,owner.owner],[admin,other.owner]]){
   await f.pool.query("INSERT INTO public.extension_scope_memberships(membership_id,scope_kind,scope_id,user_id,roles) VALUES($1,'organization',$2,$3,ARRAY['scope_administrator'])",[member,g.scopeId,user])
  }
  await f.runtime.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['scope_administrator'])",[g.installationId,admin])
  const grant={...g.grant,scopeBindings:g.grant.scopeBindings.map(b=>({...b,owner_scope_kind:'organization' as const,membership_id:admin}))}
  const stamp:GitAuthorizationStamp={installationId:g.installationId,ownerScopeKind:'organization',ownerScopeId:g.scopeId,membershipId:admin,membershipRevision:'1',authorizationEpoch:'1',configVersion:'1'}
  const target={provider:'github',providerRepositoryId:'123',owner:'example',repository:'knowledge',branch:'main',private:true,targetId:'fixture-target',credentialRef:'server-only-secret-ref',scopeMode:'enabled',repositoryUrl:'https://github.com/example/knowledge',membershipRevision:'1',authorizationEpoch:'1',authorizationRevision:randomUUID()}
  await f.runtime.query(`INSERT INTO memory_git_connections(connection_id,installation_id,repository_id,owner_scope_kind,owner_scope_id,provider,provider_repository_id,target_id,target_branch,credential_ref,sync_mode,write_mode)
   VALUES($1,$2,$3,'organization',$4,'github','123','fixture-target','main','server-only-secret-ref','enabled','off')`,[connection,g.installationId,g.repositoryId,g.scopeId])
  await f.runtime.query(`INSERT INTO memory_git_project_targets(installation_id,project_id,connection_id,target,token_cipher,consent_until,authorized_membership_id)
   VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 day',$6)`,[g.installationId,project,connection,target,createGitCredentialVault(secret).seal('SYNTHETIC_ONLY_TOKEN',`${g.installationId}:${project}`),g.membershipId])
  const repo=createGitRepository({pool:f.runtime,targets:{resolve:async()=>null}}),c=(await repo.getConnection(grant,{installationId:g.installationId,connectionId:connection}))!
  const runtime=()=>createGitRuntime({pool:f.runtime,config,globalMode:'enabled',sharedMode:'enabled',vaultSecret:secret,env:{},fetch:async()=>{throw Error('external_provider_forbidden')}})
  const context=(client:RegisteredGitBaseContext['client'],epoch='1')=>({client,connection:c,stamp:{...stamp,authorizationEpoch:epoch},lockedMembershipIds:new Set([g.membershipId,admin])} as unknown as RegisteredGitBaseContext)
  return {...g,admin,grant,stamp,project,connection,c,repo,runtime,context}
 }
 async function revoke(g:Awaited<ReturnType<typeof fixture>>){
  const scopes=await import(pathToFileURL(resolve('../relay/dist/extensions/scope-repository.js')).href)
  await scopes.updateScopeMembership(f.pool,{membershipId:g.membershipId,expectedRevision:1,state:'revoked'})
 }
 async function snapshot(g:Awaited<ReturnType<typeof fixture>>,stamp=g.stamp){
  const exportId=randomUUID(),binding=randomUUID(),claim=await gitClaimFixture(f.runtime,g),client=await f.runtime.connect(),path='.pocketctl/knowledge/claims/synthetic.md',hash='a'.repeat(64)
  try{
   await client.query('BEGIN')
   await client.query(`INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,claim_id,path) VALUES($1,$2,$3,$4,'claim',$5,$6)`,[binding,g.installationId,g.connection,g.repositoryId,claim.claimId,path])
   await client.query(`INSERT INTO memory_git_snapshots(export_id,installation_id,connection_id,generation,base_commit,source_digest,manifest_hash,attestation,asset_count)
    VALUES($1,$2,$3,$4,$5,$6,$6,$7,1)`,[exportId,g.installationId,g.connection,g.c.generation,'a'.repeat(40),hash,Buffer.from('synthetic')])
   await client.query(`INSERT INTO memory_git_snapshot_assets(installation_id,connection_id,export_id,binding_id,kind,claim_id,claim_version_id,path,base_revision,source_digest,content_hash,file_hash,base_document,field_map)
    VALUES($1,$2,$3,$4,'claim',$5,$6,$7,1,$8,$8,$8,'{}','{}')`,[g.installationId,g.connection,exportId,binding,claim.claimId,claim.versionId,path,hash])
   await client.query(`INSERT INTO memory_git_sync_principals(installation_id,connection_id,export_id,generation,membership_id,grant_facts,authorization_stamp)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[g.installationId,g.connection,exportId,g.c.generation,g.admin,g.grant,stamp])
   await client.query('COMMIT')
  }finally{await client.query('ROLLBACK');client.release()}
  return {exportId,...claim}
 }
 async function governed(g:Awaited<ReturnType<typeof fixture>>,epoch='1',memberRevision='1'){
  const snap=await snapshot(g,{...g.stamp,authorizationEpoch:epoch}),proposal=randomUUID(),revision=randomUUID(),run=randomUUID(),hash='a'.repeat(64),client=await f.runtime.connect()
  try{
   await client.query('BEGIN');const policy=await loadEffectiveReviewPolicySnapshot(client,g.installationId,{ensure:true})
   const set=(await client.query('SELECT policy_id FROM memory_review_policy_versions WHERE policy_version_id=$1',[policy.activeVersionId])).rows[0].policy_id
   await client.query(`INSERT INTO memory_git_runs(run_id,installation_id,connection_id,generation,direction,mode,outcome_kind,state,membership_id,membership_revision,authorization_epoch,config_version,request_hash,export_id,grant_facts)
    VALUES($1,$2,$3,$4,'import','enabled','fixture','planned',$5,1,$6,1,$7,$8,$9)`,[run,g.installationId,g.connection,g.c.generation,g.admin,epoch,hash,snap.exportId,g.grant])
   await client.query(`INSERT INTO memory_git_run_receipts(installation_id,connection_id,generation,run_id,request_hash,admission_hash,outcome_kind,state,eligible) VALUES($1,$2,$3,$4,$5,$5,'fixture','planned',true)`,[g.installationId,g.connection,g.c.generation,run,hash])
   await client.query(`INSERT INTO memory_git_merge_receipts(installation_id,connection_id,generation,commit_sha,run_id,tree_sha) VALUES($1,$2,$3,$4,$5,$4)`,[g.installationId,g.connection,g.c.generation,'a'.repeat(40),run])
   await client.query(`INSERT INTO memory_git_import_proposals(proposal_id,installation_id,connection_id,export_id,run_id,generation,base_revision,base_hash,local_hash,proposed_hash,policy_hash,proposed_document,authorization_epoch,head_commit)
    VALUES($1,$2,$3,$4,$5,$6,1,$7,$7,$7,$7,'{}',$8,$9)`,[proposal,g.installationId,g.connection,snap.exportId,run,g.c.generation,hash,epoch,'a'.repeat(40)])
   await client.query(`INSERT INTO memory_git_original_authors(installation_id,connection_id,proposal_id,run_id,provider_actor_id,author_membership_id,author_membership_revision,author_authorization_epoch,head_commit,tree_sha)
    VALUES($1,$2,$3,$4,'synthetic',$5,1,$6,$7,$7)`,[g.installationId,g.connection,proposal,run,g.admin,epoch,'a'.repeat(40)])
   await client.query(`INSERT INTO memory_git_governed_revisions(revision_id,installation_id,connection_id,proposal_id,proposal_revision,base_revision,kind,claim_id,claim_version_id,base_hash,memory_hash,git_hash,proposed_hash,policy_hash,review_policy_id,review_policy_version_id,authorization_epoch,expires_at)
    VALUES($1,$2,$3,$4,1,1,'claim',$5,$6,$7,$7,$7,$7,$7,$8,$9,$10,clock_timestamp()+interval '1 day')`,[revision,g.installationId,g.connection,proposal,snap.claimId,snap.versionId,hash,set,policy.activeVersionId,epoch])
   for(const [member,rev] of [[g.membershipId,memberRevision],[g.admin,'1']])await client.query(`INSERT INTO memory_git_revision_reviews(decision_id,installation_id,revision_id,reviewer_membership_id,reviewer_membership_revision,reviewer_authorization_epoch,decision)
    VALUES($1,$2,$3,$4,$5,$6,'approve')`,[randomUUID(),g.installationId,revision,member,rev,epoch])
   await client.query('COMMIT');return {revisionId:revision,policy,author:null,coauthors:[],countedDecisionIds:[]} as unknown as GovernedImport
  }finally{await client.query('ROLLBACK');client.release()}
 }
 async function quorum(g:Awaited<ReturnType<typeof fixture>>,review:GovernedImport,epoch='1'){
  const client=await f.runtime.connect()
  try{await client.query('BEGIN');await requireImportQuorum(g.context(client,epoch),review,false)}finally{await client.query('ROLLBACK');client.release()}
 }
 // Observe actual PostgreSQL queries without substituting their results or authority.
 function observeQueries(observer:(client:pg.PoolClient,sql:string,values:unknown[]|undefined)=>Promise<void>|undefined){
  const originals=new Map<pg.PoolClient,pg.PoolClient['query']>()
  const acquire=(client:pg.PoolClient)=>{
   const original=client.query;originals.set(client,original)
   client.query=((...args:unknown[])=>{
    const before=typeof args[0]==='string'?observer(client,args[0],args[1] as unknown[]|undefined):undefined
    return before?before.then(()=>Reflect.apply(original,client,args)):Reflect.apply(original,client,args)
   }) as pg.PoolClient['query']
  }
  const release=(_error:Error|undefined,client:pg.PoolClient)=>{const original=originals.get(client);if(original)client.query=original;originals.delete(client)}
  f.runtime.on('acquire',acquire);f.runtime.on('release',release)
  return ()=>{f.runtime.removeListener('acquire',acquire);f.runtime.removeListener('release',release);for(const [client,query]of originals)client.query=query}
 }
 async function waitForLockAndExpiry(pid:number,deadline:Date){
  let waiting=false
  for(let n=0;n<250;n++){
   waiting=(await f.pool.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true
   if(waiting)break
   await new Promise(done=>setTimeout(done,10))
  }
  expect(waiting).toBe(true)
  await f.pool.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))+0.05))",[deadline])
  expect((await f.pool.query('SELECT clock_timestamp()>=$1::timestamptz AS expired',[deadline])).rows[0].expired).toBe(true)
 }
 test.each([['list','member'],['list','consent'],['provider','member'],['provider','consent']] as const)('managed final %s rejects earlier %s expiry while a later target authority check waits',async(boundary,expiry)=>{
  const pair=[await fixture(),await fixture()].sort((a,b)=>a.installationId.localeCompare(b.installationId)),[first,later]=pair
  let providerCalls=0,scans=0,waitPid=0,deadline:Date|undefined,releaseStarted!:()=>void
  const started=new Promise<void>(done=>{releaseStarted=done}),blocker=await f.pool.connect()
  const rt=await createGitRuntime({pool:f.runtime,config,globalMode:'enabled',sharedMode:'enabled',vaultSecret:secret,env:{},fetch:async()=>{providerCalls++;return Response.json({id:123,full_name:'example/knowledge',private:true})}})
  const cap=boundary==='provider'?await rt.reads!.resolve(first.c):null
  if(boundary==='provider')expect(cap).not.toBeNull()
  const cleanup=observeQueries((client,sql)=>{
   if(!sql.startsWith('SELECT p.installation_id,p.project_id,c.repository_id,p.target,p.authorized_membership_id')||++scans!==(boundary==='provider'?3:1))return
   return (async()=>{
    await blocker.query('BEGIN')
    await blocker.query('SELECT 1 FROM memory.memory_installations WHERE installation_id=$1 FOR UPDATE',[later.installationId])
    if(expiry==='member')deadline=(await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE installation_id=$1 AND membership_id=$2 RETURNING valid_until AS deadline",[first.installationId,first.membershipId])).rows[0].deadline
    else deadline=(await f.runtime.query("UPDATE memory_git_project_targets SET consent_until=clock_timestamp()+interval '2 seconds' WHERE installation_id=$1 RETURNING consent_until AS deadline",[first.installationId])).rows[0].deadline
    waitPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    releaseStarted()
   })()
  })
  const pending=boundary==='provider'?cap!.request({operation:'repository'},new AbortController().signal):rt.targets.resolve({installationId:first.installationId,repositoryId:first.repositoryId,targetId:'fixture-target'})
  // Attach a rejection handler before deliberately keeping the request pending.
  const result=pending.then(value=>({value,error:undefined}),error=>({value:undefined,error}))
  try{
   await started;await waitForLockAndExpiry(waitPid,deadline!)
   await blocker.query('COMMIT')
   const outcome=await result
   expect(providerCalls).toBe(0)
   if(boundary==='provider')expect(outcome.error?.message).toBe('read_not_authorized')
   else {expect(outcome.error).toBeUndefined();expect(outcome.value).toBeNull()}
  }finally{await blocker.query('ROLLBACK');blocker.release();await result;cleanup()}
 },15000)
 test('project setup display rejects consent expiry while its original authorizer membership lock waits',async()=>{
  const g=await fixture(),blocker=await f.pool.connect(),service=createGitProjectSetupService({pool:f.runtime,secret})
  let deadline:Date|undefined,waitPid=0,releaseStarted!:()=>void
  const started=new Promise<void>(done=>{releaseStarted=done})
  const cleanup=observeQueries((client,sql)=>{
   if(!sql.startsWith('SELECT c.connection_id,c.repository_id,c.generation::text,c.state,c.target_branch'))return
   return (async()=>{
    deadline=(await f.runtime.query("UPDATE memory_git_project_targets SET consent_until=clock_timestamp()+interval '2 seconds' WHERE installation_id=$1 RETURNING consent_until AS deadline",[g.installationId])).rows[0].deadline
    await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memory.memory_scope_memberships WHERE installation_id=$1 AND membership_id=$2 FOR UPDATE',[g.installationId,g.membershipId])
    waitPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;releaseStarted()
   })()
  })
  const result=service.get({installationId:g.installationId,grant:g.grant},g.project).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
  try{
   await started;await waitForLockAndExpiry(waitPid,deadline!);await blocker.query('COMMIT')
   const outcome=await result;expect(outcome.error).toBeUndefined();expect(outcome.value?.authorized).toBe(false)
  }finally{await blocker.query('ROLLBACK');blocker.release();await result;cleanup()}
 },15000)
 test.each(['member','consent'] as const)('managed credential opening rejects %s expiry after its exact target row lock wait',async expiry=>{
  const g=await fixture(),blocker=await f.pool.connect(),rt=await g.runtime()
  let deadline:Date|undefined,waitPid=0,releaseStarted!:()=>void
  const started=new Promise<void>(done=>{releaseStarted=done})
  const cleanup=observeQueries((client,sql)=>{
   if(!sql.startsWith('SELECT token_cipher,target,authorized_membership_id FROM memory_git_project_targets'))return
   return (async()=>{
    if(expiry==='member')deadline=(await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE installation_id=$1 AND membership_id=$2 RETURNING valid_until AS deadline",[g.installationId,g.membershipId])).rows[0].deadline
    else deadline=(await f.runtime.query("UPDATE memory_git_project_targets SET consent_until=clock_timestamp()+interval '2 seconds' WHERE installation_id=$1 RETURNING consent_until AS deadline",[g.installationId])).rows[0].deadline
    await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memory.memory_git_project_targets WHERE installation_id=$1 FOR UPDATE',[g.installationId])
    waitPid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;releaseStarted()
   })()
  })
  const result=rt.reads!.resolve(g.c).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
  try{
   await started;await waitForLockAndExpiry(waitPid,deadline!);await blocker.query('COMMIT')
   expect((await result).error?.message).toBe('read_not_authorized')
  }finally{await blocker.query('ROLLBACK');blocker.release();await result;cleanup()}
 },15000)
 test('normal native membership revocation bumps epoch and excludes old Git votes',async()=>{
  const g=await fixture(),review=await governed(g);await quorum(g,review)
  await revoke(g)
  expect((await f.pool.query('SELECT authorization_epoch::text FROM public.extension_organizations WHERE organization_id=$1',[g.scopeId])).rows[0].authorization_epoch).toBe('2')
  await expect(quorum(g,review,'2')).rejects.toThrow('git_quorum_failed')
 })
 test('current native reviewer revisions count despite stale mirror revisions',async()=>{
  const g=await fixture()
  await f.pool.query('UPDATE public.extension_scope_memberships SET membership_revision=2 WHERE membership_id=$1',[g.membershipId])
  const review=await governed(g,'1','2');await expect(quorum(g,review)).resolves.toBeUndefined();expect(review.countedDecisionIds).toHaveLength(2)
 })
 test('native reviewer revocation also excludes same-epoch votes when mirror remains active',async()=>{
  const g=await fixture(),review=await governed(g)
  // Deliberately bypass the normal mutation's epoch bump to exercise stored-vote revalidation independently.
  await f.pool.query("UPDATE public.extension_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1",[g.membershipId])
  await expect(quorum(g,review)).rejects.toThrow('git_quorum_failed')
 })
 test('revoked consenting administrator cannot supply managed credentials or appear authorized to a different fresh administrator',async()=>{
  const g=await fixture(),rt=await g.runtime(),cap=await rt.reads!.resolve(g.c);expect(cap).not.toBeNull()
  await revoke(g)
  const grant={...g.grant,scopeBindings:g.grant.scopeBindings.map(b=>({...b,authorization_epoch:'2'}))}
  const shown=await createGitProjectSetupService({pool:f.runtime,secret}).get({installationId:g.installationId,grant},g.project)
  expect(shown?.authorized).toBe(false)
  expect(await rt.reads!.resolve(g.c)).toBeNull()
  await expect(cap!.request({operation:'repository'},new AbortController().signal)).rejects.toThrow('read_not_authorized')
 })
 test('native revocation prevents resolving and using an already resolved managed read without provider HTTP',async()=>{
  const g=await fixture(),rt=await g.runtime(),cap=await rt.reads!.resolve(g.c)
  expect(cap).not.toBeNull();await revoke(g)
  expect(await rt.scopeMode(g.c)).toBe('off');expect(await rt.reads!.resolve(g.c)).toBeNull()
  expect(await rt.recoveryReads!.resolve(g.c)).toBeNull()
  await expect(cap!.request({operation:'repository'},new AbortController().signal)).rejects.toThrow('read_not_authorized')
 })
 test('fresh native consenting admin remains usable while local scope, membership and config caches lag',async()=>{
  const g=await fixture(),rt=await g.runtime()
  await f.pool.query('UPDATE public.extension_organizations SET authorization_epoch=2 WHERE organization_id=$1',[g.scopeId])
  await f.pool.query('UPDATE public.extension_scope_memberships SET membership_revision=2 WHERE membership_id=$1',[g.membershipId])
  await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[g.installationId])
  await f.runtime.query(`UPDATE memory_git_project_targets SET target=target||'{}'::jsonb||jsonb_build_object('membershipRevision','2','authorizationEpoch','2') WHERE installation_id=$1`,[g.installationId])
  const grant={...g.grant,configVersion:'2',scopeBindings:g.grant.scopeBindings.map(b=>({...b,authorization_epoch:'2'}))}
  expect((await createGitProjectSetupService({pool:f.runtime,secret}).get({installationId:g.installationId,grant},g.project))?.authorized).toBe(true)
  expect(await rt.scopeMode(g.c)).toBe('enabled');expect(await rt.reads!.resolve(g.c)).not.toBeNull()
 })
 test.each(['expired-consent','expired-member','dissolved-scope','purged-installation','privacy-tombstone'] as const)('managed credentials remain denied for %s',async kind=>{
  const g=await fixture(),rt=await g.runtime()
  if(kind==='expired-consent')await f.runtime.query("UPDATE memory_git_project_targets SET consent_until=clock_timestamp()-interval '1 second' WHERE installation_id=$1",[g.installationId])
  if(kind==='expired-member')await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE installation_id=$1 AND membership_id=$2",[g.installationId,g.membershipId])
  if(kind==='dissolved-scope')await f.pool.query("UPDATE public.extension_organizations SET state='dissolved' WHERE organization_id=$1",[g.scopeId])
  if(kind==='purged-installation')await f.runtime.query("UPDATE memory_installations SET local_status='purged' WHERE installation_id=$1",[g.installationId])
  if(kind==='privacy-tombstone')await f.runtime.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('organization',$1,1,'synthetic-privacy')",[g.scopeId])
  expect(await rt.reads!.resolve(g.c)).toBeNull();expect(await rt.recoveryReads!.resolve(g.c)).toBeNull()
 })
 test('actor native membership authority remains locked until the physical transaction ends',async()=>{
  const g=await fixture(),reader=await f.runtime.connect(),writer=await f.pool.connect()
  try{
   await reader.query('BEGIN');await requireImportActor(g.context(reader),{membershipId:g.membershipId,membershipRevision:'1',authorizationEpoch:'1'},'contribute')
   await writer.query('BEGIN');await expect(writer.query('SELECT 1 FROM public.extension_scope_memberships WHERE membership_id=$1 FOR UPDATE NOWAIT',[g.membershipId])).rejects.toMatchObject({code:'55P03'})
  }finally{await writer.query('ROLLBACK');writer.release();await reader.query('ROLLBACK');reader.release()}
 })
 test('fresh administrator cannot map a revoked native actor using fresh epoch and stale active mirror',async()=>{
  const g=await fixture();await revoke(g)
  const grant={...g.grant,scopeBindings:g.grant.scopeBindings.map(b=>({...b,authorization_epoch:'2'}))}
  await expect(g.repo.mapActor(grant,{installationId:g.installationId,connectionId:g.connection,expectedGeneration:g.c.generation,providerActorId:'revoked',membershipId:g.membershipId})).rejects.toThrow('git_forbidden')
  expect((await f.runtime.query('SELECT 1 FROM memory_git_actor_mappings WHERE installation_id=$1',[g.installationId])).rowCount).toBe(0)
 })
 test('actor mapping records the current native revision before cache refresh',async()=>{
  const g=await fixture()
  await f.pool.query('UPDATE public.extension_scope_memberships SET membership_revision=2 WHERE membership_id=$1',[g.membershipId])
  await g.repo.mapActor(g.grant,{installationId:g.installationId,connectionId:g.connection,expectedGeneration:g.c.generation,providerActorId:'fresh',membershipId:g.membershipId})
  expect((await f.runtime.query('SELECT membership_revision::text FROM memory_git_actor_mappings WHERE installation_id=$1',[g.installationId])).rows).toEqual([{membership_revision:'2'}])
 })
 test.each(['native-role-removed','local-date-expired'] as const)('import actor respects %s while cached role is active',async kind=>{
  const g=await fixture()
  if(kind==='native-role-removed')await f.pool.query("UPDATE public.extension_scope_memberships SET roles=ARRAY['reader'] WHERE membership_id=$1",[g.membershipId])
  else await f.runtime.query("UPDATE memory_scope_memberships SET valid_until=clock_timestamp()-interval '1 second' WHERE installation_id=$1 AND membership_id=$2",[g.installationId,g.membershipId])
  const client=await f.runtime.connect()
  try{await client.query('BEGIN');await expect(requireImportActor(g.context(client),{membershipId:g.membershipId,membershipRevision:'1',authorizationEpoch:'1'},'contribute')).rejects.toThrow('git_authorization_stale')}
  finally{await client.query('ROLLBACK');client.release()}
 })
 test('import actor with a fresh mapping epoch must still have current native membership',async()=>{
  const g=await fixture();await revoke(g)
  const client=await f.runtime.connect()
  try{await client.query('BEGIN');await expect(requireImportActor(g.context(client,'2'),{membershipId:g.membershipId,membershipRevision:'1',authorizationEpoch:'2'},'contribute')).rejects.toThrow('git_authorization_stale')}
  finally{await client.query('ROLLBACK');client.release()}
 })
 test('fresh native actor revision and roles override stale mirror revision and roles',async()=>{
  const g=await fixture()
  await f.pool.query("UPDATE public.extension_scope_memberships SET membership_revision=2,roles=ARRAY['publisher'] WHERE membership_id=$1",[g.membershipId])
  const client=await f.runtime.connect()
  try{await client.query('BEGIN');await expect(requireImportActor(g.context(client),{membershipId:g.membershipId,membershipRevision:'2',authorizationEpoch:'1'},'publish')).resolves.toBeUndefined()}
  finally{await client.query('ROLLBACK');client.release()}
 })
 test('polling admits a genuinely current native principal despite stale mirror authority',async()=>{
  const g=await fixture(),fresh={...g.stamp,configVersion:'2',membershipRevision:'2',authorizationEpoch:'2'}
  await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[g.installationId])
  await f.pool.query('UPDATE public.extension_organizations SET authorization_epoch=2 WHERE organization_id=$1',[g.scopeId])
  await f.pool.query('UPDATE public.extension_scope_memberships SET membership_revision=2 WHERE membership_id=$1',[g.admin])
  await snapshot(g,fresh)
  await createGitPollingScheduler({pool:f.runtime,config,scopeMode:async()=> 'enabled',signal:new AbortController().signal}).tick()
  expect((await f.runtime.query('SELECT membership_revision::text,authorization_epoch::text,config_version::text FROM memory_git_runs WHERE installation_id=$1',[g.installationId])).rows).toEqual([{membership_revision:'2',authorization_epoch:'2',config_version:'2'}])
 })
 test.each(['unchanged','native-revoked','connection-changed'] as const)('worker cancellation watch uses native authority and actual control fences: %s',async control=>{
  const g=await fixture(),fresh={...g.stamp,configVersion:'2',membershipRevision:'2'}
  await f.pool.query('UPDATE public.extension_installations SET config_version=2 WHERE installation_id=$1',[g.installationId])
  await f.pool.query('UPDATE public.extension_scope_memberships SET membership_revision=2 WHERE membership_id=$1',[g.admin])
  const snap=await snapshot(g,fresh),queued=await createGitInboxService({pool:f.runtime,config,scopeMode:async()=> 'enabled'}).poll({installationId:g.installationId,connectionId:g.connection,exportId:snap.exportId,expectedGeneration:g.c.generation})
  const job=(await f.runtime.query(`UPDATE memory_jobs SET state='running',claimed_by='synthetic-worker',claim_epoch=1,claim_expires_at=clock_timestamp()+interval '30 seconds' WHERE job_id=$1 RETURNING *`,[queued.jobId])).rows[0]
  let aborted=false,attempted=false
  const worker=createGitSyncWorker({pool:f.runtime,config,scopeMode:async()=> 'enabled',reads:{resolve:async()=>({kind:'fixture',target:{provider:'github',providerRepositoryId:'123',branch:'main',origin:'https://api.github.com'},request:async(_input,signal)=>{
   attempted=true
   // The external-I/O boundary must not retain native membership locks.
   const writer=await f.pool.connect()
   try{await writer.query('BEGIN');await writer.query('SELECT 1 FROM public.extension_scope_memberships WHERE membership_id=$1 FOR UPDATE NOWAIT',[g.admin])}finally{await writer.query('ROLLBACK');writer.release()}
   await Promise.all([
    new Promise<void>((done,reject)=>{const timer=setTimeout(done,350);signal.addEventListener('abort',()=>{aborted=true;clearTimeout(timer);reject(Error('request_aborted'))},{once:true})}),
    (async()=>{
     if(control==='unchanged')return
     await new Promise(done=>setTimeout(done,40))
     if(control==='native-revoked')await f.pool.query("UPDATE public.extension_scope_memberships SET state='revoked',membership_revision=3 WHERE membership_id=$1",[g.admin])
     else await f.runtime.query('UPDATE memory_git_connections SET generation=generation+1 WHERE connection_id=$1',[g.connection])
    })(),
   ])
   return {status:200,body:{providerRepositoryId:'123',branch:'main',changes:[],nextCursor:null}}
  }})}})
  await worker.handle(job,new AbortController().signal,{fence:{jobId:queued.jobId,claimedBy:'synthetic-worker',claimEpoch:1}} as never)
  expect(attempted).toBe(true);expect(aborted).toBe(control!=='unchanged')
  expect((await f.runtime.query('SELECT state FROM memory_jobs WHERE job_id=$1',[queued.jobId])).rows[0].state).toBe(control==='unchanged'?'completed':'dead')
 })

})
