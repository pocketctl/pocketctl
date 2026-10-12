import pg from 'pg'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {fileURLToPath} from 'node:url'
import {afterEach,beforeEach,describe,expect,test} from 'vitest'
import {gitDbFixture,insertGitConnection} from '../testing/phase6-db-fixture.js'
import {createMemoryReadService} from '../retrieval/read-service.js'
import {createMemoryPool} from '../db.js'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {applyMemoryV50Fixture,seedMemoryV50Anomalies,V50_IDS} from '../testing/fixtures/memory-v50.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('Bridge runtime compatibility and transactional change capture',()=>{
 let pool:pg.Pool
 beforeEach(async()=>{
  pool=new pg.Pool({connectionString:url,max:5})
  await assertMemoryTestDatabase(pool,url!)
  await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public')
  await applyMemoryV50Fixture(pool,url!);await seedMemoryV50Anomalies(pool);await applyMemorySchema(pool)
 },60000)
 afterEach(async()=>{await pool.end()})
 const events=async()=> (await pool.query('SELECT * FROM memory_governance_migration_changes ORDER BY sequence')).rows
 test('each connection from the real API/Worker pool declares its actual writer capability',async()=>{
  const runtime=createMemoryPool({databaseUrl:url!,dbPoolMax:3})
  const clients=await Promise.all([runtime.connect(),runtime.connect(),runtime.connect()])
  try{
   for(const client of clients){
    expect((await client.query("SELECT current_setting('pocketctl.writer_capability',true) AS capability,current_setting('pocketctl.writer_identity_generation',true) AS generation")).rows[0]).toEqual({capability:'identity_v2',generation:'adaptive'})
   }
  }finally{clients.forEach(c=>c.release());await runtime.end()}
 })
 test('schema startup refuses unknown applied versions before applying any pending migration',async()=>{
  await pool.query('DELETE FROM memory_schema_migrations WHERE version=53')
  await pool.query('INSERT INTO memory_schema_migrations(version) VALUES(999)')
  await expect(applyMemorySchema(pool)).rejects.toThrow('memory_schema_incompatible')
  expect((await pool.query('SELECT 1 FROM memory_schema_migrations WHERE version=53')).rowCount).toBe(0)
 })
 test('captures old writer edits without copying private statements into the migration queue',async()=>{
  expect(await events()).toEqual([])
  await pool.query("UPDATE knowledge_versions SET statement='private statement never copied' WHERE version_id=$1",[V50_IDS.firstVersion])
  const rows=await events()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({installation_id:V50_IDS.personal,entity_kind:'knowledge_versions',operation:'UPDATE',writer_capability:'legacy_unknown',source_revision:'1'})
  expect(rows[0].entity_id).toContain(V50_IDS.firstVersion)
  expect(JSON.stringify(rows)).not.toContain('private statement never copied')
  expect(rows[0].transaction_id).toMatch(/^\d+$/)
 })
 test('captures revision, evidence and policy changes under their real target installation',async()=>{
  await pool.query("UPDATE memory_promotion_candidate_versions SET statement='changed proposal' WHERE candidate_revision_id=$1",[V50_IDS.proposalRevision])
  await pool.query("INSERT INTO memory_promotion_evidence(candidate_revision_id,ordinal,evidence_kind,excerpt,excerpt_hash,source_evidence_hash) VALUES($1,1,'episode','private evidence','fixture','fixture')",[V50_IDS.proposalRevision])
  await pool.query('UPDATE memory_review_policy_heads SET revision=revision+1 WHERE policy_id=$1',[V50_IDS.policy])
  expect((await events()).map(r=>[r.entity_kind,r.installation_id,r.operation])).toEqual([
   ['memory_promotion_candidate_versions',V50_IDS.team,'UPDATE'],['memory_promotion_evidence',V50_IDS.team,'INSERT'],['memory_review_policy_heads',V50_IDS.team,'UPDATE'],
  ])
  expect(JSON.stringify(await events())).not.toContain('private evidence')
 })
 test('records both ends of proposal provenance',async()=>{
  await pool.query('UPDATE memory_promotion_candidates SET revision=revision+1 WHERE candidate_id=$1',[V50_IDS.proposal])
  expect((await events()).map(r=>r.installation_id).sort()).toEqual([V50_IDS.personal,V50_IDS.team])
 })
 test('resolves Team tombstone owner UUID instead of inventing installation ownership',async()=>{
  const owner='a0530000-0000-4000-8000-000000000001'
  await pool.query('UPDATE memory_owner_scopes SET owner_scope_id=$2 WHERE installation_id=$1',[V50_IDS.team,owner])
  await pool.query('DELETE FROM memory_governance_migration_changes')
  await pool.query("INSERT INTO memory_scope_tombstones(owner_scope_kind,owner_scope_id,authorization_epoch,reason) VALUES('team',$1,2,'private revocation reason')",[owner])
  expect((await events()).map(r=>[r.entity_kind,r.installation_id])).toEqual([['memory_scope_tombstones',V50_IDS.team]])
  expect(JSON.stringify(await events())).not.toContain('private revocation reason')
 })
 test('rollback discards source changes and queue rows atomically',async()=>{
  const client=await pool.connect()
  try{
   await client.query('BEGIN')
   await client.query("UPDATE knowledge_versions SET statement='rolled back' WHERE version_id=$1",[V50_IDS.firstVersion])
   expect(await events()).toEqual([])
   await client.query('ROLLBACK')
  }finally{client.release()}
  expect(await events()).toEqual([])
  expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[V50_IDS.firstVersion])).rows[0].statement).toBe('Fixture symbol location')
 })
 test('publishes changes only at source commit without blocking another installation',async()=>{
  const client=await pool.connect()
  try{
   await client.query('BEGIN')
   await client.query('UPDATE knowledge_versions SET confidence=0.8 WHERE version_id=$1',[V50_IDS.firstVersion])
   expect(await events()).toEqual([])
   await pool.query('UPDATE memory_review_policy_heads SET revision=revision+1 WHERE policy_id=$1',[V50_IDS.policy])
   expect((await events()).map(r=>r.installation_id)).toEqual([V50_IDS.team])
   await client.query('COMMIT')
  }finally{client.release()}
  expect((await events()).map(r=>r.entity_kind).sort()).toEqual(['knowledge_versions','memory_review_policy_heads'])
 })
 test('cascaded parent deletion keeps a replayable parent event while installation deletion cannot resurrect it',async()=>{
  await pool.query('DELETE FROM memory_promotion_candidates WHERE candidate_id=$1',[V50_IDS.proposal])
  expect((await events()).filter(r=>r.entity_kind==='memory_promotion_candidates').map(r=>r.operation)).toEqual(['DELETE','DELETE'])
  // Follow the existing purge order: remove ledger FK dependents before repositories.
  await pool.query('DELETE FROM knowledge_claims WHERE installation_id=$1',[V50_IDS.personal])
  await pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[V50_IDS.personal])
  expect((await events()).some(r=>r.installation_id===V50_IDS.personal)).toBe(false)
 })
 test('captures global policy changes for every existing installation',async()=>{
  const policy='a0530000-0000-4000-8000-000000000002'
  const version='a0530000-0000-4000-8000-000000000003'
  await pool.query("INSERT INTO memory_policy_sets(policy_id,policy_kind,layer,scope_key) VALUES($1,'context','system','global')",[policy])
  await pool.query("INSERT INTO memory_policy_versions(policy_version_id,policy_id,version_number,schema_version,document,content_hash,created_by) VALUES($1,$2,1,1,'{}',sha256('policy'::bytea),'system')",[version,policy])
  expect((await events()).filter(r=>r.entity_kind==='memory_policy_versions').map(r=>r.installation_id).sort()).toEqual([V50_IDS.personal,V50_IDS.team])
 })
 test('moving a membership records both old and new scope keys',async()=>{
  const member='a0530000-0000-4000-8000-000000000004'
  await pool.query('INSERT INTO memory_scope_memberships(installation_id,membership_id) VALUES($1,$2)',[V50_IDS.personal,member])
  await pool.query('DELETE FROM memory_governance_migration_changes')
  await pool.query('UPDATE memory_scope_memberships SET installation_id=$2 WHERE installation_id=$1 AND membership_id=$3',[V50_IDS.personal,V50_IDS.team,member])
  const rows=await events()
  expect(rows.map(r=>r.installation_id).sort()).toEqual([V50_IDS.personal,V50_IDS.team])
  expect(rows.every(r=>r.entity_id.includes(r.installation_id)&&r.entity_id.includes(member))).toBe(true)
 })
 test('queue persistence failure rolls back the source mutation',async()=>{
  await pool.query("ALTER TABLE memory_governance_migration_changes ADD CONSTRAINT reject_fixture_capture CHECK(entity_kind<>'knowledge_versions')")
  await expect(pool.query("UPDATE knowledge_versions SET statement='must rollback' WHERE version_id=$1",[V50_IDS.firstVersion])).rejects.toMatchObject({code:'23514'})
  expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[V50_IDS.firstVersion])).rows[0].statement).toBe('Fixture symbol location')
 })

 async function startProcess(role:'api'|'worker'){
  const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve))
  const port=(reservation.address() as {port:number}).port
  await new Promise<void>(resolve=>reservation.close(()=>resolve()))
  const child=spawn(process.execPath,[fileURLToPath(new URL(`../../dist/${role}-main.js`,import.meta.url))],{
   env:{PATH:process.env.PATH,NODE_ENV:'test',MEMORY_MODE:'off',MEMORY_DATABASE_URL:url!,
    MEMORY_PORT:String(port),MEMORY_METRICS_PORT:String(port),MEMORY_API_BIND:'loopback',MEMORY_ALLOWED_HOSTS:'127.0.0.1',
    MEMORY_PROVIDER_CLIENT_ID:'fixture',MEMORY_PROVIDER_CLIENT_SECRET:'fixture-secret-0123456789',
    MEMORY_HMAC_KEY:'fixture-hmac-0123456789abcdef-0123456789abcdef'},stdio:['ignore','pipe','pipe'],
  })
  let output='';child.stdout.on('data',data=>{output+=data});child.stderr.on('data',data=>{output+=data})
  let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM')},4000)
  const forceTimer=setTimeout(()=>child.kill('SIGKILL'),6000)
  const closed=new Promise<number|null>(resolve=>child.once('close',code=>resolve(code)))
  return {child,port,closed,result:async()=>{const code=await closed;clearTimeout(timer);clearTimeout(forceTimer);return {code,timedOut,output}}}
 }
 for(const role of ['api','worker'] as const){
  test(`${role} process refuses unsupported data generation before starting listeners or loops`,async()=>{
   await pool.query('INSERT INTO memory_governance_v2_states(installation_id,identity_generation) VALUES($1,2)',[V50_IDS.personal])
   const runtime=await startProcess(role),result=await runtime.result()
   expect(result).toMatchObject({code:1,timedOut:false})
   expect(result.output).toContain('memory_runtime_incompatible:identity_generation')
  },10000)
  test(`${role} process refuses an unknown writer floor`,async()=>{
   await pool.query("INSERT INTO memory_governance_v2_states(installation_id,writer_floor) VALUES($1,'future_v99')",[V50_IDS.team])
   const runtime=await startProcess(role),result=await runtime.result()
   expect(result).toMatchObject({code:1,timedOut:false})
   expect(result.output).toContain('memory_runtime_incompatible:writer_floor')
  },10000)
 }
 test('actual API exposes the conservative compatibility matrix with all automatic writes off',async()=>{
  const runtime=await startProcess('api')
  try{
   let body:unknown
   for(let attempt=0;attempt<50;attempt++){
    try{body=await (await fetch(`http://127.0.0.1:${runtime.port}/ready`,{signal:AbortSignal.timeout(150)})).json();break}catch{await new Promise(resolve=>setTimeout(resolve,50))}
   }
   expect(body).toMatchObject({status:'ready',compatibility:{image_contract:'memory-governance-identity-v2',read_identity_generations:[1,2],write_identity_generations:[1,2],automation_writes:false}})
  }finally{runtime.child.kill('SIGTERM');await runtime.result()}
 },10000)

 test('shared REST/MCP reads preserve unknown authority without reporting human approval',async()=>{
  await pool.query('ALTER TABLE knowledge_versions DROP CONSTRAINT knowledge_versions_authority_check')
  await pool.query("UPDATE knowledge_versions SET authority='future_automated_acceptance' WHERE version_id=$1",[V50_IDS.currentVersion])
  const reads=createMemoryReadService(pool,'fixture-cursor-key')
  const detail=await reads.getClaim(V50_IDS.personal,V50_IDS.knownClaim)
  const version=detail!.versions.find(v=>v.version_id===V50_IDS.currentVersion)
  expect(version).toMatchObject({authority:'future_automated_acceptance',authority_compatibility:{recognized:false,human_approved:false}})
  const list=await reads.listActiveClaims(V50_IDS.personal)
  expect(list.claims.find(c=>c.claim_id===V50_IDS.knownClaim)).toMatchObject({authority:'future_automated_acceptance',authority_compatibility:{recognized:false,human_approved:false}})
 })
 test('legacy read metadata remains generation one with unknown applicability and original human authority',async()=>{
  const reads=createMemoryReadService(pool,'fixture-cursor-key')
  const detail=await reads.getClaim(V50_IDS.personal,V50_IDS.knownClaim)
  expect(detail!.claim).toMatchObject({identity_generation:1,normalized_key_v2:null,canonical_repository_key:null,consumption_hold_reason:null})
  expect(detail!.versions[0]).toMatchObject({applicability:null,effective_from:null,effective_until:null,authority_compatibility:{recognized:true,human_approved:true}})
 })

 test('routine feed cursor updates do not create migration work but scope control changes do',async()=>{
  await pool.query('UPDATE memory_installations SET last_pull_at=NOW(),last_feed_id=100,last_ack_at=NOW() WHERE installation_id=$1',[V50_IDS.personal])
  await pool.query('UPDATE memory_owner_scopes SET last_feed_id=100,updated_at=NOW() WHERE installation_id=$1',[V50_IDS.personal])
  expect(await events()).toEqual([])
  await pool.query('UPDATE memory_owner_scopes SET authorization_epoch=authorization_epoch+1 WHERE installation_id=$1',[V50_IDS.personal])
  expect((await events()).map(r=>r.entity_kind)).toEqual(['memory_owner_scopes'])
 })

 test('captures Git connection provenance without copying credential references',async()=>{
  const f=await gitDbFixture(pool),connection=await insertGitConnection(pool,f)
  await pool.query('DELETE FROM memory_governance_migration_changes')
  await pool.query("UPDATE memory_git_connections SET credential_ref='private-reference-never-in-queue' WHERE connection_id=$1",[connection])
  const rows=await events()
  // Existing credential rotation atomically advances the connection epoch.
  expect(rows.map(r=>r.entity_kind).sort()).toEqual(['memory_git_connections','memory_git_lifecycle_epochs'])
  expect(new Set(rows.map(r=>r.transaction_id)).size).toBe(1)
  const changed=rows.find(r=>r.entity_kind==='memory_git_connections')!
  expect(changed).toMatchObject({installation_id:f.installationId,operation:'UPDATE'})
  expect(changed.entity_id).toContain(connection)
  expect(JSON.stringify(rows)).not.toContain('private-reference-never-in-queue')
 })

})
