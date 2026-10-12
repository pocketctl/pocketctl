import {describe,test,expect} from 'vitest'
import {evaluateAutoPublication,assessSkillRisk} from '../skills/risk-policy.js'
import {skillDocumentHash,type SkillCandidateDocument} from '../skills/types.js'
import {rankAssistedCandidates,planAssistedWikiDiff,assistanceState} from '../governance/knowledge-assistance.js'
const document:SkillCandidateDocument={schema_version:'skill-candidate.v1',title:'Read source',trigger:'Locate a file',preconditions:['Repository present'],steps:[{instruction:'Read file',tool:'read_file',permissions:['repository:read'],operation:'read'}],validation:['Check source'],failure_handling:['Stop if missing'],rollback:['No writes'],source_tokens:['source:1']}
const hash=skillDocumentHash(document)
const facts={contentHash:hash,conflictingClaims:false,successes:[{episodeId:'e1',sessionId:'reader1',contentHash:hash,verified:true,sourceRootIds:['team:call1']},{episodeId:'e2',sessionId:'reader2',contentHash:hash,verified:true,sourceRootIds:['team:call1']}],deterministicValidation:{contentHash:hash,passed:true},replays:[{kind:'historical_session' as const,contentHash:hash,passed:true},{kind:'golden_task' as const,contentHash:hash,passed:true}],rollbackVerified:true}
describe('A4 assistance boundaries',()=>{
 test('two reader projections of one source cannot count as independent successes',()=>{expect(evaluateAutoPublication(document,facts)).toMatchObject({eligible:false,reasons:expect.arrayContaining(['independent_successes_missing'])})})
 test('unknown tools cannot become low risk from a read label',()=>{expect(assessSkillRisk({...document,steps:[{...document.steps[0],tool:'run_arbitrary_command'}]}).risk).toBe('unknown')})
 test('generated Wiki diff preserves manual and locked sections without authorizing writes',()=>{
  const result=planAssistedWikiDiff([{key:'manual',markdown:'Human text',authority:'manual'},{key:'locked',markdown:'Protected text',authority:'locked'},{key:'generated',markdown:'Old model text',authority:'generated'}],[{key:'manual',markdown:'Model replacement'},{key:'locked',markdown:'Model replacement'},{key:'generated',markdown:'New model text'}])
  expect(result.map(r=>[r.key,r.action])).toEqual([['manual','preserve'],['locked','preserve'],['generated','review_diff']])
  expect(result[0].next).toBe('Human text');expect(result[1].next).toBe('Protected text')
 })
 test('eligible advice is distinct from closed product gate and never tool permission',()=>{
  expect(assistanceState({eligible:true,productGateOpen:false})).toEqual({state:'product_gate_closed',toolAuthorization:false})
  expect(assistanceState({eligible:true,productGateOpen:true})).toEqual({state:'eligible',toolAuthorization:false})
  expect(assistanceState({eligible:false,productGateOpen:false})).toEqual({state:'draft',toolAuthorization:false})
 })
 test('omitted protected Wiki sections remain in the review diff',()=>{expect(planAssistedWikiDiff([{key:'locked',markdown:'Exact protected bytes',authority:'locked'}],[])).toMatchObject([{key:'locked',next:'Exact protected bytes',action:'preserve'}])})
 test('observed independent success and distinct evidence order the bounded page',()=>{expect(rankAssistedCandidates([{id:'new',independentSuccesses:0,evidenceQuality:10},{id:'verified',independentSuccesses:2,evidenceQuality:2},{id:'strong',independentSuccesses:2,evidenceQuality:3}]).map(c=>c.id)).toEqual(['strong','verified','new'])})

})
