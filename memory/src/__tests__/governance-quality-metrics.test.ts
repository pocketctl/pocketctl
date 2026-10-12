import * as claims from '../claims/repository.js'
import {describe,test,expect} from 'vitest'
import {GoldenDatasetSchema} from '../eval/schema.js'
import * as evaluator from '../eval/runner.js'
const helpers=evaluator as unknown as {wilsonInterval(success:number,total:number):{low:number;high:number}|null;groupQualityCases(cases:unknown[]):Record<string,unknown>}
const base={schema_version:2,dataset_version:'governance-golden-v1',evaluator_version:'memory-governance-eval-v2',created_at:'2026-10-01T00:00:00Z',
 split_windows:{suggestions_end:'2026-08-01T00:00:00Z',calibration_end:'2026-09-01T00:00:00Z'},cases:[{
 id:'holdout-one',schema_version:2,query:'known build invariant',installation_id:'11111111-1111-4111-8111-111111111111',
 allowed:{repository_ids:[],repo_snapshot_ids:[],branches:[]},expected:{claim_ids:[],evidence_claim_ids:[],current_version_ids:[]},
 split:'holdout',lineage:{source_task_id:'task-holdout',repository_group:'repo-holdout',source_digest:'a'.repeat(64),observed_at:'2026-09-10T00:00:00Z'},
 label:{provenance:'synthetic_curated',evidence_support:'supported'},review_outcome:'accepted_as_is'}]}
describe('frozen governance evaluation contract',()=>{
 test('accepts versioned provenance, split windows and current-version labels',()=>{expect(GoldenDatasetSchema.safeParse(base).success).toBe(true)})
 test('rejects the same source task across suggestion and holdout partitions',()=>{
  const second={...base.cases[0],id:'suggestion-two',split:'suggestions',lineage:{...base.cases[0].lineage,repository_group:'other-repo',source_digest:'b'.repeat(64),observed_at:'2026-07-01T00:00:00Z'}}
  expect(GoldenDatasetSchema.safeParse({...base,cases:[...base.cases,second]}).success).toBe(false)
 })
 test('repository and source-digest correlation cannot leak across partitions',()=>{
  for(const field of ['repository_group','source_digest'] as const){
   const lineage={source_task_id:'task-other',repository_group:'other-repo',source_digest:'b'.repeat(64),observed_at:'2026-07-01T00:00:00Z'}
   lineage[field]=base.cases[0].lineage[field]
   expect(GoldenDatasetSchema.safeParse({...base,cases:[...base.cases,{...base.cases[0],id:'other',split:'suggestions',lineage}]}).success).toBe(false)
  }
 })
 test('future observations and a missing calibration record never become holdout truth',()=>{
  expect(GoldenDatasetSchema.safeParse({...base,cases:[{...base.cases[0],lineage:{...base.cases[0].lineage,observed_at:'2026-12-01T00:00:00Z'}}]}).success).toBe(false)
  expect(GoldenDatasetSchema.safeParse({...base,cases:[{...base.cases[0],label:{provenance:'human_calibrated',evidence_support:'supported'}}]}).success).toBe(false)
 })
 test('small samples have honest confidence bounds and empty samples have no estimate',()=>{
  const interval=helpers.wilsonInterval(10,10)!
  expect(interval.low).toBeLessThan(.8);expect(interval.high).toBeCloseTo(1)
  expect(helpers.wilsonInterval(0,0)).toBeNull()
  expect(()=>helpers.wilsonInterval(2,1)).toThrow('invalid_evaluation_counts')
 })
 test('feedback reason codes cannot retain arbitrary private text',()=>{
  const policy=claims as unknown as {normalizeFeedbackReason(reason?:string):string|null}
  expect(policy.normalizeFeedbackReason('insufficient_evidence')).toBe('insufficient_evidence')
  expect(policy.normalizeFeedbackReason('Bearer private-credential copied from session')).toBe('other')
  expect(policy.normalizeFeedbackReason()).toBeNull()
 })

 test('reuse advice depends on observed use and error signals rather than approval alone',()=>{
  const advice=evaluator as unknown as {reuseValueAdvice(input:{used:number;incorrect:number;evidenceSupport:number;costMicros:number|null}):{recommendation:string;automaticTraining:boolean;thresholdChanges:boolean}}
  expect(advice.reuseValueAdvice({used:10,incorrect:0,evidenceSupport:1,costMicros:0})).toMatchObject({recommendation:'reuse_candidate',automaticTraining:false,thresholdChanges:false})
  expect(advice.reuseValueAdvice({used:0,incorrect:10,evidenceSupport:1,costMicros:0}).recommendation).toBe('needs_correction')
  expect(advice.reuseValueAdvice({used:1,incorrect:0,evidenceSupport:1,costMicros:null}).recommendation).toBe('keep_reviewing')
 })

})
