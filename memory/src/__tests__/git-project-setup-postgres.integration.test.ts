import pg from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { afterAll,beforeAll,beforeEach,describe,expect,test,vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { gitDbFixture } from '../testing/phase6-db-fixture.js'
import { createGitProjectSetupService,parseProjectRepository } from '../git-sync/project-setup.js'
import { createGitRuntime } from '../git-sync/runtime.js'
import { createGitRepository } from '../git-sync/repository.js'
import { loadGitSyncConfig } from '../git-sync/config.js'
import { createGitCredentialVault } from '../git-sync/credential-vault.js'
import { gitBundleZip } from '../git-sync/zip-bundle.js'
import { gitExportFixture } from '../testing/phase6-export-fixture.js'
import { createGitExportService } from '../git-sync/export-service.js'
import { createGitReadService } from '../git-sync/read-service.js'
import { registerGitRoutes } from '../api/git-routes.js'
import { createCorsHostPolicy } from '../auth/cors-host-policy.js'
import { changeMetadata } from '../testing/phase6-fixtures.js'
import { createGitInboxService } from '../git-sync/inbox-service.js'
import { createGitSyncWorker } from '../git-sync/worker.js'
import { createJobRepository } from '../jobs/repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const db=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const secret='local-managed-git-test-secret-32-bytes-minimum',token='TEST_ONLY_PROVIDER_TOKEN'
db('Self-service Git project setup',()=>{
  let pool:pg.Pool
  beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60_000)
  beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
  afterAll(async()=>{await pool?.end()})
  const provider=vi.fn(async(raw:unknown,init?:RequestInit)=>{
    const u=new URL(String(raw));expect(u.origin).toBe('https://api.github.com');expect(init?.method).toBe('GET');expect(init?.redirect).toBe('error')
    if(u.pathname==='/user')return Response.json({id:1234})
    if(u.pathname.endsWith('/branches/main'))return Response.json({name:'main',commit:{sha:'a'.repeat(40)}})
    if(u.pathname.endsWith('/pulls'))return Response.json([])
    return Response.json({id:123,full_name:'example/knowledge',private:true})
  })
  const setup=()=>createGitProjectSetupService({pool,secret,fetch:provider as typeof fetch})
  const input=()=>({project_id:randomUUID(),repository_url:'https://github.com/example/knowledge',branch:'main',access_token:token,read_consent:true,expected_generation:null})
  async function fixture(){const f=await gitDbFixture(pool);return {...f,id:{installationId:f.installationId,grant:f.grant},input:input()}}
  async function runtime(){return createGitRuntime({pool,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),globalMode:'enabled',sharedMode:'enabled',vaultSecret:secret,env:{},fetch:provider as typeof fetch})}
  test('verifies and persists an encrypted credential, maps its own identity, and supplies the live runtime',async()=>{
    const f=await fixture(),project=await setup().connect(f.id,f.input,'first')
    expect(project).toMatchObject({authorized:true,state:'active',target_branch:'main'})
    const row=(await pool.query('SELECT * FROM memory_git_project_targets WHERE installation_id=$1',[f.installationId])).rows[0]
    expect(row.token_cipher.toString()).not.toContain(token)
    expect(JSON.stringify(project)).not.toContain(token)
    expect(createGitCredentialVault(secret).open(row.token_cipher,`${f.installationId}:${f.input.project_id}`)).toBe(token)
    const rt=await runtime(),c=await createGitRepository({pool,targets:rt.targets}).getConnection(f.grant,{installationId:f.installationId,connectionId:project!.connection_id})
    expect(await rt.scopeMode(c!)).toBe('enabled');const capability=await rt.reads!.resolve(c!);expect(capability).not.toBeNull()
    await capability!.request({operation:'repository'},new AbortController().signal)
    expect((await pool.query('SELECT provider_actor_id,membership_id FROM memory_git_actor_mappings WHERE installation_id=$1',[f.installationId])).rows[0]).toMatchObject({provider_actor_id:'1234',membership_id:f.membershipId})
  })
  test('concurrent original requests create one connection; replays after revocation do not reactivate it',async()=>{
    const f=await fixture(),service=setup()
    const results=await Promise.all(Array.from({length:4},()=>service.connect(f.id,f.input,'same')))
    expect(new Set(results.map(r=>r!.connection_id)).size).toBe(1)
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_connections WHERE installation_id=$1',[f.installationId])).rows[0].n).toBe(1)
    await service.disconnect(f.id,f.input.project_id,results[0]!.generation)
    expect((await service.connect(f.id,f.input,'same'))!.authorized).toBe(false)
    await expect(service.connect(f.id,{...f.input,access_token:'DIFFERENT'},'same')).rejects.toMatchObject({code:'conflict'})
    expect((await pool.query('SELECT token_cipher FROM memory_git_project_targets WHERE installation_id=$1',[f.installationId])).rows[0].token_cipher).toBeNull()
  })
  test('permission loss or consent expiry stops already-resolved capabilities before another HTTP request',async()=>{
    const f=await fixture(),project=await setup().connect(f.id,f.input,'first'),rt=await runtime()
    const c=(await createGitRepository({pool,targets:rt.targets}).getConnection(f.grant,{installationId:f.installationId,connectionId:project!.connection_id}))!
    const cap=(await rt.reads!.resolve(c))!;expect(cap).not.toBeNull()
    const withLegacy=await createGitRuntime({pool,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),globalMode:'enabled',sharedMode:'enabled',vaultSecret:secret,
      env:{MEMORY_GIT_TARGET_REGISTRY_PATH:'/fixture/registry',MEMORY_GIT_READ_CONSENT_FILE:'/fixture/consent'},
      readFile:async path=>Buffer.from(JSON.stringify(path.endsWith('/registry')?{targets:[{installationId:c.installationId,repositoryId:c.repositoryId,targetId:'old-file-target',credentialRef:'old-file-ref',credentialFile:'/fixture/token',provider:'github',providerRepositoryId:'123',owner:'example',repository:'knowledge',branch:'main',private:true,scopeMode:'enabled'}]}:
        {consents:[{installationId:c.installationId,connectionId:c.connectionId,providerRepositoryId:'123',branch:'main',consentId:randomUUID(),permission:'read',expiresAt:'2099-01-01T00:00:00Z'}]}))})
    expect(await withLegacy.scopeMode(c)).toBe('enabled')
    await pool.query(`UPDATE memory_git_project_targets SET consent_until=NOW()-interval '1 second' WHERE installation_id=$1`,[f.installationId])
    expect(await withLegacy.scopeMode(c)).toBe('off');expect(await withLegacy.reads!.resolve(c)).toBeNull()
    const before=provider.mock.calls.length
    await expect(cap.request({operation:'repository'},new AbortController().signal)).rejects.toThrow('read_not_authorized')
    expect(provider.mock.calls.length).toBe(before)
    await pool.query(`UPDATE memory_git_project_targets SET consent_until=NOW()+interval '1 day' WHERE installation_id=$1`,[f.installationId])
    await pool.query(`UPDATE memory_scope_memberships SET state='revoked' WHERE installation_id=$1`,[f.installationId])
    expect(await rt.reads!.resolve(c)).toBeNull()
  })
  test('unprivileged callers cannot issue provider reads; invalid targets never leave the service',async()=>{
    const f=await gitDbFixture(pool,['reader']),id={installationId:f.installationId,grant:f.grant},before=provider.mock.calls.length
    await expect(setup().connect(id,input(),'forbidden')).rejects.toThrow('git_forbidden')
    expect(provider.mock.calls.length).toBe(before)
    for(const value of ['http://127.0.0.1/evil','https://github.com/example/knowledge?token=x','https://secret@github.com/a/b'])expect(()=>parseProjectRepository(value)).toThrow()
  })
  test('a missing server decryption key fails with an operational error and never saves a token or connection',async()=>{
    const first=await fixture();await setup().connect(first.id,first.input,'ensure-key')
    const f=await fixture(),wrong=createGitProjectSetupService({pool,secret:'a-different-server-key-with-at-least-32-bytes',fetch:provider as typeof fetch})
    await expect(wrong.connect(f.id,f.input,'wrong-key')).rejects.toMatchObject({code:'credential_store_unavailable'})
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_connections WHERE installation_id=$1',[f.installationId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS n FROM memory_git_project_targets WHERE installation_id=$1',[f.installationId])).rows[0].n).toBe(0)
  })
  test('a contributor can prove only their own Git identity without saving their token or taking another identity',async()=>{
    const f=await fixture(),connected=(await setup().connect(f.id,f.input,'first'))!,member=randomUUID()
    await pool.query(`INSERT INTO memory_scope_memberships(installation_id,membership_id,roles) VALUES($1,$2,ARRAY['contributor'])`,[f.installationId,member])
    const grant={...f.grant,scopeBindings:f.grant.scopeBindings.map(b=>({...b,membership_id:member,permissions:['read','contribute']}))},id={installationId:f.installationId,grant}
    const before=(await pool.query(`SELECT token_cipher FROM memory_git_project_targets WHERE installation_id=$1`,[f.installationId])).rows[0].token_cipher
    const service=createGitProjectSetupService({pool,secret,fetch:async()=>Response.json({id:5678})})
    const request={access_token:'ONE_TIME_IDENTITY_TOKEN',expected_generation:connected.generation}
    const linked=await service.linkIdentity(id,f.input.project_id,request,'identity-key')
    expect(linked!.generation).not.toBe(connected.generation)
    expect((await pool.query(`SELECT token_cipher FROM memory_git_project_targets WHERE installation_id=$1`,[f.installationId])).rows[0].token_cipher).toEqual(before)
    expect((await pool.query(`SELECT membership_id FROM memory_git_actor_mappings WHERE installation_id=$1 AND provider_actor_id='5678'`,[f.installationId])).rows[0].membership_id).toBe(member)
    expect((await service.linkIdentity(id,f.input.project_id,request,'identity-key'))!.generation).toBe(linked!.generation)
    await expect(setup().linkIdentity(id,f.input.project_id,{access_token:'OTHER',expected_generation:linked!.generation},'steal')).rejects.toMatchObject({code:'conflict'})
  })
  test('reuses an existing canonical repository and exports all four published asset kinds as a signed ZIP',async()=>{
    const f=await gitExportFixture(pool)
    await pool.query('DELETE FROM memory_git_connections WHERE installation_id=$1',[f.installationId])
    await pool.query(`UPDATE repositories SET canonical_remote='https://github.com/example/knowledge' WHERE installation_id=$1 AND repository_id=$2`,[f.installationId,f.repositoryId])
    const i=input(),id={installationId:f.installationId,grant:f.grant},project=(await setup().connect(id,i,'existing'))!,rt=await runtime()
    expect(project.repository_id).toBe(f.repositoryId)
    const deps={pool,config:loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),targets:rt.targets,keys:rt.keys!,scopeMode:rt.scopeMode,skill:{context:f.skill.context,cases:f.skill.cases}}
    const assets=await createGitReadService(deps).assets(id,project.connection_id)
    expect(assets.items.map(a=>a.kind).sort()).toEqual(['claim','rule','skill','wiki'])
    const bundle=await createGitExportService(deps).export(f.grant,{installationId:f.installationId,connectionId:project.connection_id,expectedGeneration:project.generation,baseCommit:'a'.repeat(40),purpose:'external_export',assets:f.keys})
    expect(bundle.publishable).toBe(true);expect(bundle.assets).toHaveLength(4)
    const archive=gitBundleZip(bundle.files);expect(archive.readUInt32LE()).toBe(0x04034b50)
    expect(archive.toString()).not.toContain(token)
    const restored=await createGitExportService(deps).loadRegisteredBase(f.grant,{installationId:f.installationId,connectionId:project.connection_id,expectedGeneration:project.generation,exportId:bundle.exportId})
    expect(restored.attestation).toEqual(bundle.attestation)
  })
  test('real REST setup and export flow imports an exact signed-tree edit, requires independent review, then applies it',async()=>{
    const f=await gitExportFixture(pool)
    await pool.query('DELETE FROM memory_git_connections WHERE installation_id=$1',[f.installationId])
    await pool.query(`UPDATE repositories SET canonical_remote='https://github.com/example/knowledge' WHERE repository_id=$1`,[f.repositoryId])
    let exported:any,files:Array<{path:string;mode:'100644';bytes:Uint8Array}>=[]
    const merge='b'.repeat(40),tree='c'.repeat(40),head='d'.repeat(40)
    const blob=(bytes:Uint8Array)=>createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
    const fetcher:typeof fetch=async(raw,init)=>{
      const path=new URL(String(raw)).pathname
      const repo={id:123,full_name:'example/knowledge',private:true}
      if(path.endsWith('/pulls/7'))return Response.json({number:7,merged:true,merge_commit_sha:merge,head:{ref:`pocketctl/export/${exported.export_id}`,sha:head,repo},base:{ref:'main',repo},user:{id:9999},merged_by:{id:8888}})
      if(path.endsWith(`/git/commits/${merge}`))return Response.json({sha:merge,tree:{sha:tree},parents:[{sha:'a'.repeat(40)},{sha:head}]})
      if(path.endsWith(`/commits/${head}`))return Response.json({sha:head,author:{id:1234},committer:{id:1234},commit:{tree:{sha:tree},author:{email:'fixture@example.test'},committer:{email:'fixture@example.test'},verification:{verified:true,reason:'valid',signature:'fixture-only',payload:`tree ${tree}\nfixture`}}})
      if(path.endsWith(`/git/trees/${tree}`))return Response.json({sha:tree,truncated:false,tree:files.map(f=>({path:f.path,type:'blob',mode:f.mode,sha:blob(f.bytes),size:f.bytes.byteLength}))})
      if(path.includes('/git/blobs/')){const file=files.find(f=>path.endsWith(blob(f.bytes)))!;return Response.json({sha:blob(file.bytes),encoding:'base64',size:file.bytes.byteLength,content:Buffer.from(file.bytes).toString('base64')})}
      return provider(raw,init)
    }
    const config=loadGitSyncConfig({MEMORY_GIT_SYNC_MODE:'enabled'}),rt=await createGitRuntime({pool,config,globalMode:'enabled',sharedMode:'enabled',vaultSecret:secret,env:{},fetch:fetcher})
    const deps={pool,config,...rt,keys:rt.keys!,skill:{context:f.skill.context,cases:f.skill.cases}}
    let actor=f.grant
    const app=Fastify()
    registerGitRoutes(app,{...deps,projectSetup:createGitProjectSetupService({pool,secret,fetch:fetcher}),policy:createCorsHostPolicy({allowedOrigins:[],allowedHosts:['localhost'],isProduction:false}),
      guard:{guardMcp:async()=>({...actor,version:'v2',installationId:f.installationId})} as never})
    try{
      const i=input(),created=await app.inject({method:'POST',url:`/api/v1/memory/git/projects/${i.project_id}/connect`,headers:{'idempotency-key':'rest-connect'},payload:i})
      expect(created.statusCode,created.body).toBe(200);const c=created.json().project
      const local=await app.inject({method:'POST',url:`/api/v1/memory/git/connections/${c.connection_id}/previews`,headers:{'idempotency-key':'rest-local-preview'},payload:{expected_generation:c.generation,assets:[{kind:'rule',id:f.rule.claimId}],reason_code:'manual_preview'}})
      expect(local.statusCode,local.body).toBe(200)
      const rejected=await app.inject({url:`/api/v1/memory/git/exports/${local.json().export_id}/bundle`})
      expect(rejected.statusCode,rejected.body).toBe(409);expect(rejected.json().error.code).toBe('external_export_required')
      const saved=await app.inject({method:'POST',url:`/api/v1/memory/git/connections/${c.connection_id}/exports`,headers:{'idempotency-key':'rest-export'},payload:{expected_generation:c.generation,assets:[{kind:'rule',id:f.rule.claimId}],reason_code:'manual_preview'}})
      expect(saved.statusCode,saved.body).toBe(200);exported=saved.json()
      const archive=await app.inject({url:`/api/v1/memory/git/exports/${exported.export_id}/bundle`})
      expect(archive.statusCode,archive.body).toBe(200);expect(archive.json().publishable).toBe(true)
      const bundle=await createGitExportService(deps).loadRegisteredBase(f.grant,{installationId:f.installationId,connectionId:c.connection_id,expectedGeneration:c.generation,exportId:exported.export_id})
      files=bundle.files.map(file=>file.path.endsWith('/manifest.yaml')?file:changeMetadata([file],v=>{if(v.key?.kind==='rule')v.editable.statement='Signed provider edit'})[0])
      const subject={installationId:f.installationId,connectionId:c.connection_id,exportId:exported.export_id,expectedGeneration:c.generation},inbox=createGitInboxService(deps)
      const enrolled=await app.inject({method:'POST',url:`/api/v1/memory/git/connections/${c.connection_id}/sync`,headers:{'idempotency-key':'rest-enroll'},payload:{expected_generation:c.generation,export_id:exported.export_id,action:'enroll'}})
      expect(enrolled.statusCode,enrolled.body).toBe(200)
      await inbox.receive(subject,{source:'webhook',eventId:'synthetic-verified-change',changeNumber:'7'})
      const [job]=await createJobRepository(pool).claimJobs({workerId:'managed-git-test',limit:1,leaseMs:30_000})
      await createGitSyncWorker(deps).handle(job,new AbortController().signal,{fence:{jobId:job.job_id,claimedBy:'managed-git-test',claimEpoch:job.claim_epoch}})
      const proposal=(await pool.query(`SELECT proposal_id,state,provider_actor_id FROM memory_git_import_proposals WHERE installation_id=$1`,[f.installationId])).rows[0]
      expect(proposal).toMatchObject({state:'awaiting_review',provider_actor_id:'1234'})
      const detail=(await app.inject({url:`/api/v1/memory/git/proposals/${proposal.proposal_id}`})).json()
      const expected={expected_generation:detail.generation,expected_revision:detail.revision,expected_policy_hash:detail.policy_hash,expected_proposed_hash:detail.proposed_hash,expected_asset_revision:detail.expected_asset_revision}
      actor=f.skill.reviewer.grant
      const review=await app.inject({method:'POST',url:`/api/v1/memory/git/proposals/${proposal.proposal_id}/reviews`,headers:{'idempotency-key':'rest-review'},payload:{...expected,decision:'approve'}})
      expect(review.statusCode,review.body).toBe(200)
      actor=f.skill.publisher.grant
      const applied=await app.inject({method:'POST',url:`/api/v1/memory/git/proposals/${proposal.proposal_id}/apply`,headers:{'idempotency-key':'rest-apply'},payload:expected})
      expect(applied.statusCode,applied.body).toBe(200)
      expect((await pool.query(`SELECT v.statement FROM knowledge_claims k JOIN knowledge_versions v ON v.version_id=k.current_version_id WHERE k.claim_id=$1`,[f.rule.claimId])).rows[0].statement).toBe('Signed provider edit')
    }finally{await app.close()}
  })
})
