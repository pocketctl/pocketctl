import {createHash,randomUUID} from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import type {GrantGuard,VerifiedMemoryGrant} from '../auth/grant-guard.js'
import {registerCodegraphRoutes} from '../api/codegraph-routes.js'
import {registerWikiRoutes} from '../api/wiki-routes.js'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {insertWikiCandidateFixture} from './helpers/phase4-wiki-fixture.js'
import {createSourceIngestService} from '../codegraph/ingest-service.js'
import {createCodeGraphBuildService} from '../codegraph/build-service.js'
import {createPurgeRepository} from '../purge/repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
function barrier(){let reach!:()=>void,release!:()=>void;return {reached:new Promise<void>(r=>{reach=r}),allowed:new Promise<void>(r=>{release=r}),reach:()=>reach(),release:()=>release()}}
function tapped(pool:pg.Pool,hook:(sql:string,client:pg.PoolClient,params:unknown[])=>Promise<void>,pid?:(id:number)=>void):pg.Pool{
 const wrap=(client:pg.PoolClient)=>new Proxy(client,{get(target,key){
  if(key==='query')return async(sql:string,...args:unknown[])=>{const result=await Reflect.apply(target.query,target,[sql,...args]);await hook(sql,target,(args[0]??[]) as unknown[]);return result}
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
 }})
 return {query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();pid?.((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);return wrap(client)}} as unknown as pg.Pool
}
const outcome=<T>(p:Promise<T>)=>p.then(value=>({value}),error=>({error}))
async function blocked(pool:pg.Pool,pid:()=>number|undefined){for(let n=0;n<150;n++){const id=pid();if(id&&(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[id])).rows[0].blocked)return true;await new Promise(r=>setTimeout(r,10))}return false}
function file(path='src/new.ts',content='export const newlyBuilt = 1;\n'){
 const sha=createHash('sha256').update(content).digest('hex'),bytes=Buffer.byteLength(content)
 return {path,git_mode:'100644',language:'typescript',capability:'symbols_and_edges',blob_sha256:sha,byte_count:bytes,content_base64:Buffer.from(content).toString('base64')}
}
function startInput(installationId:string,key:string,entry=file()){
 const manifest=createHash('sha256').update(`${entry.path}\t100644\ttypescript\tsymbols_and_edges\t${entry.blob_sha256}\t${entry.byte_count}\n`).digest('hex')
 return {installationId,repository:{repository_key:key},gitObjectFormat:'sha1',commitSha:'a'.repeat(40),manifestSha256:manifest,expectedFileCount:1,expectedByteCount:entry.byte_count,idempotencyKey:'start-new'}
}
async function ready(pool:pg.Pool,f:Awaited<ReturnType<typeof insertWikiCandidateFixture>>){
 const ingest=createSourceIngestService(pool),entry=file(),input=startInput(f.installationId,'placeholder')
 // The existing repository key is taken from its current registry row.
 input.repository.repository_key=(await pool.query('SELECT repository_key FROM repositories WHERE repository_id=$1',[f.repositoryId])).rows[0].repository_key
 const source=await ingest.startSnapshot(input)
 await ingest.uploadBatch({installationId:f.installationId,snapshotId:source.snapshotId,batchIndex:0,entries:[entry]})
 await ingest.finalizeSnapshot({...input,snapshotId:source.snapshotId,idempotencyKey:'finalize-new'})
 const job=(await pool.query("UPDATE memory_jobs SET state='running',claimed_by='c1-worker',claim_epoch=1,claim_expires_at=NOW()+interval '1 minute' WHERE payload->>'snapshot_id'=$1 RETURNING *",[source.snapshotId])).rows[0]
 return {input,entry,source,job,fence:{jobId:job.job_id,claimedBy:'c1-worker',claimEpoch:1}}
}
suite('C1 snapshot commit authority and lifecycle serialization',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:12});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool.end()})
 test.each(['revoked','purged','config_changed','expired'] as const)('start rejects current %s authority before writing a receipt',async cause=>{
  const f=await insertWikiCandidateFixture(pool,'start-'+cause)
  const grant={...f.grant,expiresAt:cause==='expired'?Date.now()/1000-1:Date.now()/1000+60}
  if(cause==='revoked')await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.installationId])
  if(cause==='purged')await pool.query("UPDATE memory_installations SET local_status='purged' WHERE installation_id=$1",[f.installationId])
  if(cause==='config_changed')await pool.query('UPDATE memory_installations SET config_version=2 WHERE installation_id=$1',[f.installationId])
  await expect(createSourceIngestService(pool).startSnapshot(Object.assign(startInput(f.installationId,'new-repository'),{grant}))).rejects.toThrow()
  expect((await pool.query('SELECT 1 FROM memory_idempotency_keys')).rowCount).toBe(0)
  expect((await pool.query("SELECT 1 FROM repositories WHERE repository_key='new-repository'")).rowCount).toBe(0)
 })
 test('trusted ingress still rejects a purged installation',async()=>{
  const f=await insertWikiCandidateFixture(pool,'trusted')
  await createPurgeRepository(pool,{hmacKey:'c1'}).purgeInstallation({installationId:f.installationId,requestId:randomUUID(),reason:'user_delete'})
  await expect(createSourceIngestService(pool).startSnapshot(startInput(f.installationId,'new-repository'))).rejects.toThrow()
  expect((await pool.query('SELECT 1 FROM memory_source_snapshots')).rowCount).toBe(0)
 })
 test.each(['upload','finalize','abort','replay'] as const)('%s rechecks the actual foreground Grant after membership removal',async phase=>{
  const f=await insertWikiCandidateFixture(pool,'membership-'+phase),member=randomUUID(),ingest=createSourceIngestService(pool),entry=file()
  await pool.query("UPDATE memory_owner_scopes SET owner_scope_kind='team' WHERE installation_id=$1",[f.installationId])
  await pool.query("INSERT INTO memory_scope_memberships(installation_id,membership_id,roles,state,membership_revision) VALUES($1,$2,ARRAY['scope_administrator'],'active',1)",[f.installationId,member])
  Object.assign(f.grant.scopeBindings[0],{owner_scope_kind:'team',membership_id:member,membership_revision:'1'})
  const input=startInput(f.installationId,'new-repository')
  const started=await ingest.startSnapshot(input)
  await ingest.uploadBatch({installationId:f.installationId,snapshotId:started.snapshotId,batchIndex:0,entries:[entry]})
  await pool.query("UPDATE memory_scope_memberships SET state='revoked',membership_revision=2 WHERE membership_id=$1",[member])
  const withGrant={installationId:f.installationId,snapshotId:started.snapshotId,grant:f.grant}
  const pending=phase==='upload'?ingest.uploadBatch({...withGrant,batchIndex:1,entries:[file('extra.ts')]})
   :phase==='finalize'?ingest.finalizeSnapshot({...input,...withGrant,idempotencyKey:'finalize-new'})
   :phase==='abort'?ingest.abortSnapshot(withGrant):ingest.startSnapshot(Object.assign({...input},{grant:f.grant}))
  await expect(pending).rejects.toThrow()
  expect((await pool.query('SELECT state FROM memory_source_snapshots WHERE snapshot_id=$1',[started.snapshotId])).rows[0].state).toBe('staging')
  expect((await pool.query('SELECT 1 FROM memory_source_snapshot_entries WHERE snapshot_id=$1',[started.snapshotId])).rowCount).toBe(1)
 })
 test('a signed deadline elapsed after receipt metadata rolls back the entire upload',async()=>{
  const f=await insertWikiCandidateFixture(pool,'deadline'),ingest=createSourceIngestService(pool),input=startInput(f.installationId,'new-repository'),source=await ingest.startSnapshot(input)
  const grant={...f.grant,expiresAt:Date.now()/1000+1}
  const actor=tapped(pool,async(sql,client)=>{if(sql.includes('UPDATE memory_idempotency_keys'))await client.query('SELECT pg_sleep(1.2)')})
  await expect(createSourceIngestService(actor).uploadBatch(Object.assign({installationId:f.installationId,snapshotId:source.snapshotId,batchIndex:0,entries:[file()]},{grant}))).rejects.toThrow()
  expect((await pool.query('SELECT 1 FROM memory_source_snapshot_entries WHERE snapshot_id=$1',[source.snapshotId])).rowCount).toBe(0)
 })
 test('finalization drains an admitted upload before validating its manifest',async()=>{
  const f=await insertWikiCandidateFixture(pool,'manifest'),input=startInput(f.installationId,'new-repository'),ingest=createSourceIngestService(pool),source=await ingest.startSnapshot(input)
  await ingest.uploadBatch({installationId:f.installationId,snapshotId:source.snapshotId,batchIndex:0,entries:[file()]})
  const b=barrier();let finalPid:number|undefined
  const actor=tapped(pool,async(sql)=>{if(sql.includes('INSERT INTO memory_source_blobs')){b.reach();await b.allowed}})
  const uploading=outcome(createSourceIngestService(actor).uploadBatch({installationId:f.installationId,snapshotId:source.snapshotId,batchIndex:1,entries:[file('extra.ts')]}))
  let finalizing:ReturnType<typeof outcome>|undefined
  try{await b.reached;finalizing=outcome(createSourceIngestService(tapped(pool,async()=>{},id=>{finalPid=id})).finalizeSnapshot({...input,snapshotId:source.snapshotId,idempotencyKey:'finalize'}));expect(await blocked(pool,()=>finalPid)).toBe(true);b.release();expect(await uploading).toHaveProperty('value');expect(await finalizing).toHaveProperty('error');expect((await pool.query('SELECT state FROM memory_source_snapshots WHERE snapshot_id=$1',[source.snapshotId])).rows[0].state).toBe('staging')}finally{b.release();await uploading;await finalizing}
 },15000)
 test('abort drains an admitted upload and leaves a failed empty snapshot',async()=>{
  const f=await insertWikiCandidateFixture(pool,'abort'),input=startInput(f.installationId,'new-repository'),source=await createSourceIngestService(pool).startSnapshot(input),b=barrier();let abortPid:number|undefined
  const uploading=outcome(createSourceIngestService(tapped(pool,async(sql)=>{if(sql.includes('INSERT INTO memory_source_blobs')){b.reach();await b.allowed}})).uploadBatch({installationId:f.installationId,snapshotId:source.snapshotId,batchIndex:0,entries:[file()]}));let aborting:ReturnType<typeof outcome>|undefined
  try{await b.reached;aborting=outcome(createSourceIngestService(tapped(pool,async()=>{},id=>{abortPid=id})).abortSnapshot({installationId:f.installationId,snapshotId:source.snapshotId}));expect(await blocked(pool,()=>abortPid)).toBe(true);b.release();expect(await uploading).toHaveProperty('value');expect(await aborting).toHaveProperty('value');expect((await pool.query('SELECT 1 FROM memory_source_snapshot_entries WHERE snapshot_id=$1',[source.snapshotId])).rowCount).toBe(0)}finally{b.release();await uploading;await aborting}
 },15000)
 test('snapshot purge winning first prevents same-commit start resurrection',async()=>{
  const f=await insertWikiCandidateFixture(pool,'snapshot-first'),b=barrier();let startPid:number|undefined
  const purging=outcome(createPurgeRepository(tapped(pool,async(sql)=>{if(sql.includes('INSERT INTO memory_source_snapshot_tombstones')){b.reach();await b.allowed}}),{hmacKey:'c1'}).purgeSourceSnapshot({installationId:f.installationId,snapshotId:f.snapshotId,reasonCode:'user_delete'}));let starting:ReturnType<typeof outcome>|undefined
  try{await b.reached;const input={...startInput(f.installationId,'fixture/snapshot-first'),commitSha:f.commitSha,manifestSha256:'c'.repeat(64)};starting=outcome(createSourceIngestService(tapped(pool,async()=>{},id=>{startPid=id})).startSnapshot(input));expect(await blocked(pool,()=>startPid)).toBe(true);b.release();expect(await purging).toHaveProperty('value');expect(await starting).toHaveProperty('error');expect((await pool.query('SELECT 1 FROM memory_source_snapshots WHERE commit_sha=$1',[f.commitSha])).rowCount).toBe(0)}finally{b.release();await purging;await starting}
 },15000)
 test('activation rejects installation revocation occurring during pure parse',async()=>{
  const f=await insertWikiCandidateFixture(pool,'activation-revoke'),r=await ready(pool,f)
  let changed=false
  const actor={...pool,connect:pool.connect.bind(pool),query:async(sql:string,...args:unknown[])=>{const result=await Reflect.apply(pool.query,pool,[sql,...args]);if(!changed&&sql.includes('SELECT path, blob_hash')){changed=true;await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.installationId])}return result}} as unknown as pg.Pool
  await expect(createCodeGraphBuildService({pool:actor}).handleParseCodeSnapshot(r.job,new AbortController().signal,{fence:r.fence})).rejects.toThrow()
  expect((await pool.query('SELECT active_graph_version_id FROM memory_code_graph_heads WHERE repository_id=$1',[f.repositoryId])).rows[0].active_graph_version_id).toBe(f.graphVersionId)
  expect((await pool.query('SELECT 1 FROM memory_code_graph_versions WHERE snapshot_id=$1',[r.source.snapshotId])).rowCount).toBe(0)
 })
 test('activation owns the job fence through a generation wait and commit',async()=>{
  const f=await insertWikiCandidateFixture(pool,'lease'),r=await ready(pool,f),locker=await pool.connect(),b=barrier();let actorPid:number|undefined,reclaimPid:number|undefined
  await locker.query('BEGIN');await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`codegraph-generation:${f.installationId}:${f.repositoryId}`])
  const building=outcome(createCodeGraphBuildService({pool:tapped(pool,async(sql)=>{if(sql.includes('SET state = $3'))b.reach()},id=>{actorPid=id})}).handleParseCodeSnapshot(r.job,new AbortController().signal,{fence:r.fence}));let reclaiming:ReturnType<typeof outcome>|undefined
  try{await b.reached;expect(await blocked(pool,()=>actorPid)).toBe(true);const reclaimClient=await pool.connect();reclaimPid=(await reclaimClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;reclaiming=outcome(reclaimClient.query("UPDATE memory_jobs SET claimed_by='new-owner',claim_epoch=2 WHERE job_id=$1",[r.job.job_id]).finally(()=>reclaimClient.release()));expect(await blocked(pool,()=>reclaimPid)).toBe(true);await locker.query('COMMIT');expect(await building).toHaveProperty('value');expect(await reclaiming).toHaveProperty('value')}finally{await locker.query('ROLLBACK');locker.release();await building;await reclaiming}
 },15000)
 test('activation winning first drains repository purge without a head versus repository deadlock',async()=>{
  const f=await insertWikiCandidateFixture(pool,'head-cycle'),r=await ready(pool,f),b=barrier();let purgePid:number|undefined
  const building=outcome(createCodeGraphBuildService({pool:tapped(pool,async(sql)=>{if(sql.includes('SELECT revision::text')){b.reach();await b.allowed}})}).handleParseCodeSnapshot(r.job,new AbortController().signal,{fence:r.fence}));let purging:ReturnType<typeof outcome>|undefined
  try{await b.reached;purging=outcome(createPurgeRepository(tapped(pool,async()=>{},id=>{purgePid=id}),{hmacKey:'c1'}).purgeRepository({installationId:f.installationId,repositoryId:f.repositoryId,reasonCode:'user_delete'}));expect(await blocked(pool,()=>purgePid)).toBe(true);b.release();expect(await building).toHaveProperty('value');expect(await purging).toHaveProperty('value');expect((await pool.query('SELECT 1 FROM memory_code_graph_heads')).rowCount).toBe(0)}finally{b.release();await building;await purging}
 },15000)
 test('foreground repository purge rechecks publish authority',async()=>{
  const f=await insertWikiCandidateFixture(pool,'purge-grant')
  await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.installationId])
  await expect(createPurgeRepository(pool,{hmacKey:'c1'}).purgeRepository(Object.assign({installationId:f.installationId,repositoryId:f.repositoryId,reasonCode:'user_delete'},{grant:f.grant}))).rejects.toThrow()
  expect((await pool.query('SELECT 1 FROM memory_source_snapshots WHERE snapshot_id=$1',[f.snapshotId])).rowCount).toBe(1)
 })
 test('abort cannot remove entries from an active immutable snapshot',async()=>{
  const f=await insertWikiCandidateFixture(pool,'active-abort')
  await expect(createSourceIngestService(pool).abortSnapshot({installationId:f.installationId,snapshotId:f.snapshotId})).rejects.toThrow()
  expect((await pool.query('SELECT 1 FROM memory_source_snapshot_entries WHERE snapshot_id=$1',[f.snapshotId])).rowCount).toBe(1)
 })
 test('orphan cleanup rechecks new references after waiting for a blob row',async()=>{
  const f=await insertWikiCandidateFixture(pool,'orphan'),entry=file(),source=await createSourceIngestService(pool).startSnapshot(startInput(f.installationId,'new-repository')),locker=await pool.connect();let cleanupPid:number|undefined
  await pool.query('INSERT INTO memory_source_blobs(installation_id,blob_hash,byte_count,utf8_content) VALUES($1,$2,$3,$4)',[f.installationId,entry.blob_sha256,entry.byte_count,'export const newlyBuilt = 1;\n'])
  await locker.query('BEGIN');await locker.query('SELECT 1 FROM memory_source_blobs WHERE installation_id=$1 AND blob_hash=$2 FOR UPDATE',[f.installationId,entry.blob_sha256])
  const cleaning=outcome(createPurgeRepository(tapped(pool,async()=>{},id=>{cleanupPid=id}),{hmacKey:'c1'}).cleanupSupersededSnapshots({limit:10}))
  try{expect(await blocked(pool,()=>cleanupPid)).toBe(true);await locker.query("INSERT INTO memory_source_snapshot_entries(snapshot_id,installation_id,path,blob_hash,language,capability,byte_count,mode) VALUES($1,$2,$3,$4,'typescript','symbols_and_edges',$5,'100644')",[source.snapshotId,f.installationId,entry.path,entry.blob_sha256,entry.byte_count]);await locker.query('COMMIT');expect(await cleaning).toHaveProperty('value');expect((await pool.query('SELECT 1 FROM memory_source_blobs WHERE installation_id=$1 AND blob_hash=$2',[f.installationId,entry.blob_sha256])).rowCount).toBe(1)}finally{await locker.query('ROLLBACK');locker.release();await cleaning}
 },15000)
 test('retention rechecks Wiki pins created after its discovery snapshot',async()=>{
  const f=await insertWikiCandidateFixture(pool,'retention-pin'),locker=await pool.connect(),scan=barrier()
  await pool.query('DELETE FROM memory_wikis WHERE wiki_id=$1',[f.wikiId])
  await pool.query('DELETE FROM memory_code_graph_heads WHERE repository_id=$1',[f.repositoryId])
  await pool.query("UPDATE memory_code_graph_versions SET state='superseded' WHERE graph_version_id=$1",[f.graphVersionId])
  await pool.query("UPDATE memory_source_snapshots SET state='superseded',created_at=NOW()-INTERVAL '31 days' WHERE snapshot_id=$1",[f.snapshotId])
  // A raw FK writer commits its pin after the retention scan begins but before the row lock is available.
  await locker.query('BEGIN');await locker.query('SELECT 1 FROM memory_source_snapshots WHERE snapshot_id=$1 FOR KEY SHARE',[f.snapshotId])
  const cleaning=outcome(createPurgeRepository(tapped(pool,async(sql)=>{if(sql.includes('SELECT s.installation_id,s.repository_id,s.snapshot_id')){scan.reach();await scan.allowed}}),{hmacKey:'c1'}).cleanupSupersededSnapshots({limit:10}))
  try{await scan.reached;await locker.query('INSERT INTO memory_wikis(wiki_id,installation_id,repository_id,generation) VALUES($1,$2,$3,1)',[f.wikiId,f.installationId,f.repositoryId]);await locker.query("INSERT INTO memory_wiki_build_runs(run_id,installation_id,wiki_id,generation,source_snapshot_id,graph_version_id,state,input_digest) VALUES($1,$2,$3,1,$4,$5,'queued',$6)",[f.runId,f.installationId,f.wikiId,f.snapshotId,f.graphVersionId,'a'.repeat(64)]);await locker.query('COMMIT');scan.release();expect(await cleaning).toHaveProperty('value');expect((await pool.query('SELECT 1 FROM memory_source_snapshots WHERE snapshot_id=$1',[f.snapshotId])).rowCount).toBe(1)}finally{scan.release();await locker.query('ROLLBACK');locker.release();await cleaning}
 },15000)

 test.each(['v1','v2'] as const)('code snapshot API carries the signed %s deadline into its transaction',async version=>{
  const f=await insertWikiCandidateFixture(pool,'api-'+version),app=Fastify(),input=startInput(f.installationId,'new-repository')
  const grant:VerifiedMemoryGrant=version==='v1'?{installationId:f.installationId,configVersion:'1',services:['memory.codegraph.write'],callerType:'daemon',expiresAt:Date.now()/1000-1}
   :{...f.grant,version:'v2',installationId:f.installationId,services:['memory.codegraph.write'],callerType:'daemon',expiresAt:Date.now()/1000-1}
  const guard={guard:async()=>grant,guardMcp:async()=>grant} as unknown as GrantGuard
  registerCodegraphRoutes(app,{pool,guard,codegraphMode:'enabled',sharedScopesMode:'enabled',cursorSigningKey:'c1-test'})
  try{const result=await app.inject({method:'POST',url:'/api/v1/memory/code-snapshots',headers:{authorization:'Bearer signed-facts','idempotency-key':input.idempotencyKey},payload:{repository:input.repository,git_object_format:'sha1',commit_sha:input.commitSha,manifest_sha256:input.manifestSha256,expected_file_count:1,expected_byte_count:input.expectedByteCount,parser_matrix_version:'phase4-v1',idempotency_key:input.idempotencyKey}});expect(result.statusCode,result.body).toBe(403);expect((await pool.query('SELECT 1 FROM memory_idempotency_keys')).rowCount).toBe(0)}finally{await app.close()}
 })
 test('repository deletion API carries its current publish Grant after guard admission',async()=>{
  const f=await insertWikiCandidateFixture(pool,'api-purge'),app=Fastify()
  const grant:VerifiedMemoryGrant={...f.grant,version:'v2',installationId:f.installationId,services:['memory.manage'],callerType:'web',expiresAt:Date.now()/1000+60}
  const guard={guard:async()=>grant,guardMcp:async()=>{await pool.query("UPDATE memory_installations SET relay_status='revoked' WHERE installation_id=$1",[f.installationId]);return grant}} as unknown as GrantGuard
  registerWikiRoutes(app,{pool,guard,wikiMode:'enabled',sharedScopesMode:'enabled',cursorSigningKey:'c1-test'})
  try{const result=await app.inject({method:'DELETE',url:`/api/v1/memory/repositories/${f.repositoryId}/memory`,headers:{authorization:'Bearer signed-facts'}});expect(result.statusCode,result.body).toBe(403);expect((await pool.query('SELECT 1 FROM memory_source_snapshots WHERE snapshot_id=$1',[f.snapshotId])).rowCount).toBe(1)}finally{await app.close()}
 })
 test('repository purge drains before installation purge can lock any source rows',async()=>{
  const f=await insertWikiCandidateFixture(pool,'installation-cycle'),b=barrier();let installationPid:number|undefined
  const purging=outcome(createPurgeRepository(tapped(pool,async(sql)=>{if(sql.includes('FROM repositories')&&sql.includes('FOR UPDATE')){b.reach();await b.allowed}}),{hmacKey:'c1'}).purgeRepository({installationId:f.installationId,repositoryId:f.repositoryId,reasonCode:'user_delete'}))
  let uninstalling:ReturnType<typeof outcome>|undefined
  try{await b.reached;uninstalling=outcome(createPurgeRepository(tapped(pool,async()=>{},id=>{installationPid=id}),{hmacKey:'c1'}).purgeInstallation({installationId:f.installationId,requestId:randomUUID(),reason:'user_delete'}));expect(await blocked(pool,()=>installationPid)).toBe(true);b.release();expect(await purging).toHaveProperty('value');expect(await uninstalling).toHaveProperty('value');expect((await pool.query('SELECT local_status FROM memory_installations WHERE installation_id=$1',[f.installationId])).rows[0].local_status).toBe('purged')}finally{b.release();await purging;await uninstalling}
 },15000)
 test('valid foreground authority can commit and replay exactly once',async()=>{
  const f=await insertWikiCandidateFixture(pool,'valid-control'),input={...startInput(f.installationId,'new-repository'),grant:{...f.grant,expiresAt:Date.now()/1000+60}},ingest=createSourceIngestService(pool)
  const source=await ingest.startSnapshot(input)
  expect(await ingest.startSnapshot(input)).toEqual(source)
  await ingest.uploadBatch({installationId:f.installationId,snapshotId:source.snapshotId,batchIndex:0,entries:[file()],grant:input.grant})
  expect(await ingest.uploadBatch({installationId:f.installationId,snapshotId:source.snapshotId,batchIndex:0,entries:[file()],grant:input.grant})).toMatchObject({accepted:1})
  await ingest.finalizeSnapshot({...input,snapshotId:source.snapshotId,idempotencyKey:'finalize'})
  expect((await pool.query("SELECT 1 FROM memory_jobs WHERE payload->>'snapshot_id'=$1",[source.snapshotId])).rowCount).toBe(1)
  expect(await createPurgeRepository(pool,{hmacKey:'c1'}).purgeRepository({installationId:f.installationId,repositoryId:source.repositoryId,reasonCode:'user_delete',grant:input.grant})).toEqual({purged:true})
 })

 test('an upload losing an orphan deletion rolls back its receipt and safely retries',async()=>{
  const f=await insertWikiCandidateFixture(pool,'orphan-retry'),entry=file(),ingest=createSourceIngestService(pool),source=await ingest.startSnapshot(startInput(f.installationId,'new-repository')),b=barrier();let uploadPid:number|undefined
  await pool.query('INSERT INTO memory_source_blobs(installation_id,blob_hash,byte_count,utf8_content) VALUES($1,$2,$3,$4)',[f.installationId,entry.blob_sha256,entry.byte_count,'export const newlyBuilt = 1;\n'])
  const cleaning=outcome(createPurgeRepository(tapped(pool,async(sql)=>{if(sql.includes('SELECT 1 FROM memory_source_blobs')&&sql.includes('FOR UPDATE')){b.reach();await b.allowed}}),{hmacKey:'c1'}).cleanupSupersededSnapshots({limit:10}))
  let uploading:ReturnType<typeof outcome>|undefined
  const input={installationId:f.installationId,snapshotId:source.snapshotId,batchIndex:0,entries:[entry]}
  try{await b.reached;uploading=outcome(createSourceIngestService(tapped(pool,async()=>{},id=>{uploadPid=id})).uploadBatch(input));expect(await blocked(pool,()=>uploadPid)).toBe(true);b.release();expect(await cleaning).toHaveProperty('value');const first=await uploading;if('error' in first){expect(first.error.code).toBe('23503');expect((await pool.query("SELECT 1 FROM memory_idempotency_keys WHERE operation=$1",[`code_snapshot_batch:${source.snapshotId}`])).rowCount).toBe(0)}expect(await ingest.uploadBatch(input)).toMatchObject({accepted:1});expect((await pool.query('SELECT 1 FROM memory_source_snapshot_entries e JOIN memory_source_blobs b ON b.installation_id=e.installation_id AND b.blob_hash=e.blob_hash WHERE e.snapshot_id=$1',[source.snapshotId])).rowCount).toBe(1)}finally{b.release();await cleaning;await uploading}
 },15000)

 test('start refuses a newly discovered snapshot before taking a late receipt dependency and a fresh retry succeeds',async()=>{
  const f=await insertWikiCandidateFixture(pool,'start-late-source'),input=startInput(f.installationId,'fixture/start-late-source'),gate=barrier()
  let contenderPid:number|undefined
  const firstPool=tapped(pool,async(sql)=>{if(sql.includes('INSERT INTO memory_idempotency_keys')){gate.reach();await gate.allowed}})
  const first=outcome(createSourceIngestService(firstPool).startSnapshot(input))
  let contender:ReturnType<typeof outcome>|undefined
  try{
    await gate.reached
    // The first transaction has reserved key K after observing no source.
    // A different key commits the tuple before the second authorize callback.
    const created=await createSourceIngestService(pool).startSnapshot({...input,idempotencyKey:'other-key'})
    contender=outcome(createSourceIngestService(tapped(pool,async()=>{},pid=>{contenderPid=pid})).startSnapshot(input))
    expect(await blocked(pool,()=>contenderPid),'the contender owns the new source fence and waits on key K').toBe(true)
    gate.release()
    const [firstResult,contenderResult]=await Promise.all([first,contender])
    expect({first:firstResult,contender:contenderResult}).toMatchObject({first:{error:{code:'source_changed'}},contender:{value:{snapshotId:created.snapshotId}}})
    expect(await createSourceIngestService(pool).startSnapshot(input)).toMatchObject({snapshotId:created.snapshotId})
    expect((await pool.query('SELECT 1 FROM memory_source_snapshots WHERE repository_id=$1 AND commit_sha=$2 AND manifest_hash=$3',[f.repositoryId,input.commitSha,input.manifestSha256])).rowCount).toBe(1)
  }finally{gate.release();await first;await contender}
 },15000)

})
