import {z} from 'zod'
import {conclusionSchema,validateConclusion,type ConclusionEvidence} from '../curation/conclusion-validator.js'

// Opt-in evaluator diagnostics only. Never accept arbitrary caller/production text.
const sourceSchema=z.object({id:z.string().max(256),text:z.string().regex(/^I prefer (?:trains|planes)(?: for personal travel)?\.$/),role:z.literal('user')})
const sourcesSchema=z.array(sourceSchema).min(1).max(2)
const spanSchema=z.object({event_id:z.string().max(256),start:z.number().int().nonnegative(),end:z.number().int().positive()})
export function syntheticConclusionRejections(document:unknown,value:unknown){
 const parsed=sourcesSchema.safeParse((document as {sources?:unknown}|null)?.sources)
 if(!parsed.success)return []
 const sources:ConclusionEvidence[]=parsed.data
 const tasks=(value as {tasks?:unknown}|null)?.tasks
 if(!Array.isArray(tasks))return []
 const rejected:Array<{task_index:number;conclusion_index:number;reason:string;statement:string;sources:ConclusionEvidence[];spans:z.infer<typeof spanSchema>[]}> = []
 for(const [taskIndex,task]of tasks.slice(0,8).entries()){
  const spans=z.array(spanSchema).min(1).max(128).safeParse(task?.spans)
  if(!spans.success||!Array.isArray(task?.conclusions))continue
  if(spans.data.some(span=>{const source=sources.find(s=>s.id===span.event_id);return !source||span.start>=span.end||span.end>source.text.length}))continue
  const evidence=spans.data.map(span=>({...sources.find(s=>s.id===span.event_id)!,text:sources.find(s=>s.id===span.event_id)!.text.slice(span.start,span.end)}))
  for(const [conclusionIndex,raw]of task.conclusions.slice(0,8).entries()){
   const conclusion=conclusionSchema.safeParse(raw)
   if(!conclusion.success)continue
   const check=validateConclusion(conclusion.data,evidence)
   if(!check.ok)rejected.push({task_index:taskIndex,conclusion_index:conclusionIndex,reason:check.reason,statement:conclusion.data.statement,sources:sources.filter(s=>spans.data.some(span=>span.event_id===s.id)),spans:spans.data})
  }
 }
 return rejected
}
