import pg from 'pg'
import Fastify from 'fastify'
import {randomUUID} from 'node:crypto'
import {beforeAll,beforeEach,afterAll,describe,test,expect,vi} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {registerManageRoutes} from '../api/manage-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import type {GrantGuard} from '../auth/grant-guard.js'
import {createClaimIndexer} from '../retrieval/indexer.js'
import {contextClaimFacts,eligibleContextFacts} from '../context/consumption.js'
import {createMemoryReadService} from '../retrieval/read-service.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('manual personal knowledge',()=>{
 let pool:pg.Pool
 const id=randomUUID(),owner=randomUUID();let caller='web'
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool.query('DELETE FROM knowledge_claims WHERE installation_id=$1',[id]);await pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[id]);await pool.end()})
 beforeEach(async()=>{caller='web';await pool.query('DELETE FROM knowledge_claims WHERE installation_id=$1',[id]);await pool.query('DELETE FROM memory_installations WHERE installation_id=$1',[id]);await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version) VALUES($1,'pocketctl-memory','active','ready',1)`,[id]);await pool.query(`INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) VALUES($1,'personal',$2)`,[id,owner])})
 async function app(){const a=Fastify();registerManageRoutes(a,{pool,guard:{guard:async({authorization})=>{if(authorization!=='Bearer user')throw Error('denied');return{installationId:id,configVersion:'1',callerType:caller,expiresAt:Date.now()/1000+120}}} as GrantGuard,policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),textConfigured:false,embeddingConfigured:false,tombstoneHmacKeys:[{version:'manual-test',key:'manual-knowledge-test-key'.repeat(3)}]});return a}
 const body={statement:'Use cursor pagination for stable history.',claim_type:'repository_convention',confirmed:true}
 const headers=(key='create')=>({authorization:'Bearer user','idempotency-key':key})
 test('creates immutable personal assertion, capsule and index atomically and replays the receipt',async()=>{
  const a=await app();const r=await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body});expect(r.statusCode,r.body).toBe(200);const saved=r.json()
  const replay=await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body});expect(replay.json()).toEqual(saved)
  const row=(await pool.query(`SELECT c.*,v.source_candidate_id,v.structured_content,v.authority,e.locator,e.episode_id,e.capsule_id,e.excerpt FROM knowledge_claims c JOIN knowledge_versions v USING(installation_id,claim_id) JOIN knowledge_evidence e USING(installation_id,version_id) WHERE c.installation_id=$1`,[id])).rows[0]
  expect(row).toMatchObject({state:'active',source_candidate_id:null,episode_id:null,authority:'user_accepted',excerpt:body.statement,locator:{source_kind:'manual_entry',actor_scope_id:owner}});expect(row.capsule_id).toBeTruthy()
  expect((await pool.query(`SELECT count(*)::int n FROM memory_jobs WHERE installation_id=$1 AND job_type='index_claim_version'`,[id])).rows[0].n).toBe(1)
  const reads=createMemoryReadService(pool,"test-signing-key");expect(await reads.getEvidence(id,(await pool.query('SELECT evidence_id FROM knowledge_evidence WHERE installation_id=$1',[id])).rows[0].evidence_id)).toMatchObject({excerpt:body.statement})
  await a.close()
 })
 test('rejects duplicate knowledge and same key with changed content, preserving one ledger',async()=>{
  const a=await app();const submit=(key:string,payload=body)=>a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(key),payload})
  expect((await submit('one')).statusCode).toBe(200)
  expect((await submit('two')).statusCode).toBe(409)
  expect((await submit('one',{...body,statement:'different'})).statusCode).toBe(409)
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1',[id])).rows[0].n).toBe(1);await a.close()
 })
 test('rejects forgery, unconfirmed input, daemon, foreign repository and revoked receipt access',async()=>{
  const a=await app();const submit=(payload:unknown)=>a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:payload as any})
  expect((await submit({...body,confirmed:false})).statusCode).toBe(400)
  expect((await submit({...body,authority:'organization_published'})).statusCode).toBe(400)
  expect((await submit({...body,repository_id:randomUUID()})).statusCode).toBe(400)
  caller='daemon';expect((await submit(body)).statusCode).toBe(403);caller='web'
  expect((await submit(body)).statusCode).toBe(200)
  await pool.query('UPDATE memory_installations SET config_version=2 WHERE installation_id=$1',[id]);expect((await submit(body)).statusCode).toBe(403);await a.close()
 })
 test('manual revisions preserve immutable history, enforce CAS and remain evidence-bound',async()=>{
  const a=await app();const saved=(await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body})).json()
  const path=`/api/v1/memory/claims/${saved.claim_id}/manual-revisions`
  const payload={statement:'Use verified cursor pagination.',expected_revision:1,confirmed:true}
  const r=await a.inject({method:'POST',url:path,headers:headers('revision'),payload});expect(r.statusCode,r.body).toBe(200)
  expect((await a.inject({method:'POST',url:path,headers:headers('stale'),payload})).statusCode).toBe(409)
  const rows=(await pool.query('SELECT statement,authority,effective_until FROM knowledge_versions WHERE installation_id=$1 ORDER BY version_number',[id])).rows
  expect(rows).toHaveLength(2);expect(rows[0].statement).toBe(body.statement);expect(rows[0].effective_until).not.toBeNull();expect(rows[1].authority).toBe('user_corrected');await a.close()
 })
 test('deletion prevents manual resurrection and shared scopes cannot create',async()=>{
  const a=await app();const saved=(await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body})).json()
  const deleted=await a.inject({method:'DELETE',url:`/api/v1/memory/claims/${saved.claim_id}`,headers:headers('delete'),payload:{expected_revision:1}});expect(deleted.statusCode,deleted.body).toBe(200)
  const again=await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers('resurrect'),payload:body});expect(again.statusCode,again.body).toBe(409)
  await pool.query(`UPDATE memory_owner_scopes SET owner_scope_kind='organization' WHERE installation_id=$1`,[id])
  expect((await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body})).statusCode).toBe(403)
  expect((await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers('shared'),payload:{...body,statement:'Shared assertion'}})).statusCode).toBe(403)
  await a.close()
 })

 test('a failed evidence insert rolls back claim, version, capsule, job and receipt together',async()=>{
  const a=await app();const connect=pool.connect.bind(pool)
  const spy=vi.spyOn(pool,'connect').mockImplementationOnce((async()=>{
    const client=await connect()
    return {query:async(sql:any,values:any)=>{if(String(sql).includes('INSERT INTO knowledge_evidence\n'))throw Error('injected evidence failure');return client.query(sql,values)},release:()=>client.release()}
  }) as any)
  const failed=await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body});spy.mockRestore();expect(failed.statusCode).toBe(500)
  for(const table of ['knowledge_claims','knowledge_versions','knowledge_evidence_capsules','memory_jobs','memory_idempotency_keys'])expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE installation_id=$1`,[id])).rows[0].n).toBe(0)
  expect((await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body})).statusCode).toBe(200);await a.close()
 })

 test('repository applicability stays bound and the existing indexer consumes the new version',async()=>{
  const repo=randomUUID();await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,'example','https://github.com/example/knowledge.git',NOW(),NOW())`,[id,repo])
  const a=await app();const r=await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:{...body,repository_id:repo}});expect(r.statusCode,r.body).toBe(200);const saved=r.json()
  await createClaimIndexer({pool}).indexVersion(id,saved.version_id,new AbortController().signal)
  expect((await pool.query('SELECT document FROM claim_search_documents WHERE installation_id=$1 AND version_id=$2',[id,saved.version_id])).rows[0].document).toContain(body.statement)
  const fact=(await contextClaimFacts(pool,id,[saved.version_id])).get(saved.version_id)!
  expect(eligibleContextFacts(fact,{repositoryId:null,repoSnapshotId:null,branch:null,taskScopeKey:null})).toBe(false)
  expect(eligibleContextFacts(fact,{repositoryId:repo,repoSnapshotId:null,branch:null,taskScopeKey:null})).toBe(true)
  await a.close()
 })
 test('concurrent distinct request keys cannot create duplicate knowledge',async()=>{
  const a=await app();const responses=await Promise.all(['a','b'].map(key=>a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(key),payload:body})))
  expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);expect((await pool.query('SELECT count(*)::int n FROM knowledge_claims WHERE installation_id=$1',[id])).rows[0].n).toBe(1);await a.close()
 })

 test('ordinary corrections inherit retained evidence on the server without inventing raw source IDs',async()=>{
  const a=await app();const saved=(await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body})).json()
  // Synthetic legacy accepted-capsule fixture; this deliberately has no raw episode.
  await pool.query("UPDATE knowledge_versions SET structured_content='{}'::jsonb WHERE installation_id=$1",[id])
  await pool.query('UPDATE knowledge_claims SET normalized_key_v2=NULL,topic_key_v2=NULL,duplicate_digest_v2=NULL WHERE installation_id=$1',[id])
  const path=`/api/v1/memory/claims/${saved.claim_id}/correct`,payload={expected_revision:1,statement:'A corrected retained assertion',inherit_current_evidence:true}
  const r=await a.inject({method:'POST',url:path,headers:headers('inherit'),payload});expect(r.statusCode,r.body).toBe(200)
  expect((await a.inject({method:'POST',url:path,headers:headers('inherit'),payload})).json()).toEqual(r.json())
  expect((await a.inject({method:'POST',url:path,headers:headers('stale-inherit'),payload})).statusCode).toBe(409)
  const rows=(await pool.query(`SELECT e.excerpt,encode(e.excerpt_hash,'hex') hash,e.locator,e.occurred_at,e.episode_id,e.source_event_id,e.artifact_id,e.evidence_id,e.capsule_id FROM knowledge_evidence e JOIN knowledge_versions v USING(installation_id,version_id) WHERE e.installation_id=$1 ORDER BY v.version_number`,[id])).rows
  expect(rows).toHaveLength(2);expect(rows[1]).toMatchObject({excerpt:rows[0].excerpt,hash:rows[0].hash,locator:rows[0].locator,occurred_at:rows[0].occurred_at,episode_id:null,source_event_id:null,artifact_id:null})
  expect(rows[1].evidence_id).not.toBe(rows[0].evidence_id);expect(rows[1].capsule_id).not.toBe(rows[0].capsule_id)
  expect((await pool.query('SELECT statement FROM knowledge_versions WHERE version_id=$1',[saved.version_id])).rows[0].statement).toBe(body.statement)
  await a.close()
 })
 test('inheritance rejects missing capsules, mixed client evidence and manual assertion shortcuts atomically',async()=>{
  const a=await app();const saved=(await a.inject({method:'POST',url:'/api/v1/memory/claims',headers:headers(),payload:body})).json(),url=`/api/v1/memory/claims/${saved.claim_id}/correct`
  const payload={expected_revision:1,statement:'Cannot fabricate source proof',inherit_current_evidence:true}
  expect((await a.inject({method:'POST',url,headers:headers('manual-shortcut'),payload})).statusCode).toBe(400)
  expect((await a.inject({method:'POST',url,headers:headers('mixed'),payload:{...payload,evidence:[]}})).statusCode).toBe(400)
  await pool.query("UPDATE knowledge_versions SET structured_content='{}'::jsonb WHERE installation_id=$1",[id])
  await pool.query('DELETE FROM knowledge_evidence WHERE installation_id=$1',[id])
  expect((await a.inject({method:'POST',url,headers:headers('missing'),payload})).statusCode).toBe(400)
  expect((await pool.query('SELECT count(*)::int n FROM knowledge_versions WHERE installation_id=$1',[id])).rows[0].n).toBe(1)
  await a.close()
 })

})
