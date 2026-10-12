import {z} from 'zod'
const timestamp=(text:string)=>{
 const fraction=/\.(\d+)Z$/.exec(text)?.[1]??''
 return BigInt(Date.parse(text.replace(/\.\d+(?=Z$)/,'')))*1000000000n+BigInt(fraction.padEnd(9,'0').slice(0,9))
}
const version=z.union([z.literal(1),z.literal(2)])
export const GoldenCaseSchema=z.strictObject({
 id:z.string().min(1).max(64),schema_version:version,query:z.string().min(1).max(2000),installation_id:z.uuid(),
 allowed:z.strictObject({repository_ids:z.array(z.uuid()).max(8).default([]),repo_snapshot_ids:z.array(z.uuid()).max(8).default([]),branches:z.array(z.string().min(1).max(255)).max(8).default([])}),
 expected:z.strictObject({claim_ids:z.array(z.uuid()).default([]),evidence_claim_ids:z.array(z.uuid()).default([]),current_version_ids:z.array(z.uuid()).optional()}),
 review_outcome:z.enum(['accepted_as_is','light_edit','major_edit','rejected']).optional(),
 split:z.enum(['suggestions','calibration','holdout']).optional(),
 lineage:z.strictObject({source_task_id:z.string().min(1).max(128),repository_group:z.string().min(1).max(128),source_digest:z.string().regex(/^[a-f0-9]{64}$/),observed_at:z.iso.datetime()}).optional(),
 label:z.strictObject({provenance:z.enum(['synthetic_curated','human_calibrated','uncalibrated']),evidence_support:z.enum(['supported','unsupported','ambiguous']),
   calibration_record_id:z.uuid().optional(),review_seconds:z.number().min(0).max(86400).optional()}).optional(),
}).superRefine((value,ctx)=>{
 const combinations=Math.max(1,value.allowed.repository_ids.length)*Math.max(1,value.allowed.repo_snapshot_ids.length)*Math.max(1,value.allowed.branches.length)
 if(combinations>64)ctx.addIssue({code:'custom',path:['allowed'],message:'allowed scope expands beyond 64 combinations'})
 if(value.schema_version===2&&(!value.lineage||!value.label||!value.split))ctx.addIssue({code:'custom',message:'version2 requires lineage, split and label provenance'})
 if(value.label?.provenance==='human_calibrated'&&!value.label.calibration_record_id)ctx.addIssue({code:'custom',message:'human calibration record required'})
})
export const GoldenDatasetSchema=z.strictObject({
 schema_version:version,dataset_version:z.string().min(1).max(64),created_at:z.iso.datetime(),cases:z.array(GoldenCaseSchema).min(1),
 evaluator_version:z.literal('memory-governance-eval-v2').optional(),
 split_windows:z.strictObject({suggestions_end:z.iso.datetime(),calibration_end:z.iso.datetime()}).optional(),
}).superRefine((value,ctx)=>{
 const seen=new Map<string,string>()
 if(value.schema_version===2&&(!value.evaluator_version||!value.split_windows))ctx.addIssue({code:'custom',message:'frozen evaluator and split windows required'})
 const windows=value.split_windows
 if(windows&&timestamp(windows.suggestions_end)>=timestamp(windows.calibration_end))ctx.addIssue({code:'custom',message:'invalid split windows'})
 for(const item of value.cases){
  if(item.schema_version!==value.schema_version)ctx.addIssue({code:'custom',message:'case dataset version mismatch'})
  if(!item.lineage||!item.split)continue
  if(timestamp(item.lineage.observed_at)>timestamp(value.created_at))ctx.addIssue({code:'custom',message:'future source observation'})
  if(windows){
   const at=timestamp(item.lineage.observed_at)
   if((item.split==='suggestions'&&at>timestamp(windows.suggestions_end))||(item.split==='calibration'&&(at<=timestamp(windows.suggestions_end)||at>timestamp(windows.calibration_end)))
     ||(item.split==='holdout'&&at<=timestamp(windows.calibration_end)))ctx.addIssue({code:'custom',message:'source outside frozen time partition'})
  }
  for(const [kind,key] of [['task',item.lineage.source_task_id],['repository',item.lineage.repository_group],['digest',item.lineage.source_digest]]){
   const token=kind+':'+key,partition=seen.get(token)
   if(partition&&partition!==item.split)ctx.addIssue({code:'custom',message:'correlated source crosses evaluation partitions'})
   seen.set(token,item.split)
  }
 }
})
export type GoldenCase=z.output<typeof GoldenCaseSchema>
export type GoldenDataset=z.output<typeof GoldenDatasetSchema>
