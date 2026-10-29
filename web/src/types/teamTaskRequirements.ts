import type {TeamTask,TeamTaskRequirements,TeamTaskRequirementsInput,TeamTaskRequirementOverrideInput} from './team'
type Base={team:string;task:string;actor:number;requirementsRevision:number}
export type RequirementsOperation=Base&(
 {kind:'save';input:TeamTaskRequirementsInput}|{kind:'override';input:TeamTaskRequirementOverrideInput}
)
const object=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))
const text=(v:unknown,max:number,min=0):v is string=>typeof v==='string'&&v.length<=max&&v.trim().length>=min&&!v.includes('\0')
const integer=(v:unknown,min=0):v is number=>Number.isSafeInteger(v)&&(v as number)>=min
/** Normalize before confirmation and persistence, matching the Relay contract. */
export function normalizeRequirements(value:unknown):TeamTaskRequirements {
 if(!object(value,['goal','scope','acceptance','repository'])||!text(value.goal,10000)||!text(value.scope,10000)||!text(value.acceptance,10000))throw Error('需求格式不正确。')
 let repository:TeamTaskRequirements['repository']=null
 if(value.repository!==null){
  const r=value.repository
  if(object(r,['kind','url'])&&r.kind==='git'&&text(r.url,2048,1)){
   const raw=r.url.trim()
   if(/[\s\\]/.test(raw)||/%2f|%5c/i.test(raw)||decodeURIComponent(raw.replace(/^https:\/\/[^/]+/,'')).split('/').some(p=>p==='.'||p==='..'))throw Error('仓库地址格式不正确。')
   const url=new URL(raw)
   if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname==='/')throw Error('仓库地址仅支持不含凭据的 HTTPS 仓库路径。')
   repository={kind:'git',url:url.href}
  }else if(object(r,['kind','reason'])&&r.kind==='not_applicable'&&text(r.reason,1000,1))repository={kind:'not_applicable',reason:r.reason.trim()}
  else throw Error('请填写仓库地址或不适用原因。')
 }
 return {goal:value.goal.trim(),scope:value.scope.trim(),acceptance:value.acceptance.trim(),repository}
}
function canonical(v:unknown):string {
 const sort=(x:unknown):unknown=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,y])=>[k,sort(y)])):x
 return JSON.stringify(sort(v))
}
export function validRequirementsOperation(value:unknown):value is RequirementsOperation {
 if(!object(value,['kind','team','task','actor','requirementsRevision','input'])||!text(value.team,256,1)||!text(value.task,256,1)||!integer(value.actor,1)||!integer(value.requirementsRevision))return false
 const input=value.input
 if(!object(input,value.kind==='save'?['request_id','expected_revision','requirements']:['request_id','expected_revision','reason'])||!text(input.request_id,128,1)||!integer(input.expected_revision,1))return false
 if(value.kind==='override')return value.requirementsRevision>0&&text(input.reason,1000,1)&&input.reason===input.reason.trim()
 if(value.kind!=='save')return false
 try{return canonical(normalizeRequirements(input.requirements))===canonical(input.requirements)}catch{return false}
}
/** A fresh task read is not a receipt. Match the original mutation response. */
export function matchesRequirementsResult(op:RequirementsOperation,task:TeamTask):boolean {
 const r=task?.requirements
 if(!validRequirementsOperation(op)||task?.id!==op.task||task.team_id!==op.team||task.revision!==op.input.expected_revision+1||!r)return false
 if(op.kind==='save')return r.revision===op.requirementsRevision+1&&r.override===null&&canonical(r.document)===canonical(op.input.requirements)
 return r.revision===op.requirementsRevision&&r.override?.actor_user_id===op.actor&&r.override.reason===op.input.reason&&r.override.requirements_revision===op.requirementsRevision
}
export interface RequirementsReceipt {task_id:string;actor_user_id:number;kind:'save'|'override';request_id:string;found:boolean;response:TeamTask|null}
export function matchesRequirementsReceipt(op:RequirementsOperation,r:RequirementsReceipt):boolean {
 return !!r&&r.task_id===op.task&&r.actor_user_id===op.actor&&r.kind===op.kind&&r.request_id===op.input.request_id&&typeof r.found==='boolean'&&(r.found?!!r.response&&matchesRequirementsResult(op,r.response):r.response===null)
}
