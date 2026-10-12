import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { insertWikiCandidateFixture } from './helpers/phase4-wiki-fixture.js'
import { createWikiPublicationService } from '../wiki/publication-service.js'
import { createContextCompiler } from '../context/compiler.js'
import { createAdmissionService } from '../context/admission-service.js'
import { createContextRetrieval } from '../context/retrieval.js'
import { createScopeResolver } from '../context/scope-resolver.js'
import { createLoadoutRepository } from '../context/loadout-repository.js'
import { createContextSettingsRepository } from '../context/settings-repository.js'
import { createPackRepository } from '../context/pack-repository.js'
import { createGenerationRunRepository } from '../generation/repository.js'
import { createPolicyRepository } from '../policies/repository.js'
import { createPolicyResolver } from '../policies/resolver.js'
import { createSearchService } from '../retrieval/search-service.js'
import { createTrajectoryRepository } from '../context/trajectory-repository.js'

const url=process.env.MEMORY_TEST_DATABASE_URL
const suite=url&&process.env.RUN_MEMORY_POSTGRES_INTEGRATION==='1'?describe:describe.skip
suite('selected Wiki Context consumption lifecycle',()=>{
 let pool:pg.Pool
 let f:Awaited<ReturnType<typeof insertWikiCandidateFixture>>
 let compiler:ReturnType<typeof createContextCompiler>
 let admission:ReturnType<typeof createAdmissionService>
 let reference:{source_kind:'wiki_section';source_id:string;source_version:string;owner_scope_id:string;installation_id:string}
 beforeAll(async()=>{pool=new pg.Pool({connectionString:url,max:4});await assertMemoryTestDatabase(pool,url!)})
 afterAll(async()=>{await pool?.end()})
 beforeEach(async()=>{
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await applyMemorySchema(pool)
  f=await insertWikiCandidateFixture(pool,'context-wiki')
  await createWikiPublicationService(pool).publish({grant:f.grant,targetInstallationId:f.installationId,wikiId:f.wikiId,runId:f.runId,expectedGeneration:1,expectedHeadRevision:0})
  const row=(await pool.query('SELECT section_id,wiki_version_id FROM memory_wiki_sections WHERE installation_id=$1 LIMIT 1',[f.installationId])).rows[0]
  reference={source_kind:'wiki_section',source_id:row.section_id,source_version:row.wiki_version_id,owner_scope_id:f.installationId,installation_id:f.installationId}
  await pool.query("INSERT INTO source_sessions(installation_id,session_id,first_recorded_at,last_recorded_at) VALUES($1,'ses-wiki',NOW(),NOW())",[f.installationId])
  const settings=createContextSettingsRepository(pool)
  await settings.upsert({installationId:f.installationId,scopeKind:'installation',scopeKey:'global',agent:null,mode:'enabled',maxTokens:null,expectedRevision:1})
  const search=createSearchService({pool,recallEmbeddingTimeoutMs:100,cursorSigningKey:'k'})
  compiler=createContextCompiler({pool,retrieval:createContextRetrieval({pool,search,trajectory:createTrajectoryRepository(pool)}),scope:createScopeResolver(pool),loadouts:createLoadoutRepository(pool),settings,packs:createPackRepository(pool),generation:createGenerationRunRepository(pool),policyResolver:createPolicyResolver({pool,repository:createPolicyRepository(pool)})})
  admission=createAdmissionService({pool,nonceHmacKey:Buffer.alloc(32,7)})
 },60000)
 const compile=(repositoryId=f.repositoryId,commitSha?:string)=>compiler.compile({installationId:f.installationId,sessionId:'ses-wiki',clientRequestId:'cr-wiki',agent:'codex',adapterCapability:'native_hidden_v1',repositoryId,commitSha,query:'wiki',requestKey:{keyId:'k',hmacKey:Buffer.alloc(32,3)},selectedReferences:[reference]})
 const admit=(packId:string)=>admission.admit({installationId:f.installationId,sessionId:'ses-wiki',clientRequestId:'cr-wiki',packId,agent:'codex',adapter:'codex-app-server',grantConfigVersion:'1',sharedGrantAuthorized:true})
 test('a live Wiki in its own repository compiles and consumes',async()=>{
  const result=await compile();expect(result.kind).toBe('ready');if(result.kind!=='ready')return
  const ticket=await admit(result.packId);expect(ticket.ok).toBe(true);if(!ticket.ok||!('nonce' in ticket))return
  expect((await admission.consume({installationId:f.installationId,sessionId:'ses-wiki',packId:result.packId,injectionId:ticket.injectionId,nonce:ticket.nonce})).ok).toBe(true)
 })
 test('a selected Wiki from another repository cannot enter the pack',async()=>{
  const other=crypto.randomUUID()
  await pool.query("INSERT INTO repositories(repository_id,installation_id,repository_key,first_observed_at,last_observed_at) VALUES($1,$2,'other',NOW(),NOW())",[other,f.installationId])
  expect((await compile(other)).kind).toBe('empty')
 })
 test('an exact matching code commit works without a separately registered repo snapshot',async()=>{
  expect((await compile(f.repositoryId,f.commitSha)).kind).toBe('ready')
 })
 test('an unknown different requested commit cannot consume the old active Wiki',async()=>{
  expect((await compile(f.repositoryId,'f'.repeat(40))).kind).toBe('empty')
 })
 test('a historical Wiki pack without a frozen consumption frame cannot mint a new ticket',async()=>{
  const result=await compile();if(result.kind!=='ready')throw new Error('fixture compilation failed')
  await pool.query('UPDATE memory_context_packs SET query_context=NULL,consumption_generation=NULL WHERE pack_id=$1',[result.packId])
  expect((await admit(result.packId)).ok).toBe(false)
  expect((await pool.query('SELECT 1 FROM memory_context_injections WHERE pack_id=$1',[result.packId])).rowCount).toBe(0)
 })
 test.each(['head_removed','source_tombstone'])('fresh compilation rejects %s despite retained active version rows',async change=>{
  if(change==='head_removed')await pool.query('DELETE FROM memory_wiki_heads WHERE installation_id=$1',[f.installationId])
  else await pool.query("INSERT INTO memory_source_snapshot_tombstones(installation_id,snapshot_id,repository_id,commit_sha,reason_code) VALUES($1,$2,$3,$4,'fixture')",[f.installationId,f.snapshotId,f.repositoryId,f.commitSha])
  expect((await compile()).kind).toBe('empty')
 })
 test.each(['version_revoked','head_removed','section_changed'])('an admitted Wiki ticket expires after %s without rewriting frozen bytes',async change=>{
  const result=await compile();if(result.kind!=='ready')throw new Error('fixture compilation failed')
  const ticket=await admit(result.packId);if(!ticket.ok||!('nonce' in ticket))throw new Error('fixture admission failed')
  const before=(await pool.query('SELECT stable_text,dynamic_text,stable_hash,dynamic_hash FROM memory_context_packs WHERE pack_id=$1',[result.packId])).rows[0]
  if(change==='version_revoked')await pool.query("UPDATE memory_wiki_versions SET state='superseded' WHERE wiki_version_id=$1",[reference.source_version])
  else if(change==='head_removed')await pool.query('DELETE FROM memory_wiki_heads WHERE installation_id=$1',[f.installationId])
  else await pool.query("UPDATE memory_wiki_sections SET markdown='changed content' WHERE wiki_version_id=$1 AND section_id=$2",[reference.source_version,reference.source_id])
  expect(await admission.consume({installationId:f.installationId,sessionId:'ses-wiki',packId:result.packId,injectionId:ticket.injectionId,nonce:ticket.nonce})).toEqual({ok:false,error:'expired'})
  expect((await pool.query('SELECT stable_text,dynamic_text,stable_hash,dynamic_hash FROM memory_context_packs WHERE pack_id=$1',[result.packId])).rows[0]).toEqual(before)
 })
})
