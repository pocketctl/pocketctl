import { teamRequest, type TeamRequestIdentity } from './teamClient'
import type { TaskContext, TaskPlanExecution, TaskPlanSnapshot, TaskPlanControl, TaskPlanDraft, TaskPlanEditingOptions } from '../types/teamPlan'
const base=(task:string)=>`/api/team/tasks/${encodeURIComponent(task)}`
export const getTaskPlan=(task:string,revision?:number)=>teamRequest<TaskPlanSnapshot>(`${base(task)}/plan${revision===undefined?'':`?revision=${revision}`}`)
export const getTaskPlanExecution=(task:string)=>teamRequest<TaskPlanExecution>(`${base(task)}/plan/execution`)
export const getTaskContext=(task:string,attempt?:string)=>teamRequest<TaskContext>(`${base(task)}/context${attempt?`?attempt_id=${encodeURIComponent(attempt)}`:''}`)

export const controlTaskPlan=(task:string,input:TaskPlanControl,identity?:TeamRequestIdentity)=>teamRequest<unknown>(`${base(task)}/plan/execution`,{method:'POST',body:{...input},identity,timeoutMs:30000})
export async function getTaskPlanControlReceipt(task:string,key:string,identity:TeamRequestIdentity){
 const value=await teamRequest<any>(`${base(task)}/plan/execution/receipt-lookup/${encodeURIComponent(key)}`,{identity,timeoutMs:15000})
 if(!value||value.actor_user_id!==identity.userId)throw Error('原操作账号不匹配，已保留记录。')
 return {...value,receipt:value.found===false&&value.response===null?null:{operation:'plan_control',response:value.response}}
}

export const saveTaskPlanDraft=(task:string,input:TaskPlanDraft,identity?:TeamRequestIdentity)=>teamRequest<unknown>(`${base(task)}/plan`,{method:'POST',body:{...input},identity,timeoutMs:30000})
export async function getTaskPlanDraftReceipt(task:string,key:string,identity:TeamRequestIdentity){
 const value=await teamRequest<any>(`${base(task)}/plan/receipt-lookup/${encodeURIComponent(key)}`,{identity,timeoutMs:15000})
 if(!value||value.actor_user_id!==identity.userId)throw Error('原操作账号不匹配，已保留记录。')
 return {...value,receipt:value.found===false&&value.response===null?null:{operation:'plan_draft',response:value.response}}
}

export const getTaskPlanEditingOptions=(task:string)=>teamRequest<TaskPlanEditingOptions>(`${base(task)}/plan/options`)
