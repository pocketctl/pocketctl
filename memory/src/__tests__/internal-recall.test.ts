import {recallPoolBudget,diversifyRecall} from '../retrieval/recall-pools.js'
import {describe,expect,test,vi} from 'vitest'
import {createContextRetrieval} from '../context/retrieval.js'
import type {SearchHit} from '../retrieval/search-service.js'
const hit=(id:string,score:number,extra:Partial<SearchHit>={}):SearchHit=>({versionId:id,claimId:id,claimType:'test_invariant',statement:`Fact ${id}`,
 scopeKind:'installation',scopeKey:'',freshnessAt:null,authority:'user_accepted',repositoryId:null,repoSnapshotId:null,branch:null,
 score,sources:['lexical'],vectorSimilarity:null,...extra})
const result=(hits:SearchHit[])=>({hits,nextCursor:null,degradedComponents:[],poolSizes:{lexical:hits.length}})
const input={installationId:'installation',query:'relevant fact',limit:1,requestKey:{keyId:'k',hmacKey:Buffer.alloc(32,1)}}
describe('internal Context recall contract',()=>{
 test('Context sees authorized candidates beyond the user-facing top twenty',async()=>{
  const first=Array.from({length:20},(_,i)=>hit(`first-${i}`,.01))
  const tail=hit('relevant-tail',.009,{authority:'user_corrected',freshnessAt:new Date(),scopeKind:'task'})
  const search={search:vi.fn(async()=>result(first)),internalRecall:vi.fn(async()=>result([...first,tail]))}
  const trajectory={record:vi.fn(async()=>'trajectory')}
  const recalled=await createContextRetrieval({pool:{} as never,search:search as never,trajectory:trajectory as never}).retrieve(input)
  expect(recalled.candidates[0]?.versionId).toBe('relevant-tail')
  expect(search.internalRecall).toHaveBeenCalledOnce()
  expect(search.search).not.toHaveBeenCalled()
 })
 test('Context consumes the fused score once instead of rebuilding ranks from fused output',async()=>{
  const search={search:vi.fn(async()=>result([hit('a',.001),hit('b',.02)]))}
  const recalled=await createContextRetrieval({pool:{} as never,search:search as never,trajectory:{record:async()=>'trajectory'} as never}).retrieve(input)
  expect(recalled.candidates[0]?.versionId).toBe('b')
 })
 test('an unavailable internal backend produces a failed trajectory without calling user search',async()=>{
  const search={search:vi.fn(async()=>result([hit('unreviewed',1)])),internalRecall:vi.fn(async()=>{throw new Error('unavailable')})}
  const trajectory={record:vi.fn(async()=>'trajectory')}
  const recalled=await createContextRetrieval({pool:{} as never,search:search as never,trajectory:trajectory as never}).retrieve(input)
  expect(recalled).toMatchObject({outcome:'retrieval_failed',candidates:[]})
  expect(search.search).not.toHaveBeenCalled()
 })
 test('independent budgets and deterministic diversity remain bounded',()=>{
  expect(recallPoolBudget(5000)).toBe(200)
  expect(()=>recallPoolBudget(NaN)).toThrow('invalid_recall_pool_budget')
  const items=[{id:'a',text:'retain exact evidence source',score:1},{id:'b',text:'retain exact evidence source',score:.99},{id:'c',text:'different runtime invariant',score:.98}]
  const ranked=diversifyRecall(items,{score:i=>i.score,text:i=>i.text,id:i=>i.id,limit:2})
  expect(ranked.map(i=>i.id)).toEqual(['a','c','b'])
 })

})
