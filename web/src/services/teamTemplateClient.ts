import {teamRequest,type TeamRequestIdentity} from './teamClient'
import type {TemplateList,TemplateVersion,TemplateTaskInput,TemplateTaskReceipt,TemplateTaskResult,TaskTemplateSourceResponse} from '../types/teamTemplate'
import type {TemplateSaveInput,TemplateSaveResult,TemplateSaveReceipt} from '../types/teamTemplateEditing'
const base=(team:string)=>`/api/teams/${encodeURIComponent(team)}`
export const saveTeamTemplate=(team:string,id:string,input:TemplateSaveInput,identity:TeamRequestIdentity)=>teamRequest<TemplateSaveResult>(`${base(team)}/templates/${encodeURIComponent(id)}`,{method:'POST',body:{...input},identity,timeoutMs:30000})
export const findTemplateSave=(team:string,id:string,key:string,identity:TeamRequestIdentity)=>teamRequest<TemplateSaveReceipt>(`${base(team)}/templates/${encodeURIComponent(id)}/receipt-lookup/${encodeURIComponent(key)}`,{identity,timeoutMs:15000})
export const listTeamTemplates=(team:string,after?:string,identity?:TeamRequestIdentity)=>teamRequest<TemplateList>(`${base(team)}/templates${after?`?after=${encodeURIComponent(after)}`:''}`,{identity,timeoutMs:15000})
export const getTeamTemplate=(team:string,id:string,revision:number,identity?:TeamRequestIdentity)=>teamRequest<TemplateVersion>(`${base(team)}/templates/${encodeURIComponent(id)}?revision=${revision}`,{identity,timeoutMs:15000})
export const createTemplateTask=(team:string,input:TemplateTaskInput,identity:TeamRequestIdentity)=>teamRequest<TemplateTaskResult>(`${base(team)}/template-tasks`,{method:'POST',body:{...input},identity,timeoutMs:30000})
export const findTemplateTask=(team:string,key:string,identity:TeamRequestIdentity)=>teamRequest<TemplateTaskReceipt>(`${base(team)}/template-tasks/receipt-lookup/${encodeURIComponent(key)}`,{identity,timeoutMs:15000})
export const getTaskTemplateSource=(team:string,task:string,identity?:TeamRequestIdentity)=>teamRequest<TaskTemplateSourceResponse>(`${base(team)}/tasks/${encodeURIComponent(task)}/template-source`,{identity,timeoutMs:15000})
