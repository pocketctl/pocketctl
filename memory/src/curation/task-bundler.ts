import {z} from 'zod'
import type {CurationState} from './contracts.js'
const task=z.object({space_id:z.string().max(256).nullable(),task_id:z.string().max(256).nullable(),spans:z.array(z.object({event_id:z.string().max(256),start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict()).min(1).max(128)}).strict()
export type TaskPartition=z.infer<typeof task>
export function validateTaskPartition(raw:unknown,sources:readonly{id:string;text:string}[],spaces:readonly string[],tasks:readonly(string|{id:string;space_id:string|null})[]):{ok:true;tasks:TaskPartition[]}|{ok:false;reason:string}{
 const parsed=z.array(task).max(32).safeParse(raw)
 if(!parsed.success)return{ok:false,reason:'partition_invalid'}
 const ranges=new Map<string,Array<{start:number;end:number}>>()
 const resumed=new Set<string>()
 for(const part of parsed.data){
  if(part.space_id!==null&&!spaces.includes(part.space_id))return{ok:false,reason:'space_unavailable'}
  if(part.task_id!==null){
   const prior=tasks.find(t=>(typeof t==='string'?t:t.id)===part.task_id)
   if(!prior||resumed.has(part.task_id)||typeof prior!=='string'&&prior.space_id!==part.space_id)return{ok:false,reason:'task_unavailable'}
   resumed.add(part.task_id)
  }
  for(const span of part.spans){
   const source=sources.find(s=>s.id===span.event_id)
   if(!source||span.start>=span.end||span.end>source.text.length)return{ok:false,reason:'source_span_invalid'}
   const previous=ranges.get(span.event_id)??[]
   if(previous.some(p=>span.start<p.end&&span.end>p.start))return{ok:false,reason:'source_span_overlap'}
   previous.push(span);ranges.set(span.event_id,previous)
  }
 }
 return{ok:true,tasks:parsed.data}
}
export function semanticDisposition(state:CurationState,deadline:Date|null,now:Date):CurationState{
 return state==='deferred_semantic'&&deadline&&now.getTime()>=deadline.getTime()?'skipped_unresolved':state
}
