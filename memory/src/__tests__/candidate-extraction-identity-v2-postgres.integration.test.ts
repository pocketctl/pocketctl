import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,beforeAll,beforeEach,describe,expect,test} from 'vitest'
import {applyMemorySchema} from '../schema.js'
import {assertMemoryTestDatabase} from '../testing/test-db.js'
import {createExtractionRepository} from '../extraction/repository.js'
import {createCandidateExtractor} from '../extraction/extractor.js'
import {createCandidateDeduper} from '../extraction/deduper.js'
import {claimIdentityV2} from '../claims/identity.js'
import {insertKnowledgeTombstones} from '../claims/tombstones.js'
import {normalizedClaimKey} from '../retrieval/query-normalizer.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
const statement='Call verifyToken before publishing'
const keys=[{version:'extract-v2',key:'isolated-extraction-v2-tombstone-key'}]
suite('actual extraction v2 identity boundaries',()=>{
 let pool:pg.Pool,installationId:string,repositoryA:string,repositoryB:string
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!);await applyMemorySchema(pool)},60000)
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{
  await pool.query('TRUNCATE memory_installations CASCADE')
  installationId=randomUUID();repositoryA=randomUUID();repositoryB=randomUUID()
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
   VALUES($1,'pocketctl-memory','active','ready',1)`,[installationId])
  await pool.query("INSERT INTO memory_feature_settings(installation_id,extraction_mode) VALUES($1,'enabled')",[installationId])
  for(const [id,path] of [[repositoryA,'repo-a'],[repositoryB,'repo-b']])await pool.query(`INSERT INTO repositories
   (installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at)
   VALUES($1,$2,$3,$4,NOW(),NOW())`,[installationId,id,'same-directory-'+id,'https://github.com/acme/'+path+'.git'])
 })
 function frame(repositoryId:string|null){return{scopeKind:repositoryId?'branch' as const:'installation' as const,
  scopeKey:repositoryId?'main':'global',canonicalRepositoryKey:repositoryId===repositoryA?'github.com/acme/repo-a':repositoryId?'github.com/acme/repo-b':null,
  repositoryId,snapshotId:null,branch:repositoryId?'main':null,status:'verified' as const}}
 function proposal(repositoryId:string|null=repositoryA){return{claim_type:'test_invariant',statement,confidence:0.9,
  scope_kind:repositoryId?'branch':'installation',scope_key:repositoryId?'main':'global',repository_id:repositoryId,
  branch:repositoryId?'main':null,structured_content:{environment:'production'},valid_from:'2026-01-01T00:00:00Z',
  valid_until:'2099-01-01T00:00:00Z',evidence_handles:['h0-aaaaaaaa']}}
 async function seedClaim(content:Record<string,unknown>={environment:'production'}){
  const claimId=randomUUID(),versionId=randomUUID(),app=frame(repositoryA)
  const legacy=normalizedClaimKey({claimType:'test_invariant',scopeKey:'main',statement})
  await pool.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,state,canonical_repository_key,normalized_key_v2)
   VALUES($1,$2,'test_invariant','branch','main',$3,'active',$4,$5)`,[claimId,installationId,legacy,app.canonicalRepositoryKey,
    claimIdentityV2({...app,claimType:'test_invariant',statement}).key])
  await pool.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,structured_content,authority,confidence,
   repository_id,branch,valid_from,valid_until,applicability) VALUES($1,$2,$3,1,$4,$5,'user_accepted',0.9,$6,'main',$7,$8,$9)`,
   [versionId,installationId,claimId,statement,content,repositoryA,'2026-01-01T00:00:00Z','2099-01-01T00:00:00Z',app])
  await pool.query('UPDATE knowledge_claims SET current_version_id=$2 WHERE claim_id=$1',[claimId,versionId])
  return{claimId,versionId}
 }
 async function extract(candidates:Record<string,unknown>[],repositoryId:string|null=repositoryA,model=randomUUID()){
  const session=randomUUID(),turn=randomUUID(),episode=randomUUID()
  await pool.query('INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,$2,NOW(),NOW())',[installationId,session])
  await pool.query(`INSERT INTO work_episodes(installation_id,episode_id,session_id,turn_id,state,compiler_version,source_digest,document,evidence_manifest,
   document_compiler_version,compiled_at,repository_id,branch,terminal_at,outcome)
   VALUES($1,$2,$3,$4,'ready','fixture',$5,'{}',$6,'fixture',NOW(),$7,$8,NOW(),'completed')`,
   [installationId,episode,session,turn,Buffer.from('digest'),{'h0-aaaaaaaa':{kind:'event'}},repositoryId,repositoryId?'main':null])
  await createCandidateExtractor({store:createExtractionRepository(pool),deduper:createCandidateDeduper(pool,{tombstoneHmacKeys:keys}),
   textGenerator:{generateJson:async()=>({ok:true,value:{candidates},usage:{inputTokens:1,outputTokens:1,model}})} as never,
   provider:'test',model,timeoutMs:5000}).extract({installationId,turnId:turn,signal:new AbortController().signal})
  return(await pool.query('SELECT status,validation,statement,duplicate_of_claim_id FROM memory_candidates WHERE episode_id=$1 ORDER BY ordinal',[episode])).rows
 }
 test('two main branches under confirmed distinct repository remotes never become duplicates',async()=>{
  await seedClaim();const rows=await extract([proposal(repositoryB)],repositoryB)
  expect(rows[0]).toMatchObject({status:'validated',duplicate_of_claim_id:null})
 })
 test('identical prose with different structured applicability or validity stays reviewable',async()=>{
  await seedClaim({environment:'staging'})
  const rows=await extract([proposal(),{...proposal(),structured_content:{environment:'staging'},valid_from:'2027-01-01T00:00:00Z'}])
  expect(rows.map(r=>r.status)).toEqual(['validated','validated'])
  expect(rows.every(r=>r.duplicate_of_claim_id===null&&r.validation.needs_human_review
    &&r.validation.relationships[0].relation==='related')).toBe(true)
 })
 test.each(['corrupt_identity','corrupt_topic','corrupt_digest','requires_review'] as const)('current %s Claim does not enter exact or topic family',async(kind)=>{
  const c=await seedClaim()
  if(kind==='corrupt_identity')await pool.query('UPDATE knowledge_claims SET normalized_key_v2=$2 WHERE claim_id=$1',[c.claimId,'f'.repeat(64)])
  else if(kind==='corrupt_topic')await pool.query('UPDATE knowledge_claims SET topic_key_v2=$2 WHERE claim_id=$1',[c.claimId,'f'.repeat(64)])
  else if(kind==='corrupt_digest')await pool.query('UPDATE knowledge_claims SET duplicate_digest_v2=$2 WHERE claim_id=$1',[c.claimId,'f'.repeat(64)])
  else await pool.query('UPDATE knowledge_versions SET applicability=$2 WHERE version_id=$1',[c.versionId,{...frame(repositoryA),status:'requires_review'}])
  expect((await extract([proposal()]))[0].status).toBe('validated')
 })
 test('missing registry remote proof rejects new input without guessing its repository key',async()=>{
  await pool.query('UPDATE repositories SET canonical_remote=NULL WHERE repository_id=$1',[repositoryA])
  expect((await extract([proposal()]))[0]).toMatchObject({status:'rejected_by_validator',validation:{codes:expect.arrayContaining(['identity_requires_review'])}})
 })
 test('live v2-only tombstone rejects only its own identity despite the same v1 whitespace alias',async()=>{
  const a='const value = "a  b"',b='const value = "a b"'
  await insertKnowledgeTombstones(pool,{installationId,normalizedKeys:[],normalizedKeysV2:[claimIdentityV2({...frame(null),claimType:'test_invariant',statement:a}).key],reason:'privacy_delete',keys})
  const rows=await extract([{...proposal(null),statement:a},{...proposal(null),statement:b}],null)
  expect(rows.map(r=>r.status)).toEqual(['rejected_by_validator','validated'])
  expect(rows[0].validation.codes).toContain('tombstoned_identity')
 })
 test('pending queue preserves quoted whitespace, case, structured conditions and validity, then dedupes complete repeats',async()=>{
  const base={...proposal(null),statement:'const value = "a  b"'}
  const candidates=[base,{...base,statement:'const value = "a b"'},{...base,statement:'const Value = "a  b"'},
   {...base,structured_content:{environment:'staging'}},{...base,valid_from:'2027-01-01T00:00:00Z'}]
  expect((await extract(candidates,null)).map(r=>r.status)).toEqual(candidates.map(()=>'validated'))
  expect((await extract(candidates,null)).map(r=>r.status)).toEqual(candidates.map(()=>'duplicate'))
 })
 test('explicit unknown applicability on a historical pending row cannot suppress a new verified candidate',async()=>{
  const candidate=proposal(null)
  await extract([candidate],null)
  await pool.query(`UPDATE memory_candidates SET validation=jsonb_set(validation,'{applicability,status}','"requires_review"'::jsonb)
   WHERE installation_id=$1`,[installationId])
  expect((await extract([candidate],null))[0].status).toBe('validated')
 })
})
