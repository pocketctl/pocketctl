import {createHash,randomUUID} from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {insertWikiCandidateFixture} from './helpers/phase4-wiki-fixture.js'
import {createSourceIngestService} from '../codegraph/ingest-service.js'
import {computeManifestHash} from '../codegraph/source-repository.js'
import {createCodeGraphBuildService} from '../codegraph/build-service.js'
import {createCodeGraphReadService} from '../codegraph/read-service.js'
import {registerCodegraphRoutes} from '../api/codegraph-routes.js'
import type {GrantGuard,VerifiedMemoryGrant} from '../auth/grant-guard.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
function file(path:string,content:string) {
 return {path,git_mode:'100644' as const,language:'typescript',capability:'symbols_and_edges' as const,
  blob_sha256:createHash('sha256').update(content).digest('hex'),byte_count:Buffer.byteLength(content),content_base64:Buffer.from(content).toString('base64')}
}
function metadata(entry:ReturnType<typeof file>){const {content_base64,...rest}=entry;return rest}
function manifest(entries:ReturnType<typeof file>[]) {
 return computeManifestHash(entries.map(e=>({path:e.path,gitMode:e.git_mode,language:e.language,capability:e.capability,blobSha256:e.blob_sha256,byteCount:e.byte_count})))
}
suite('Code Graph usage: incremental transfer and repository discovery',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:8});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})
 async function start(installationId:string,entries:ReturnType<typeof file>[],commit:string,key='example/code') {
  const input={installationId,repository:{repository_key:key},gitObjectFormat:'sha1',commitSha:commit.repeat(40),manifestSha256:manifest(entries),
   expectedFileCount:entries.length,expectedByteCount:entries.reduce((n,e)=>n+e.byte_count,0),idempotencyKey:randomUUID(),selection:{partial:true,include_paths:['src']}}
  return {...input,...await createSourceIngestService(pool).startSnapshot(input)}
 }
 async function publish(input:Awaited<ReturnType<typeof start>>) {
  await createSourceIngestService(pool).finalizeSnapshot({...input,idempotencyKey:randomUUID()})
  const job=(await pool.query("UPDATE memory_jobs SET state='running',claimed_by='usage-test',claim_epoch=1,claim_expires_at=NOW()+interval '1 minute' WHERE payload->>'snapshot_id'=$1 RETURNING *",[input.snapshotId])).rows[0]
  await createCodeGraphBuildService({pool,mode:'enabled'}).handleParseCodeSnapshot({...job,attempts:1},new AbortController().signal,
   {fence:{jobId:job.job_id,claimedBy:'usage-test',claimEpoch:1}})
 }
 test('changed/deleted files retain a complete manifest; empty snapshot clears the final graph',async()=>{
  const f=await insertWikiCandidateFixture(pool,'incremental'),service=createSourceIngestService(pool)
  const a=file('src/a.ts','export const a=1'),b=file('src/b.ts','export const b=1'),deleted=file('src/deleted.ts','export const gone=1')
  const first=await start(f.installationId,[a,b,deleted],'a')
  expect((await service.registerManifest({...first,entries:[a,b,deleted].map(metadata)})).missing_paths).toHaveLength(3)
  await service.uploadBatch({...first,batchIndex:0,entries:[a,b,deleted]});await publish(first)
  expect((await service.startSnapshot(first)).state).toBe('active')
  const changed=file('src/b.ts','export const b=2'),second=await start(f.installationId,[a,changed],'b')
  expect(await service.registerManifest({...second,entries:[a,changed].map(metadata)})).toEqual({missing_paths:['src/b.ts']})
  await expect(service.finalizeSnapshot({...second,idempotencyKey:randomUUID()})).rejects.toThrow('manifest_mismatch')
  await service.uploadBatch({...second,batchIndex:0,batchKey:'d'.repeat(64),entries:[changed]})
  await expect(service.uploadBatch({...second,batchIndex:7,batchKey:'d'.repeat(64),entries:[changed]})).resolves.toMatchObject({accepted:1})
  expect(await service.registerManifest({...second,entries:[a,changed].map(metadata)})).toEqual({missing_paths:[]})
  await publish(second)
  const graph=await createCodeGraphReadService(pool,'test').getGraph({installationId:f.installationId,repositoryId:second.repositoryId,limit:100})
  expect(graph?.commit_sha).toBe('b'.repeat(40));expect(graph?.coverage).toBe('partial')
  expect(graph?.nodes.some(n=>n.path==='src/deleted.ts')).toBe(false)
  expect(graph?.nodes.some(n=>n.path==='src/a.ts')).toBe(true)
  const impact=await createCodeGraphReadService(pool,'test').analyzeImpact({...second,entryPaths:['src/a.ts']})
  expect(impact?.coverage).toBe('partial');expect(impact?.reasons).toContain('source_graph_partial')
  expect((await service.repository.listEntries(second)).map(e=>e.path)).toEqual(['src/a.ts','src/b.ts'])
  const empty=await start(f.installationId,[],'c');await publish(empty)
  expect((await createCodeGraphReadService(pool,'test').getGraph({...empty,limit:100}))?.nodes).toEqual([])
 })
 test('reuse is bounded by repository/installation and hash integrity',async()=>{
  const a=await insertWikiCandidateFixture(pool,'a'),b=await insertWikiCandidateFixture(pool,'b'),service=createSourceIngestService(pool)
  const entry=file('src/a.ts','export const a=1'),first=await start(a.installationId,[entry],'a')
  await service.uploadBatch({...first,batchIndex:0,entries:[entry]})
  const otherRepo=await start(a.installationId,[entry],'b','other/repo'),otherScope=await start(b.installationId,[entry],'a')
  for(const input of [otherRepo,otherScope])expect(await service.registerManifest({...input,entries:[metadata(entry)]})).toEqual({missing_paths:['src/a.ts']})
  await expect(service.registerManifest({...first,entries:[{...metadata(entry),byte_count:1}]})).rejects.toThrow('integrity_mismatch')
  await pool.query("UPDATE memory_source_blobs SET utf8_content='tampered' WHERE installation_id=$1 AND blob_hash=$2",[a.installationId,entry.blob_sha256])
  await expect(service.registerManifest({...first,entries:[metadata(entry)]})).rejects.toThrow('integrity_mismatch')
 })
 test('manifest reuse rechecks current authority before writing',async()=>{
  const f=await insertWikiCandidateFixture(pool,'revoked'),service=createSourceIngestService(pool),entry=file('src/a.ts','export const a=1')
  const source=await start(f.installationId,[entry],'a')
  await pool.query('UPDATE memory_installations SET config_version=2 WHERE installation_id=$1',[f.installationId])
  await expect(service.registerManifest({...source,grant:f.grant,entries:[metadata(entry)]})).rejects.toThrow()
  expect(await service.repository.listEntries(source)).toEqual([])
 })
 test('shared membership revocation blocks retained-body reuse',async()=>{
  const f=await insertWikiCandidateFixture(pool,'shared-revoked'),member=randomUUID(),entry=file('src/a.ts','export const a=1')
  const source=await start(f.installationId,[entry],'a')
  await pool.query("UPDATE memory_owner_scopes SET owner_scope_kind='team' WHERE installation_id=$1",[f.installationId])
  await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision) VALUES($1,$2,ARRAY['scope_administrator'],'active',1)",[f.installationId,member])
  Object.assign(f.grant.scopeBindings[0],{owner_scope_kind:'team',membership_id:member,membership_revision:'1'})
  await pool.query("UPDATE memory_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1",[member])
  await expect(createSourceIngestService(pool).registerManifest({...source,grant:f.grant,entries:[metadata(entry)]})).rejects.toThrow()
 })
 test('catalog isolates scopes, supports pagination and rejects stale authority',async()=>{
  const a=await insertWikiCandidateFixture(pool,'catalog-a'),b=await insertWikiCandidateFixture(pool,'catalog-b')
  await start(a.installationId,[file('src/a.ts','export const a=1')],'a')
  const grant={...a.grant,version:'v2',installationId:a.installationId} as unknown as VerifiedMemoryGrant
  const app=Fastify();registerCodegraphRoutes(app,{pool,guard:{guardMcp:async()=>grant} as unknown as GrantGuard,codegraphMode:'enabled',cursorSigningKey:'usage'})
  try{
   const page=await app.inject('/api/v1/memory/codegraph/repositories?limit=1')
   expect(page.statusCode).toBe(200);expect(page.json().repositories).toHaveLength(1);expect(page.json().next_cursor).toBeTruthy()
   const next=await app.inject('/api/v1/memory/codegraph/repositories?limit=1&after='+page.json().next_cursor)
   expect(next.statusCode).toBe(200);expect(next.json().repositories[0].repository_id).not.toBe(page.json().repositories[0].repository_id)
   expect((await app.inject('/api/v1/memory/codegraph/repositories?repository_id='+b.repositoryId)).json().repositories).toEqual([])
   await pool.query('UPDATE memory_installations SET config_version=2 WHERE installation_id=$1',[a.installationId])
   expect((await app.inject('/api/v1/memory/codegraph/repositories')).statusCode).toBe(403)
  }finally{await app.close()}
 })
 test('REST negotiation requires the feature gate and strict metadata',async()=>{
  const f=await insertWikiCandidateFixture(pool,'gated'),entry=file('src/a.ts','export const a=1'),source=await start(f.installationId,[entry],'a')
  const grant={...f.grant,version:'v2',installationId:f.installationId} as unknown as VerifiedMemoryGrant
  for(const mode of ['off','enabled'] as const){
   const app=Fastify();registerCodegraphRoutes(app,{pool,guard:{guardMcp:async()=>grant} as unknown as GrantGuard,codegraphMode:mode,sharedScopesMode:'enabled',cursorSigningKey:'usage'})
   try{
    const response=await app.inject({method:'POST',url:`/api/v1/memory/code-snapshots/${source.snapshotId}/manifest`,payload:{entries:[{...metadata(entry),content_base64:'not allowed'}]}})
    expect(response.statusCode).toBe(mode==='off'?503:400)
   }finally{await app.close()}
  }
 })
})
