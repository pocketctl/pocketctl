import {boundedText, positiveRevision} from './delivery-contract.js'
import {validateTaskBudget, type TaskBudgetPolicy} from './budget-service.js'
import {validateTaskPlan, type TaskPlanStep} from './plan-contract.js'
import {TeamRepositoryError} from './repository.js'

export interface TeamTemplate {
 name:string;goal:string;acceptance:string
 roles:Array<{role_id:string;label:string;kind:'agent'|'reviewer'}>
 steps:Array<Omit<TaskPlanStep,'review_policy'> & {agent_role:string;reviewer_role:string;required_checks:string[]}>
 budget_suggestion?:{invocation_limit:number;policy?:TaskBudgetPolicy}
}
export type TemplateBindings=Record<string,string|number>
export function strictObject(value:unknown,keys:string[]):Record<string,any> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new TeamRepositoryError('invalid_request','unexpected template fields')
 return value as Record<string,any>
}
export function validateTemplate(value:unknown):asserts value is TeamTemplate {
 const t=strictObject(value,['name','goal','acceptance','roles','steps','budget_suggestion'])
 boundedText(t.name,'template name',120);boundedText(t.goal,'template goal',32000);boundedText(t.acceptance,'template acceptance',16000)
 if(!Array.isArray(t.roles)||!t.roles.length||t.roles.length>32||new Set(t.roles.map(r=>r?.role_id)).size!==t.roles.length)throw new TeamRepositoryError('invalid_request','unique template roles required')
 for(const raw of t.roles){const r=strictObject(raw,['role_id','label','kind']);if(typeof r.role_id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(r.role_id)||!['agent','reviewer'].includes(r.kind))throw new TeamRepositoryError('invalid_request','invalid template role');boundedText(r.label,'role label',120)}
 if(!Array.isArray(t.steps)||!t.steps.length||t.steps.length>32)throw new TeamRepositoryError('invalid_request','template requires 1-32 steps')
 for(const s of t.steps){strictObject(s,['step_id','title','instruction','acceptance','required','depends_on','agent_role','reviewer_role','required_checks']);if(!t.roles.some(r=>r.role_id===s.agent_role&&r.kind==='agent')||!t.roles.some(r=>r.role_id===s.reviewer_role&&r.kind==='reviewer'))throw new TeamRepositoryError('invalid_request','missing or mismatched template role')}
 // Reuse the actual plan DAG, content, checks and size contract.
 const steps=t.steps.map(s=>{const {agent_role,reviewer_role,required_checks,...step}=s;return {...step,review_policy:{primary_offer_id:agent_role,reviewer_user_id:1,required_checks}}})
 validateTaskPlan({request_id:'template-validation',expected_revision:0,team_session_id:'template',context_version:0,spec_revision:1,steps})
 if(Buffer.byteLength(JSON.stringify(value),'utf8')>128*1024)throw new TeamRepositoryError('invalid_request','template byte limit exceeded')
 if(t.budget_suggestion!==undefined){const b=strictObject(t.budget_suggestion,['invocation_limit','policy']);positiveRevision(b.invocation_limit);if(b.invocation_limit<t.steps.length||b.invocation_limit>128)throw new TeamRepositoryError('invalid_request','budget suggestion must cover steps');if(b.policy!==undefined)validateTaskBudget(b.policy)}
}
export function bindTemplate(template:TeamTemplate,bindings:TemplateBindings):TaskPlanStep[] {
 strictObject(bindings,template.roles.map(r=>r.role_id))
 for(const r of template.roles){if(!Object.hasOwn(bindings,r.role_id))throw new TeamRepositoryError('invalid_request','all template roles need explicit bindings');if(r.kind==='agent')boundedText(bindings[r.role_id],'role offer',128);else {positiveRevision(bindings[r.role_id]);if(Number(bindings[r.role_id])>2147483647)throw new TeamRepositoryError('invalid_request','reviewer ID exceeds supported range')}}
 return template.steps.map(s=>{const {agent_role,reviewer_role,required_checks,...step}=s;return {...step,review_policy:{primary_offer_id:bindings[agent_role] as string,reviewer_user_id:bindings[reviewer_role] as number,required_checks}}})
}
