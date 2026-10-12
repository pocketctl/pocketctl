import {createHash,randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createCandidateDeduper} from '../extraction/deduper.js'
import {normalizedClaimKey} from '../retrieval/query-normalizer.js'
import {gitDbFixture,gitClaimFixture} from '../testing/phase6-db-fixture.js'
import {insertKnowledgeTombstones,findTombstonedNormalizedKeys,tombstoneIdentityHmac} from '../claims/tombstones.js'
const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('v2 identity and privacy tombstone bridge',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 const statement='Call verifyToken before publishing'
 const key=normalizedClaimKey({claimType:'architecture_decision',scopeKey:'main',statement})
 async function fixture(){
  const f=await gitDbFixture(pool),c=await gitClaimFixture(pool,f,{scopeKey:'main'})
  await pool.query("UPDATE repositories SET canonical_remote='https://github.com/acme/repo-a.git' WHERE installation_id=$1 AND repository_id=$2",[f.installationId,f.repositoryId])
  const otherRepositoryId=randomUUID()
  await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at)
   VALUES($1,$2,'other-confirmed-repository','git@github.com:acme/repo-b.git',NOW(),NOW())`,[f.installationId,otherRepositoryId])
  await pool.query("UPDATE knowledge_claims SET scope_kind='branch',canonical_repository_key='github.com/acme/repo-a',normalized_key=$2 WHERE claim_id=$1",[c.claimId,key])
  await pool.query("UPDATE knowledge_versions SET statement=$2,branch='main',structured_content='{}'::jsonb WHERE version_id=$1",[c.versionId,statement])
  return{...f,...c,otherRepositoryId}
 }
 const identity=(repository:string,repositoryId:string)=>({scopeKind:'branch',scopeKey:'main',canonicalRepositoryKey:repository,repositoryId,branch:'main',snapshotId:null,status:'verified',structuredContent:{},validFrom:null,validUntil:null})
 test('same main branch and statement in another confirmed repository do not merge',async()=>{
  const f=await fixture()
  const result=await createCandidateDeduper(pool).activeFamilyFor({installationId:f.installationId,claimType:'architecture_decision',scopeKey:'main',statement,identity:identity('github.com/acme/repo-b',f.otherRepositoryId)} as never)
  expect(result.exactClaimId).toBeNull();expect(result.family).toHaveLength(0)
 })
 test('confirmed same repository, exact body and conditions still match a legacy identity',async()=>{
  const f=await fixture()
  const result=await createCandidateDeduper(pool).activeFamilyFor({installationId:f.installationId,claimType:'architecture_decision',scopeKey:'main',statement,identity:identity('github.com/acme/repo-a',f.repositoryId)} as never)
  expect(result.exactClaimId).toBe(f.claimId);expect(result.family).toHaveLength(1)
 })
 test('a verified installation-local task does not require a fabricated repository identity',async()=>{
  const f=await fixture(),scopeKey='turn:'+f.versionId
  await pool.query("UPDATE knowledge_claims SET scope_kind='task',scope_key=$2,canonical_repository_key=NULL WHERE claim_id=$1",[f.claimId,scopeKey])
  await pool.query('UPDATE knowledge_versions SET repository_id=NULL,branch=NULL WHERE version_id=$1',[f.versionId])
  const result=await createCandidateDeduper(pool).activeFamilyFor({installationId:f.installationId,claimType:'architecture_decision',scopeKey,statement,
   identity:{scopeKind:'task',scopeKey,canonicalRepositoryKey:null,branch:null,snapshotId:null,status:'verified',structuredContent:{},validFrom:null,validUntil:null}} as never)
  expect(result.exactClaimId).toBe(f.claimId)
 })
 test('same text with a different fact validity window is not an exact duplicate',async()=>{
  const f=await fixture()
  await pool.query("UPDATE knowledge_versions SET valid_from='2026-01-01',valid_until='2026-02-01' WHERE version_id=$1",[f.versionId])
  const result=await createCandidateDeduper(pool).activeFamilyFor({installationId:f.installationId,claimType:'architecture_decision',scopeKey:'main',statement,identity:{...identity('github.com/acme/repo-a',f.repositoryId),validFrom:'2026-02-01T00:00:00Z',validUntil:'2026-03-01T00:00:00Z'}} as never)
  expect(result.exactClaimId).toBeNull();expect(result.family).toHaveLength(1)
 })
 test('structured conditions remain part of duplicate equivalence',async()=>{
  const f=await fixture()
  const result=await createCandidateDeduper(pool).activeFamilyFor({installationId:f.installationId,claimType:'architecture_decision',scopeKey:'main',statement,identity:{...identity('github.com/acme/repo-a',f.repositoryId),structuredContent:{environment:'production'}}} as never)
  expect(result.exactClaimId).toBeNull()
 })
 const keys=[{version:'old',key:'old-test-tombstone-key'},{version:'new',key:'new-test-tombstone-key'}]
 test('new tombstones persist a separately domain-bound v2 digest for each configured rotation key',async()=>{
  const f=await fixture(),v2=createHash('sha256').update('confirmed-v2-identity').digest('hex')
  await insertKnowledgeTombstones(pool,{installationId:f.installationId,normalizedKeys:[key],normalizedKeysV2:[v2],keys,reason:'privacy_delete'} as never)
  const rows=(await pool.query('SELECT key_id,identity_hmac FROM knowledge_tombstones ORDER BY key_id,identity_hmac')).rows
  expect(rows).toHaveLength(4)
  for(const signing of keys){
   const expected=[tombstoneIdentityHmac(key,signing.key),tombstoneIdentityHmac('memory-claim-identity:v2:'+v2,signing.key)].map(b=>b.toString('hex')).sort()
   expect(rows.filter(r=>r.key_id===signing.version).map(r=>r.identity_hmac.toString('hex')).sort()).toEqual(expected)
  }
 })
 test('a v2-only historical tombstone is found while retaining irreversible v1 checks',async()=>{
  const f=await fixture(),v2=createHash('sha256').update('v2-only-test').digest('hex')
  await pool.query("INSERT INTO knowledge_tombstones(installation_id,key_id,identity_hmac,reason) VALUES($1,$2,$3,'privacy_delete')",[f.installationId,keys[0].version,tombstoneIdentityHmac('memory-claim-identity:v2:'+v2,keys[0].key)])
  const found=await findTombstonedNormalizedKeys(pool,{installationId:f.installationId,normalizedKeys:[key],identityV2ByNormalizedKey:{[key]:[v2]},keys} as never)
  expect(found.has(key)).toBe(true)
  await insertKnowledgeTombstones(pool,{installationId:f.installationId,normalizedKeys:['irreversible-legacy'],keys,reason:'privacy_delete'})
  expect((await findTombstonedNormalizedKeys(pool,{installationId:f.installationId,normalizedKeys:['irreversible-legacy'],keys})).has('irreversible-legacy')).toBe(true)
 })
})

import Fastify from 'fastify'
import {registerManageRoutes} from '../api/manage-routes.js'
import {createCorsHostPolicy} from '../auth/cors-host-policy.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {claimIdentityV2} from '../claims/identity.js'
suite('v2 privacy delete integration',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 test.each(['initial','corrected'])('actual privacy delete retains historical v1/v2 aliases across key rotation after %s version',async(path)=>{
  const f=await governanceFixture(pool),keys=[{version:'old',key:'old-delete-test-key'},{version:'new',key:'new-delete-test-key'}]
  const identity=claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',statement:'Transactional fixture invariant',canonicalRepositoryKey:null,branch:null,snapshotId:null,status:'verified'})
  await pool.query('UPDATE knowledge_claims SET identity_generation=2,normalized_key_v2=$2 WHERE claim_id=$1',[f.claim,identity.key])
  const app=Fastify()
  registerManageRoutes(app,{pool,guard:{guard:async()=>({installationId:f.personal,configVersion:'1'})} as never,
    policy:createCorsHostPolicy({allowedHosts:['localhost'],allowedOrigins:[],isProduction:false}),textConfigured:false,embeddingConfigured:false,tombstoneHmacKeys:keys})
  try{
   if(path==='corrected'){
    const episode=(await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1',[f.personal])).rows[0].episode_id
    const correctedStatement='Updated transactional fixture invariant'
    const correction=await app.inject({method:'POST',url:`/api/v1/memory/claims/${f.claim}/correct`,headers:{'idempotency-key':'correct-v2'},payload:{expected_revision:1,statement:correctedStatement,evidence:[{evidence_kind:'episode',episode_id:episode,excerpt:'The updated invariant is verified',occurred_at:new Date().toISOString()}]}})
    expect(correction.statusCode).toBe(200)
    const expected=claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',statement:correctedStatement,canonicalRepositoryKey:null,branch:null,snapshotId:null,status:'verified'}).key
    expect((await pool.query('SELECT normalized_key_v2 FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0].normalized_key_v2).toBe(expected)
   }
   const response=await app.inject({method:'DELETE' ,url:`/api/v1/memory/claims/${f.claim}`,headers:{'idempotency-key':'delete-v2'},payload:{expected_revision:path==='corrected'?2:1}})
   expect(response.statusCode).toBe(200)
   expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0].n).toBe(0)
   const alias='a-different-legacy-alias-after-migration'
   expect((await findTombstonedNormalizedKeys(pool,{installationId:f.personal,normalizedKeys:[alias],identityV2ByNormalizedKey:{[alias]:[identity.key]},keys})).has(alias)).toBe(true)
   const old=normalizedClaimKey({claimType:'test_invariant',scopeKey:'',statement:'Transactional fixture invariant'})
   expect((await findTombstonedNormalizedKeys(pool,{installationId:f.personal,normalizedKeys:[old],keys})).has(old)).toBe(true)
  }finally{await app.close()}
 })
})

import {createClaimRepository} from '../claims/repository.js'
suite('v2 correction integrity gate',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 async function correction(){
  const f=await governanceFixture(pool),statement='Corrected v2 invariant',keys=[{version:'test',key:'correction-privacy-test-key'}]
  const identity=(body:string)=>claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',statement:body,canonicalRepositoryKey:null,branch:null,snapshotId:null,status:'verified'}).key
  await pool.query('UPDATE knowledge_claims SET identity_generation=2,normalized_key_v2=$2 WHERE claim_id=$1',[f.claim,identity('Transactional fixture invariant')])
  const episode=(await pool.query('SELECT episode_id FROM work_episodes WHERE installation_id=$1',[f.personal])).rows[0].episode_id
  return{f,keys,identity,input:{installationId:f.personal,claimId:f.claim,statement,expectedRevision:1,evidence:[{evidenceKind:'episode' as const,episodeId:episode,locator:{},excerpt:'The corrected invariant is supported',occurredAt:new Date()}]}}
 }
 test('a corrupt persisted v2 identity cannot be silently carried into a corrected version',async()=>{
  const {f,keys,input}=await correction()
  await pool.query('UPDATE knowledge_claims SET normalized_key_v2=$2 WHERE claim_id=$1',[f.claim,'f'.repeat(64)])
  expect(await createClaimRepository(pool,{tombstoneHmacKeys:keys}).correctClaim(input)).toMatchObject({ok:false,error:{code:'identity_requires_review'}})
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions')).rows[0].n).toBe(1)
 })
 test.each([1,2])('generation %s correction cannot revive a v2-only privacy-deleted identity',async(generation)=>{
  const {f,keys,input,identity}=await correction()
  if(generation===1) await pool.query('UPDATE knowledge_claims SET identity_generation=1,normalized_key_v2=NULL WHERE claim_id=$1',[f.claim])
  await insertKnowledgeTombstones(pool,{installationId:f.personal,normalizedKeys:[],normalizedKeysV2:[identity(input.statement)],reason:'privacy_delete',keys})
  expect(await createClaimRepository(pool,{tombstoneHmacKeys:keys}).correctClaim(input)).toMatchObject({ok:false,error:{code:'tombstoned_identity'}})
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions')).rows[0].n).toBe(1)
  expect((await pool.query('SELECT identity_generation,normalized_key_v2 FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0]).toMatchObject({identity_generation:generation,normalized_key_v2:generation===1?null:identity('Transactional fixture invariant')})
 })
})

import {createPurgeRepository} from '../purge/repository.js'
suite('v2 source purge privacy bridge',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 test('purging a legacy source-bound revision rekeys the surviving v2 head without reviving the removed identity',async()=>{
  const f=await governanceFixture(pool),keys=[{version:'test',key:'purge-repoint-test-key'}]
  const identity=(statement:string)=>claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',statement,canonicalRepositoryKey:null,branch:null,snapshotId:null,status:'verified'}).key
  await pool.query('UPDATE knowledge_claims SET identity_generation=2,normalized_key_v2=$2 WHERE claim_id=$1',[f.claim,identity('Transactional fixture invariant')])
  const session='corrected-source-session'
  await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[f.personal,session])
  const episode=(await pool.query("INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,gen_random_uuid(),$2,'correction-turn','ready','fixture') RETURNING episode_id",[f.personal,session])).rows[0].episode_id
  const statement='Invariant from the source to be purged'
  expect(await createClaimRepository(pool,{tombstoneHmacKeys:keys}).correctClaim({installationId:f.personal,claimId:f.claim,expectedRevision:1,statement,evidence:[{evidenceKind:'episode',episodeId:episode,locator:{},excerpt:statement,occurredAt:new Date()}]})).toMatchObject({ok:true})
  // Current corrections detach accepted excerpts intentionally. Seed the historical source-bound format being migrated.
  await pool.query("UPDATE knowledge_evidence SET episode_id=$2,evidence_kind='episode',capsule_id=NULL WHERE version_id=(SELECT current_version_id FROM knowledge_claims WHERE claim_id=$1)",[f.claim,episode])
  await createPurgeRepository(pool,{hmacKey:'isolated-purge-repoint',tombstoneHmacKeys:keys}).purgeSession({installationId:f.personal,sessionId:session,reason:'privacy',sourceFeedId:null})
  expect((await pool.query('SELECT c.normalized_key_v2,v.statement FROM knowledge_claims c JOIN knowledge_versions v ON v.version_id=c.current_version_id WHERE c.claim_id=$1',[f.claim])).rows[0]).toEqual({normalized_key_v2:identity('Transactional fixture invariant'),statement:'Transactional fixture invariant'})
  const alias='new-import-legacy-alias'
  expect((await findTombstonedNormalizedKeys(pool,{installationId:f.personal,normalizedKeys:[alias],identityV2ByNormalizedKey:{[alias]:[identity(statement)]},keys})).has(alias)).toBe(true)
 })
 test.each([1,2])('generation %s source purge retains provable v2 privacy identity',async generation=>{
  const f=await governanceFixture(pool),keys=[{version:'old',key:'source-purge-old-key'},{version:'new',key:'source-purge-new-key'}]
  const identity=claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',statement:'Transactional fixture invariant',canonicalRepositoryKey:null,branch:null,snapshotId:null,status:'verified'}).key
  if(generation===2)await pool.query('UPDATE knowledge_claims SET identity_generation=2,normalized_key_v2=$2 WHERE claim_id=$1',[f.claim,identity])
  const session=(await pool.query('SELECT session_id FROM work_episodes WHERE installation_id=$1',[f.personal])).rows[0].session_id
  await createPurgeRepository(pool,{hmacKey:'isolated-source-purge-key',tombstoneHmacKeys:keys}).purgeSession({installationId:f.personal,sessionId:session,reason:'privacy',sourceFeedId:null})
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0].n).toBe(0)
  const alias='post-migration-different-legacy-alias'
  expect((await findTombstonedNormalizedKeys(pool,{installationId:f.personal,normalizedKeys:[alias],identityV2ByNormalizedKey:{[alias]:[identity]},keys})).has(alias)).toBe(true)
 })
})
