import {createHash,randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {governanceFixture} from '../testing/governance-fixture.js'
import {claimIdentityV2,claimDuplicateDigestV2} from '../claims/identity.js'
import {insertKnowledgeTombstones,findTombstonedNormalizedKeys} from '../claims/tombstones.js'
import {normalizedClaimKey} from '../retrieval/query-normalizer.js'
import {createPurgeRepository} from '../purge/repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('source purge cannot repoint to a tombstoned identity',()=>{
 let pool:pg.Pool
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 beforeEach(async()=>{await pool.query('TRUNCATE memory_installations CASCADE')})
 afterAll(async()=>{await pool?.end()})
 const keys=[{version:'old',key:'source-repoint-old-tombstone-key'},{version:'new',key:'source-repoint-new-tombstone-key'}]
 const previousStatement='Transactional fixture invariant'
 const currentStatement='The source version must be removed'
 const identity=(statement:string)=>claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,
  snapshotId:null,branch:null,statement,status:'verified'}).key
 const duplicate=(statement:string,validUntil:string|null)=>claimDuplicateDigestV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,
  repositoryId:null,snapshotId:null,branch:null,statement,status:'verified',structuredContent:{},validFrom:null,validUntil})

 async function fixture(generation:number){
  const f=await governanceFixture(pool),session='purged-repoint-source',version=randomUUID(),episode=randomUUID(),boundary='2026-01-01T00:00:00.000Z'
  await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[f.personal,session])
  await pool.query("INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version) VALUES($1,$2,$3,'purged-source-turn','ready','fixture')",[f.personal,episode,session])
  await pool.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,valid_from) VALUES($1,$2,$3,2,$4,'user_corrected',0.9,$5)",[version,f.personal,f.claim,currentStatement,boundary])
  await pool.query("INSERT INTO knowledge_evidence(evidence_id,installation_id,version_id,episode_id,ordinal,evidence_kind,excerpt,excerpt_hash,occurred_at) VALUES(gen_random_uuid(),$1,$2,$3,1,'episode',$4,$5,NOW())",[f.personal,version,episode,currentStatement,createHash('sha256').update(currentStatement).digest()])
  await pool.query('UPDATE knowledge_versions SET valid_until=$2 WHERE version_id=$1',[f.version,boundary])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2,identity_generation=$3,normalized_key=$4,normalized_key_v2=$5 WHERE claim_id=$1',
   [f.claim,version,generation,normalizedClaimKey({claimType:'test_invariant',scopeKey:'',statement:currentStatement}),generation===2?identity(currentStatement):null])
  return{...f,session,currentVersion:version,boundary}
 }
 test.each(['different_conditions','different_variant','revoked','superseded','corrupt_shadow'] as const)('repoint preserves legal surviving facts beside %s old aliases',async scenario=>{
  const f=await fixture(2),other=randomUUID(),otherVersion=randomUUID()
  await pool.query("INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,conflict_variant) VALUES($1,$2,'test_invariant','installation','',$3,$4,$5)",
   [other,f.personal,normalizedClaimKey({claimType:'test_invariant',scopeKey:'',statement:previousStatement}),['revoked','superseded'].includes(scenario)?scenario:'active',scenario==='different_variant'?1:0])
  await pool.query("INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence) VALUES($1,$2,$3,1,$4,$5,'user_accepted',0.9)",
   [otherVersion,f.personal,other,previousStatement,scenario==='different_conditions'?{environment:'other'}:{}])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[other,otherVersion])
  if(scenario==='corrupt_shadow')await pool.query('UPDATE knowledge_claims SET normalized_key_v2=$2,topic_key_v2=$3,duplicate_digest_v2=$4 WHERE claim_id=$1',[other,identity(previousStatement),'a'.repeat(64),duplicate(previousStatement,null)])
  await createPurgeRepository(pool,{hmacKey:'source-repoint-purge-receipt',tombstoneHmacKeys:keys}).purgeSession({installationId:f.personal,sessionId:f.session,reason:'privacy',sourceFeedId:null})
  const row=(await pool.query('SELECT state,current_version_id,superseded_by_claim_id,consumption_hold_reason FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0]
  expect(row).toMatchObject({state:'active',current_version_id:f.version,superseded_by_claim_id:null,consumption_hold_reason:scenario==='different_conditions'?'identity_migration_required':scenario==='corrupt_shadow'?'identity_requires_review':null})
  expect((await pool.query('SELECT valid_until FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].valid_until?.toISOString()??null).toBe(['different_conditions','corrupt_shadow'].includes(scenario)?f.boundary:null)
 })
 test.each([1,2].flatMap(generation=>['v1','v2'].map(kind=>({generation,kind}))))('generation $generation does not reopen a $kind-deleted historical replacement',async({generation,kind})=>{
  const f=await fixture(generation)
  await insertKnowledgeTombstones(pool,{installationId:f.personal,
   normalizedKeys:kind==='v1'?[normalizedClaimKey({claimType:'test_invariant',scopeKey:'',statement:previousStatement})]:[],
   normalizedKeysV2:kind==='v2'?[identity(previousStatement)]:[],reason:'privacy_delete',keys:[keys[0]]})
  await createPurgeRepository(pool,{hmacKey:'source-repoint-purge-receipt',tombstoneHmacKeys:keys}).purgeSession({installationId:f.personal,sessionId:f.session,reason:'privacy',sourceFeedId:null})
  const claim=(await pool.query('SELECT current_version_id,consumption_hold_reason,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2 FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0]
  expect(claim).toEqual({current_version_id:f.version,consumption_hold_reason:'tombstoned_identity',identity_generation:generation,
   normalized_key_v2:identity(previousStatement),topic_key_v2:claimIdentityV2({claimType:'test_invariant',scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,
    snapshotId:null,branch:null,statement:previousStatement,status:'verified'}).topicKey,duplicate_digest_v2:duplicate(previousStatement,f.boundary)})
  expect((await pool.query('SELECT valid_until FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].valid_until.toISOString()).toBe(f.boundary)
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions WHERE version_id=$1',[f.currentVersion])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM work_episodes WHERE installation_id=$1 AND session_id=$2',[f.personal,f.session])).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND job_type='index_claim_version'",[f.personal])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[f.personal,f.session])).rows[0].n).toBe(1)
 })
 test('an independently evidenced replacement without a tombstone still reopens and reindexes',async()=>{
  const f=await fixture(2)
  await createPurgeRepository(pool,{hmacKey:'source-repoint-purge-receipt',tombstoneHmacKeys:keys}).purgeSession({installationId:f.personal,sessionId:f.session,reason:'privacy',sourceFeedId:null})
  const row=(await pool.query('SELECT current_version_id,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2,consumption_hold_reason FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0]
  expect(row).toMatchObject({current_version_id:f.version,identity_generation:2,normalized_key_v2:identity(previousStatement),consumption_hold_reason:null,
   duplicate_digest_v2:duplicate(previousStatement,null)})
  expect(row.topic_key_v2).toMatch(/^[a-f0-9]{64}$/)
  expect(row.duplicate_digest_v2).not.toBe(duplicate(previousStatement,f.boundary))
  expect((await pool.query('SELECT valid_until FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].valid_until).toBeNull()
  expect((await pool.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND job_type='index_claim_version'",[f.personal])).rows[0].n).toBe(1)
 })
 test('an unavailable historical HMAC key holds replacement even when its retained digest is unrelated',async()=>{
  const f=await fixture(2)
  await insertKnowledgeTombstones(pool,{installationId:f.personal,normalizedKeys:['unrelated-irreversible-old-identity'],
   reason:'privacy_delete',keys:[keys[0]]})
  await createPurgeRepository(pool,{hmacKey:'source-repoint-purge-receipt',tombstoneHmacKeys:[keys[1]]}).purgeSession({installationId:f.personal,sessionId:f.session,reason:'privacy',sourceFeedId:null})
  expect((await pool.query('SELECT current_version_id,consumption_hold_reason FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0])
   .toEqual({current_version_id:f.version,consumption_hold_reason:'tombstone_hmac_keyring_incomplete'})
  expect((await pool.query('SELECT valid_until FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].valid_until.toISOString()).toBe(f.boundary)
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions WHERE version_id=$1',[f.currentVersion])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[f.personal,f.session])).rows[0].n).toBe(1)
  expect((await pool.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND job_type='index_claim_version'",[f.personal])).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int AS n FROM knowledge_tombstones WHERE installation_id=$1 AND key_id='old'",[f.personal])).rows[0].n).toBe(1)
 })
 test.each(['v1','v2'])('purging an older source cannot leave a %s-deleted current identity consumable',async kind=>{
  const f=await fixture(2)
  const originalEpisode=(await pool.query('SELECT episode_id FROM knowledge_evidence WHERE version_id=$1',[f.version])).rows[0].episode_id
  const purgedEpisode=(await pool.query('SELECT episode_id FROM knowledge_evidence WHERE version_id=$1',[f.currentVersion])).rows[0].episode_id
  // The current Version is independently evidenced; only the historical
  // Version depends on this source, exercising the no-reindex repoint path.
  await pool.query('UPDATE knowledge_evidence SET episode_id=$2 WHERE version_id=$1',[f.version,purgedEpisode])
  await pool.query('UPDATE knowledge_evidence SET episode_id=$2 WHERE version_id=$1',[f.currentVersion,originalEpisode])
  await insertKnowledgeTombstones(pool,{installationId:f.personal,
   normalizedKeys:kind==='v1'?[normalizedClaimKey({claimType:'test_invariant',scopeKey:'',statement:currentStatement})]:[],
   normalizedKeysV2:kind==='v2'?[identity(currentStatement)]:[],reason:'privacy_delete',keys:[keys[0]]})
  await createPurgeRepository(pool,{hmacKey:'source-repoint-purge-receipt',tombstoneHmacKeys:keys}).purgeSession({installationId:f.personal,sessionId:f.session,reason:'privacy',sourceFeedId:null})
  expect((await pool.query('SELECT current_version_id,consumption_hold_reason FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0])
   .toEqual({current_version_id:f.currentVersion,consumption_hold_reason:'tombstoned_identity'})
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].n).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS n FROM memory_session_tombstones WHERE installation_id=$1 AND session_id=$2',[f.personal,f.session])).rows[0].n).toBe(1)
 })
 test('an unknown historical repository identity stays held without fabricating mirrors or blocking source cleanup',async()=>{
  const f=await fixture(2),persistedKey=identity(currentStatement)
  await pool.query("UPDATE knowledge_claims SET scope_kind='branch',scope_key='main',canonical_repository_key=NULL,topic_key_v2=$2,duplicate_digest_v2=$3 WHERE claim_id=$1",[f.claim,'a'.repeat(64),'b'.repeat(64)])
  await pool.query("UPDATE knowledge_versions SET branch='main' WHERE claim_id=$1",[f.claim])
  await createPurgeRepository(pool,{hmacKey:'source-repoint-purge-receipt',tombstoneHmacKeys:keys}).purgeSession({installationId:f.personal,sessionId:f.session,reason:'privacy',sourceFeedId:null})
  expect((await pool.query('SELECT current_version_id,identity_generation,normalized_key_v2,topic_key_v2,duplicate_digest_v2,consumption_hold_reason FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0])
   .toEqual({current_version_id:f.version,identity_generation:2,normalized_key_v2:persistedKey,topic_key_v2:null,duplicate_digest_v2:null,consumption_hold_reason:'identity_requires_review'})
  expect((await pool.query('SELECT valid_until FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].valid_until.toISOString()).toBe(f.boundary)
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions WHERE version_id=$1',[f.currentVersion])).rows[0].n).toBe(0)
  expect((await pool.query("SELECT count(*)::int AS n FROM memory_jobs WHERE installation_id=$1 AND job_type='index_claim_version'",[f.personal])).rows[0].n).toBe(0)
 })
 test.each(['verified','legacy_unknown','requires_review'] as const)('source purge honors %s historical applicability independently of the current descriptor',async status=>{
  const f=await fixture(2),repository=randomUUID(),canonical='github.com/Acme/HistoricalRepo'
  const applicability={scopeKind:'branch' as const,scopeKey:'legacy-main',canonicalRepositoryKey:canonical,
   repositoryId:repository,snapshotId:null,branch:'legacy-main',status}
  await pool.query('INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at) VALUES($1,$2,$3,$4,NOW(),NOW())',
   [f.personal,repository,'historical-repo-alias','https://github.com/Acme/CurrentRegistryValue.git'])
  await pool.query('UPDATE knowledge_versions SET repository_id=$2,branch=$3,applicability=$4::jsonb WHERE version_id=$1',[f.version,repository,applicability.branch,JSON.stringify(applicability)])
  const originalEpisode=(await pool.query('SELECT episode_id FROM knowledge_evidence WHERE version_id=$1',[f.version])).rows[0].episode_id
  const purgedEpisode=(await pool.query('SELECT episode_id FROM knowledge_evidence WHERE version_id=$1',[f.currentVersion])).rows[0].episode_id
  await pool.query('UPDATE knowledge_evidence SET episode_id=$2 WHERE version_id=$1',[f.version,purgedEpisode])
  await pool.query('UPDATE knowledge_evidence SET episode_id=$2 WHERE version_id=$1',[f.currentVersion,originalEpisode])
  await createPurgeRepository(pool,{hmacKey:'source-repoint-purge-receipt',tombstoneHmacKeys:keys}).purgeSession({installationId:f.personal,sessionId:f.session,reason:'privacy',sourceFeedId:null})
  const historicalKey=claimIdentityV2({...applicability,status:'verified',claimType:'test_invariant',statement:previousStatement}).key
  const probe='post-migration-historical-alias'
  const found=await findTombstonedNormalizedKeys(pool,{installationId:f.personal,normalizedKeys:[probe],identityV2ByNormalizedKey:{[probe]:[historicalKey]},keys})
  expect(found.has(probe)).toBe(status==='verified')
  // Explicit historical metadata is not replaced with the current
  // installation-wide descriptor, even when historical identity is unknown.
  expect((await findTombstonedNormalizedKeys(pool,{installationId:f.personal,normalizedKeys:[probe],identityV2ByNormalizedKey:{[probe]:[identity(previousStatement)]},keys})).has(probe)).toBe(false)
  if(status==='verified'){
   const oldLegacy=normalizedClaimKey({claimType:'test_invariant',scopeKey:applicability.scopeKey,statement:previousStatement})
   expect((await findTombstonedNormalizedKeys(pool,{installationId:f.personal,normalizedKeys:[oldLegacy],keys})).has(oldLegacy)).toBe(true)
  }
  expect((await pool.query('SELECT current_version_id,consumption_hold_reason FROM knowledge_claims WHERE claim_id=$1',[f.claim])).rows[0])
   .toEqual({current_version_id:f.currentVersion,consumption_hold_reason:null})
  expect((await pool.query('SELECT count(*)::int AS n FROM knowledge_versions WHERE version_id=$1',[f.version])).rows[0].n).toBe(0)
 })
})
