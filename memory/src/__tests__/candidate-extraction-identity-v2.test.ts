import {describe,expect,test,vi} from 'vitest'
import {createCandidateExtractor} from '../extraction/extractor.js'
import {validateCandidate} from '../extraction/validator.js'
import {claimIdentityV2} from '../claims/identity.js'
import type {ExtractionRepository} from '../extraction/repository.js'

const frame={scopeKind:'installation' as const,scopeKey:'global',canonicalRepositoryKey:null,
 repositoryId:null,snapshotId:null,branch:null,status:'verified' as const}
const candidate={claim_type:'test_invariant',statement:'Call verifyToken before publishing',confidence:0.9,
 scope_kind:'installation',scope_key:'global',structured_content:{environment:'production'},
 valid_from:'2026-01-01T00:00:00Z',valid_until:'2099-01-01T00:00:00Z',evidence_handles:['h0-aaaaaaaa']}
function fixture(output:unknown,identity=frame){
 const persistCandidates=vi.fn(async(_input:Parameters<ExtractionRepository['persistCandidates']>[0])=>undefined)
 const store={loadEpisodeForExtraction:async()=>({episodeId:'episode',turnId:'turn',sourceDigest:Buffer.from('digest'),
  document:{},manifest:{'h0-aaaaaaaa':{kind:'event'}},extractionMode:'enabled',repositoryId:null,repoSnapshotId:null,branch:null,
  sessionFirstRecordedAt:new Date(),hasPriorRunOnOldDigest:false,terminalAt:new Date(),outcome:'completed'}),
  reserveRun:async()=>({runId:'run',owner:true,existingState:null}),markRun:async()=>undefined,discardRun:async()=>undefined,persistCandidates}
 const deduper={identityFor:vi.fn(async()=>identity),tombstonedKeys:vi.fn(async()=>new Set<string>()),
  activeFamilyFor:vi.fn(async()=>({exactClaimId:null,family:[{claimId:'existing',statement:candidate.statement}]}))}
 const extractor=createCandidateExtractor({store:store as unknown as ExtractionRepository,deduper:deduper as never,
  textGenerator:{generateJson:async()=>({ok:true,value:output,usage:{inputTokens:1,outputTokens:1,model:'m'}})} as never,
  provider:'test',model:'test',timeoutMs:5000})
 return{deduper,persistCandidates,run:()=>extractor.extract({installationId:'installation',turnId:'turn',signal:new AbortController().signal})}
}
describe('live extraction v2 identity contract',()=>{
 test('explicit no-exact result cannot be overridden by equal prose from a different validity/condition',()=>{
  const verdict=validateCandidate({claimType:'test_invariant',statement:candidate.statement,scopeKind:'installation',scopeKey:'global',
   repositoryId:null,repoSnapshotId:null,branch:null,validUntil:null,evidenceHandles:['h0-aaaaaaaa'],normalizedKey:'legacy'},
  {manifestHandles:new Set(['h0-aaaaaaaa']),episode:{turnId:'turn',repositoryId:null,repoSnapshotId:null,branch:null},now:new Date(),
   tombstonedKeys:new Set(),activeFamily:[{claimId:'existing',statement:candidate.statement}],exactClaimId:null} as never)
  expect(verdict).toMatchObject({status:'validated',validation:{needs_human_review:true,relationships:[{claimId:'existing',relation:'related'}]}})
 })
 test('passes the server-resolved full frame, structured conditions and validity to active dedupe',async()=>{
  const f=fixture({candidates:[candidate]});await f.run()
  expect(f.deduper.activeFamilyFor).toHaveBeenCalledWith(expect.objectContaining({identity:expect.objectContaining({
   ...frame,structuredContent:candidate.structured_content,validFrom:new Date(candidate.valid_from),validUntil:new Date(candidate.valid_until)})}))
  expect(f.persistCandidates.mock.calls[0][0].candidates[0].status).toBe('validated')
 })
 test('checks the v2 tombstone domain in the actual extractor',async()=>{
  const f=fixture({candidates:[candidate]});await f.run()
  const key=claimIdentityV2({...frame,claimType:candidate.claim_type,statement:candidate.statement}).key
  expect(f.deduper.tombstonedKeys).toHaveBeenCalledWith(expect.objectContaining({
   identityV2ByNormalizedKey:expect.objectContaining({[`${candidate.claim_type}|global|${candidate.statement}`]:[key]})}))
 })
 test('quoted whitespace distinctions survive deduplication within one model response',async()=>{
  const f=fixture({candidates:[{...candidate,statement:'const value = "a  b"'},{...candidate,statement:'const value = "a b"'}]})
  await f.run();expect(f.persistCandidates.mock.calls[0][0].candidates).toHaveLength(2)
 })
 test('an unproven frame stays rejected and does not contribute active exact matches',async()=>{
  const f=fixture({candidates:[candidate]},{...frame,status:'requires_review'} as never)
  await f.run();expect(f.deduper.activeFamilyFor).not.toHaveBeenCalled()
  expect(f.persistCandidates.mock.calls[0][0].candidates[0]).toMatchObject({status:'rejected_by_validator',validation:{codes:expect.arrayContaining(['identity_requires_review'])}})
 })
})
