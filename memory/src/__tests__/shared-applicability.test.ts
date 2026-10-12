import {describe,expect,test} from 'vitest'
import type pg from 'pg'
import {type SearchInput,createSearchService} from '../retrieval/search-service.js'
const installationId='11111111-1111-4111-8111-111111111111'
const row={version_id:'22222222-2222-4222-8222-222222222222',claim_id:'33333333-3333-4333-8333-333333333333',claim_type:'test_invariant',statement:'Release invariant',scope_kind:'installation',scope_key:'',valid_from:null,freshness_at:new Date('2026-01-01'),authority:'team_published',repository_id:null,repo_snapshot_id:null,branch:null,search_as_of:'2026-10-09T00:00:00.000Z'}
function search(facts:object|readonly object[],input:Partial<SearchInput>={}){
 const pool={query:async(sql:string,params:unknown[])=>{
  if(sql.includes('CROSS JOIN knowledge_claims'))return{rows:(Array.isArray(facts)?facts:[facts]).map(fact=>({...row,...fact}))}
  if(sql.includes('FROM memory_feature_settings'))return{rows:[]}
  if(sql.includes('candidate_documents'))return{rows:(params[1] as string[]).map(version_id=>({version_id}))}
  return{rows:[]}
 }} as unknown as pg.Pool
 return createSearchService({pool,recallEmbeddingTimeoutMs:50,cursorSigningKey:'isolated-consumption-test'}).search({installationId,query:'invariant',...input})
}
describe('shared applicability consumption bridge',()=>{
 test.each(['identity_requires_review','repository_mapping_missing','origin_policy_unverified'])('search excludes explicit %s holds before ranking',async consumption_hold_reason=>{
  expect((await search({consumption_hold_reason,applicability:null})).hits).toEqual([])
 })
 test.each(['legacy_unknown','requires_review'])('explicit %s applicability cannot enter search consumption',async status=>{
  expect((await search({consumption_hold_reason:null,applicability:{scopeKind:'installation',scopeKey:'',canonicalRepositoryKey:null,repositoryId:null,snapshotId:null,branch:null,status}})).hits).toEqual([])
 })
 test('malformed explicit applicability fails closed',async()=>{
  expect((await search({consumption_hold_reason:null,applicability:{status:'verified'}})).hits).toEqual([])
 })
 test('the unmigrated null-metadata bridge remains distinct from an explicit unknown',async()=>{
  expect((await search({consumption_hold_reason:null,applicability:null})).hits).toHaveLength(1)
 })
})

import {claimConsumptionDecision} from '../governance/applicability.js'
import * as applicability from '../governance/applicability.js'
import type {ClaimApplicability} from '../governance/revision-bundle.js'
const branchApp:ClaimApplicability={scopeKind:'branch',scopeKey:'main',canonicalRepositoryKey:'github.com/Acme/Repo',repositoryId:'local-repo',snapshotId:null,branch:'main',status:'verified'}
const facts=(app:ClaimApplicability)=>({scopeKind:app.scopeKind,scopeKey:app.scopeKey,canonicalRepositoryKey:app.canonicalRepositoryKey,repositoryId:app.repositoryId,snapshotId:app.snapshotId,branch:app.branch,applicability:app,consumptionHoldReason:null})
describe('explicit applicability boundaries',()=>{
 test('verified branch requires matching repository and exact branch context',()=>{
  expect(claimConsumptionDecision(facts(branchApp),{repositoryId:'local-repo',branch:'main'}).eligible).toBe(true)
  expect(claimConsumptionDecision(facts(branchApp),{repositoryId:'other-repo',branch:'main'}).eligible).toBe(false)
  expect(claimConsumptionDecision(facts(branchApp),{repositoryId:'local-repo',branch:'Main'}).eligible).toBe(false)
  expect(claimConsumptionDecision(facts(branchApp),{repositoryId:'local-repo'}).eligible).toBe(false)
 })
 test.each(['/Users/user/Repo','/repo','repo','https://github.com/Acme/Repo','github.com/Acme/../Repo'])('a local path or unconfirmed canonical frame %s cannot claim verified applicability',canonicalRepositoryKey=>{
  const app={...branchApp,canonicalRepositoryKey}
  expect(claimConsumptionDecision(facts(app),{repositoryId:'local-repo',branch:'main'}).eligible).toBe(false)
 })
 test('snapshot and task consumption require their own matching context',()=>{
  const snapshot={...branchApp,scopeKind:'snapshot' as const,snapshotId:'snapshot-a'}
  expect(claimConsumptionDecision(facts(snapshot),{repositoryId:'local-repo',snapshotId:'snapshot-a'}).eligible).toBe(true)
  expect(claimConsumptionDecision(facts(snapshot),{repositoryId:'local-repo',snapshotId:'snapshot-b'}).eligible).toBe(false)
  const task={...branchApp,scopeKind:'task' as const,scopeKey:'turn-a',canonicalRepositoryKey:null,repositoryId:null,branch:null}
  expect(claimConsumptionDecision(facts(task),{taskScopeKey:'turn-a'}).eligible).toBe(true)
  expect(claimConsumptionDecision(facts(task),{taskScopeKey:'turn-b'}).eligible).toBe(false)
 })
 test('mismatched claim projection never widens an otherwise valid bundle',()=>{
  expect(claimConsumptionDecision({...facts(branchApp),canonicalRepositoryKey:'github.com/Other/Repo'},{repositoryId:'local-repo',branch:'main'}).eligible).toBe(false)
  expect(claimConsumptionDecision({...facts(branchApp),scopeKind:'installation'},{repositoryId:'local-repo',branch:'main'}).eligible).toBe(false)
 })
 test('capture preserves explicit verified source applicability, including case',()=>{
  expect(applicability.captureSourceApplicability(facts(branchApp))).toEqual(branchApp)
 })
 test('capture does not guess non-installation applicability from legacy fields',()=>{
  expect(applicability.captureSourceApplicability({...facts(branchApp),applicability:null})).toMatchObject({scopeKind:'branch',branch:'main',status:'legacy_unknown'})
 })
 test('capture downgrades inconsistent source metadata instead of promoting it as verified',()=>{
  expect(applicability.captureSourceApplicability({...facts(branchApp),repositoryId:'other-repo'})).toMatchObject({scopeKind:'branch',repositoryId:'other-repo',status:'requires_review'})
 })
})

describe('applicability cursor identity',()=>{
 test('task context changes invalidate a cursor instead of replaying another task slice',async()=>{
  const rows=[{}, {version_id:'44444444-4444-4444-8444-444444444444',claim_id:'55555555-5555-4555-8555-555555555555'}]
  const first=await search(rows,{taskScopeKey:'task-a',limit:1})
  expect(first.nextCursor).toBeTruthy()
  await expect(search(rows,{taskScopeKey:'task-b',limit:1,cursor:first.nextCursor})).rejects.toThrow('invalid_cursor')
  expect((await search(rows,{taskScopeKey:'task-a',limit:1,cursor:first.nextCursor})).hits).toHaveLength(1)
 })
})
