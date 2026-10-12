import {beforeAll,describe,expect,test} from 'vitest'
import type {ClaimDuplicateInput} from '../claims/identity.js'
let classifier:any
beforeAll(async()=>{classifier=await import('../claims/'+'conflict-classifier.js').catch(()=>null)})
const facts=(statement:string,extra:Partial<ClaimDuplicateInput>={}):ClaimDuplicateInput=>({claimType:'test_invariant',scopeKind:'installation',scopeKey:'global',canonicalRepositoryKey:null,snapshotId:null,branch:null,status:'verified',statement,structuredContent:{},validFrom:null,validUntil:null,...extra})
function compare(a:ClaimDuplicateInput,b:ClaimDuplicateInput){expect(classifier,'classifier exists').not.toBeNull();return classifier.classifyClaimConflict(a,b)}
describe('exact duplicates, topic relations and review-only contradictions',()=>{
 test('identical facts are exact duplicates',()=>{expect(compare(facts('Enable caching'),facts('Enable caching')).relation).toBe('duplicate')})
 test.each([['Memory should enable caching','Memory should disable caching'],['Memory must cache requests','Memory must not cache requests'],['Memory 应开启缓存','Memory 应关闭缓存'],['允许缓存请求','禁止缓存请求']])('opposing statements stay potential conflicts: %s / %s',(a,b)=>{expect(compare(facts(a),facts(b)).relation).toBe('potential_conflict')})
 test('different explicit conditions remain related',()=>{expect(compare(facts('Enable caching',{structuredContent:{environment:'development'}}),facts('Disable caching',{structuredContent:{environment:'production'}})).relation).toBe('related')})
 test('different fact windows are not exact duplicates',()=>{expect(compare(facts('Enable caching',{validFrom:'2020-01-01',validUntil:'2021-01-01'}),facts('Enable caching',{validFrom:'2021-01-01',validUntil:'2022-01-01'})).relation).toBe('related')})
 test('opposing facts with disjoint half-open windows remain related',()=>{expect(compare(facts('Enable caching',{validUntil:'2021-01-01'}),facts('Disable caching',{validFrom:'2021-01-01'})).relation).toBe('related')})
 test('overlapping windows preserve the potential contradiction',()=>{expect(compare(facts('Enable caching',{validUntil:'2022-01-01'}),facts('Disable caching',{validFrom:'2021-01-01'})).relation).toBe('potential_conflict')})
 test('nearby supplementary topics do not establish a contradiction',()=>{expect(compare(facts('Vitest files live next to sources'),facts('Vitest files live next to sources and cover every module')).relation).toBe('related')})
 test('opposite wording with different in-text guards is not a proved contradiction',()=>{expect(compare(facts('Enable caching in development'),facts('Disable caching in production')).relation).toBe('related')})
 test('case-sensitive identifiers do not become exact duplicates',()=>{expect(compare(facts('Call verifyToken before publishing'),facts('Call verifytoken before publishing')).relation).not.toBe('duplicate')})
 test('same scope label in another confirmed repository is outside this comparison',()=>{const f=facts('Enable caching',{scopeKind:'branch',scopeKey:'main',branch:'main',canonicalRepositoryKey:'github.com/acme/a'});expect(compare(f,{...f,canonicalRepositoryKey:'github.com/acme/b'}).relation).toBe('unrelated')})
 test('unverified applicability never yields semantic evidence',()=>{expect(compare(facts('Enable caching',{status:'requires_review'}),facts('Disable caching')).relation).toBe('unrelated')})
 test('inverted time is a review requirement, never an exact duplicate',()=>{const f=facts('Enable caching',{validFrom:'2022-01-01',validUntil:'2021-01-01'});expect(compare(f,f)).toMatchObject({relation:'potential_conflict',codes:['fact_window_requires_review']})})
 test('microsecond fact boundaries do not collapse into exact duplicates',()=>{expect(compare(facts('Enable caching',{validFrom:'2020-01-01T00:00:00.123456Z'}),facts('Enable caching',{validFrom:'2020-01-01T00:00:00.123789Z'})).relation).toBe('related')})
 test('different source metadata cannot be an exact duplicate',()=>{expect(compare(facts('Enable caching',{repositoryId:'repo-a'}),facts('Enable caching',{repositoryId:'repo-b'})).relation).toBe('related')})
 test.each([['TCP port must be 80','TCP port must be 443'],['Set cache_enabled=true','Set cache_enabled=false']])('opposing explicit values remain review hints: %s / %s',(a,b)=>{expect(compare(facts(a),facts(b)).relation).toBe('potential_conflict')})
 test('bounded suggestions retain the conflicting reference before weaker related topics',()=>{
  expect(classifier).not.toBeNull()
  const items=Array.from({length:9},(_,i)=>({claimId:'related-'+i,relation:'related',codes:['lexical_topic_only'],similarity:0.5}))
  const summary=classifier.summarizeClaimRelationships([...items,{claimId:'zzz-conflict',versionId:'exact-version',relation:'potential_conflict',codes:['opposing_polarity'],similarity:0.5}])
  expect(summary.items).toHaveLength(8);expect(summary.items[0]).toMatchObject({claimId:'zzz-conflict',versionId:'exact-version',relation:'potential_conflict'})
 })
})
