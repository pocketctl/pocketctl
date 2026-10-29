import {validTaskBudget,validTaskPlanDraft,type TaskPlanStep,type TaskBudgetPolicy} from './teamPlan'
export interface TeamTemplate {
 name:string;goal:string;acceptance:string;roles:Array<{role_id:string;label:string;kind:'agent'|'reviewer'}>
 steps:Array<Omit<TaskPlanStep,'review_policy'>&{agent_role:string;reviewer_role:string;required_checks:string[]}>
 budget_suggestion?:{invocation_limit:number;policy?:TaskBudgetPolicy}
}
export interface TemplateVersion {team_id:string;template_id:string;revision:number;content_hash:string;definition:TeamTemplate}
export interface TemplateList {team_id:string;writes_enabled:boolean;can_manage:boolean;can_create:boolean;items:Array<{template_id:string;revision:number;name:string;content_hash:string}>;next_cursor:string|null}
export interface TemplateTaskInput {request_id:string;template_id:string;template_revision:number;team_session_id:string;context_version:number;role_bindings:Record<string,string|number>;goal:string;acceptance:string}
export interface TemplateTaskOperation {kind:'template_task';team:string;session:string;actor:number;template:TemplateVersion;input:TemplateTaskInput}
export interface TemplateTaskResult {task_id:string;team_id:string;team_session_id:string;template_id:string;template_revision:number;template_hash:string;plan_revision:number;plan_hash:string;execution_enabled:false;call_ids:string[]}
export interface TemplateTaskReceipt {team_id:string;actor_user_id:number;request_id:string;operation:'create_template_task';found:boolean;response:TemplateTaskResult|null}
export interface TaskTemplateSource {template_id:string;template_revision:number;snapshot:TeamTemplate;content_hash:string;role_bindings:Record<string,string|number>}
export interface TaskTemplateSourceResponse {task_id:string;source:TaskTemplateSource|null}
export function validTaskTemplateSource(value:unknown,task:string):value is TaskTemplateSourceResponse {
 const r=value as TaskTemplateSourceResponse
 if(!r||r.task_id!==task)return false
 if(r.source===null)return true
 const s=r.source
 if(!s||!text(s.template_id,128)||!Number.isInteger(s.template_revision)||s.template_revision<1||s.template_revision>100||!templateHash(s.content_hash)||!validTemplate(s.snapshot)||!s.role_bindings||typeof s.role_bindings!=='object'||Array.isArray(s.role_bindings))return false
 return Object.keys(s.role_bindings).length===s.snapshot.roles.length&&s.snapshot.roles.every(role=>Object.prototype.hasOwnProperty.call(s.role_bindings,role.role_id)&&(role.kind==='agent'?text(s.role_bindings[role.role_id],128):Number.isSafeInteger(s.role_bindings[role.role_id])&&Number(s.role_bindings[role.role_id])>0&&Number(s.role_bindings[role.role_id])<=2147483647))
}
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!v.includes('\0')
const object=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k))
const withoutNul=(v:unknown):boolean=>typeof v==='string'?!v.includes('\0'):Array.isArray(v)?v.every(withoutNul):v&&typeof v==='object'?Object.values(v).every(withoutNul):true
export const templateHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
export function validTemplate(value:unknown):value is TeamTemplate {
 const t=value as TeamTemplate
 if(!object(t,['name','goal','acceptance','roles','steps','budget_suggestion'])||!text(t.name,120)||!text(t.goal,32000)||!text(t.acceptance,16000)||!Array.isArray(t.roles)||!t.roles.length||t.roles.length>32||new Set(t.roles.map(r=>r?.role_id)).size!==t.roles.length)return false
 if(t.roles.some(r=>!object(r,['role_id','label','kind'])||typeof r.role_id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(r.role_id)||!text(r.label,120)||!['agent','reviewer'].includes(r.kind)))return false
 if(!Array.isArray(t.steps)||t.steps.some(s=>!object(s,['step_id','title','instruction','acceptance','required','depends_on','agent_role','reviewer_role','required_checks'])||!t.roles.some(r=>r.role_id===s.agent_role&&r.kind==='agent')||!t.roles.some(r=>r.role_id===s.reviewer_role&&r.kind==='reviewer')))return false
 const steps=t.steps.map(({agent_role,reviewer_role,required_checks,...s})=>({...s,review_policy:{primary_offer_id:agent_role,reviewer_user_id:1,required_checks}}))
 if(!validTaskPlanDraft({request_id:'template-validation',expected_revision:0,team_session_id:'template',context_version:0,spec_revision:1,steps})||!withoutNul(t)||new TextEncoder().encode(JSON.stringify(t)).length>128*1024)return false
 const b=t.budget_suggestion
 return b===undefined||object(b,['invocation_limit','policy'])&&Number.isSafeInteger(b.invocation_limit)&&b.invocation_limit>=t.steps.length&&b.invocation_limit<=128&&(b.policy===undefined||validTaskBudget(b.policy))
}
export function validTemplateVersion(value:unknown):value is TemplateVersion {
 const t=value as TemplateVersion
 return !!t&&text(t.team_id,128)&&text(t.template_id,128)&&Number.isSafeInteger(t.revision)&&t.revision>=1&&t.revision<=100&&templateHash(t.content_hash)&&validTemplate(t.definition)
}
export function validTemplateTask(value:unknown):value is TemplateTaskOperation {
 const op=value as TemplateTaskOperation,i=op?.input,t=op?.template
 if(!op||op.kind!=='template_task'||!text(op.team,128)||!text(op.session,128)||!Number.isSafeInteger(op.actor)||op.actor<1||!validTemplateVersion(t)||t.team_id!==op.team||!object(i,['request_id','template_id','template_revision','team_session_id','context_version','role_bindings','goal','acceptance']))return false
 if(!text(i.request_id,128)||i.template_id!==t.template_id||i.template_revision!==t.revision||i.team_session_id!==op.session||!Number.isSafeInteger(i.context_version)||i.context_version<0||!text(i.goal,32000)||!text(i.acceptance,16000)||!object(i.role_bindings,t.definition.roles.map(r=>r.role_id)))return false
 return t.definition.roles.every(r=>Object.prototype.hasOwnProperty.call(i.role_bindings,r.role_id)&&(r.kind==='agent'?text(i.role_bindings[r.role_id],128):Number.isSafeInteger(i.role_bindings[r.role_id])&&Number(i.role_bindings[r.role_id])>=1&&Number(i.role_bindings[r.role_id])<=2147483647))&&new TextEncoder().encode(JSON.stringify(i)).length<=64*1024
}
export function matchingTemplateTask(op:TemplateTaskOperation,r:TemplateTaskResult):boolean {
 return !!r&&text(r.task_id,128)&&r.team_id===op.team&&r.team_session_id===op.session&&r.template_id===op.input.template_id&&r.template_revision===op.input.template_revision&&r.template_hash===op.template.content_hash&&r.plan_revision===1&&templateHash(r.plan_hash)&&r.execution_enabled===false&&Array.isArray(r.call_ids)&&r.call_ids.length===0
}
export function validTemplateReceipt(op:TemplateTaskOperation,r:TemplateTaskReceipt):boolean {
 return !!r&&r.team_id===op.team&&r.actor_user_id===op.actor&&r.request_id===op.input.request_id&&r.operation==='create_template_task'&&typeof r.found==='boolean'&&(r.found?r.response!==null&&matchingTemplateTask(op,r.response):r.response===null)
}
