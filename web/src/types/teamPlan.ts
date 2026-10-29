import type { ReviewPolicy } from './teamDelivery'

export interface TaskBudgetPolicy { max_concurrent_calls?:number;max_duration_seconds?:number;token_warning_limit?:number }
export function validTaskBudget(value:unknown):value is TaskBudgetPolicy {
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const limits:Record<string,number>={max_concurrent_calls:32,max_duration_seconds:604800,token_warning_limit:1e12}
 return Object.entries(value).every(([key,v])=>key in limits&&Number.isSafeInteger(v)&&(v as number)>=1&&(v as number)<=limits[key]!)
}
export function sameTaskBudget(a:unknown,b:TaskBudgetPolicy):boolean {
 return validTaskBudget(a)&&(['max_concurrent_calls','max_duration_seconds','token_warning_limit'] as const).every(k=>a[k]===b[k])
}

export interface TaskPlanStep {
 step_id:string;title:string;instruction:string;acceptance:string;required:boolean;depends_on:string[];review_policy:ReviewPolicy
}
export interface TaskPlanSnapshot {
 task_id:string;revision:number;state:string;writes_enabled:boolean;
 plan:{revision:number;team_session_id?:string;context_version:number;spec_revision:number;steps:TaskPlanStep[]}|null
}
export interface TaskStepAttempt {
 attempt_id:string;step_id:string;plan_revision:number;attempt_no:number;state:string;call_id:string|null;call_state:string|null;
 input_source_count:number;input_hash:string;spec_revision:number|null;delivery_revision:number|null;latest_submission_id:string|null;latest_decision?:string|null
}
export interface TaskBudget {
 scope:'plan_attempts';policy:TaskBudgetPolicy;
 invocation_limit:number;invocation_count:number;in_flight:number;started_at:string|null;duration_exhausted:boolean;issued_calls_stopped:false;
 capabilities:{tokens:string;token_hard_limit:boolean;native_round_limit:boolean;estimated_cost:boolean};
 usage:{observed_tokens:string|null;coverage:string;attributed_calls:number;includes_subagents:string;estimated_cost:null;token_warning_exceeded:boolean}
}
export interface TaskPlanExecution {
 schema_version:1;task_id:string;revision:number;runtime:{plan_revision:number;revision:number;state:string;invocation_limit:number}|null;
 attempts:TaskStepAttempt[];new_version_enabled?:boolean;execution_enabled:boolean;can_control:boolean;issued_calls_stopped:false;budget:TaskBudget|null;
 scheduler:{pending:boolean;last_error_code:string|null}
}
export interface TaskContext {
 schema_version:1;read_only:true;new_call_created:false;scope:'task'|'attempt';task:{task_id:string;title:string;state:string};
 spec:{revision:number;goal:string;acceptance:string};
 attempt:{attempt_id:string;step_id:string;attempt_no:number;context_version:number;input_hash:string;state:string;call_state:string}|null;
 inputs:Array<{step_id:string;attempt_id:string;submission_id:string;submission_version:number|string;spec_revision:number|string;decision_id:string;
 artifacts:Array<{id:string;name:string;sha256:string;byte_size:number;revoked:boolean}>}>;
 decisions:Array<{decision_id:string;submission_id:string;decision:string;reason:string;version:number|string}>;
 diagnostics:Array<{code:string;action:string}>
}
export const taskStepLabel=(state:string|null|undefined)=>({reserved:'等待派发',dispatched:'已派发',running:'执行中',unknown:'结果待核对',awaiting_review:'等待验收',accepted:'已验收',failed:'执行失败',cancelled:'已取消'} as Record<string,string>)[state||'']||'尚未开始'
export const taskDiagnosticLabel=(code:string)=>({original_call_unknown:'原调用结果未知，需核对原执行；不能直接重试。',attempt_superseded:'已有后续尝试；此处为历史快照。',execution_terminal:'执行已结束，请核对失败或取消原因后决定是否重新尝试。',review_required:'交付等待指定验收人核对。',changes_requested:'验收人要求修改，请先阅读修改意见。',dependency_waiting:'等待上游步骤验收。',input_revoked:'输入文件已撤销，请核对来源。',plan_paused:'已暂停后续调度，已发出的调用继续运行。',plan_cancelled:'已取消后续调度，已发出的调用仍需核对。',budget_exhausted:'预算已达到上限，后续调度停止。'} as Record<string,string>)[code]||`需要核对：${code}`

/** Existing runtime only; activation and retry require separate confirmation flows. */
export interface TaskPlanControl {
 request_id:string;expected_revision:number;plan_revision:number;action:'activate'|'adopt_revision'|'pause'|'resume'|'cancel'|'reconcile'|'retry'|'new_version';reason?:string;invocation_limit?:number;budget?:TaskBudgetPolicy;attempt_id?:string;expected_delivery_revision?:number
}

export function canRetryTaskAttempt(execution:TaskPlanExecution,id:string):boolean {
 const attempt=execution.attempts.find(a=>a.attempt_id===id)
 if(!execution.can_control||!execution.execution_enabled||execution.runtime?.state!=='active'||!attempt?.call_id||!Number.isSafeInteger(attempt.delivery_revision)||(attempt.delivery_revision??0)<1||execution.attempts.some(a=>a.step_id===attempt.step_id&&a.attempt_no>attempt.attempt_no))return false
 return (['failed','blocked','cancelled'].includes(attempt.call_state||'')&&['failed','cancelled','awaiting_review'].includes(attempt.state))||(attempt.call_state==='completed'&&attempt.state==='awaiting_review'&&attempt.latest_decision==='changes_requested')
}

export function validNewVersionReason(reason:unknown):reason is string {
 return typeof reason==='string'&&!!reason.trim()&&reason.length<=1000&&!reason.includes('\0')
}
export function canCreateTaskStepVersion(execution:TaskPlanExecution,id:string):boolean {
 const a=execution.attempts.find(a=>a.attempt_id===id)
 return execution.new_version_enabled===true&&execution.execution_enabled&&execution.can_control&&execution.runtime?.state==='active'&&!!a?.call_id&&a.call_state==='completed'&&a.state==='accepted'&&a.latest_decision==='accepted'&&Number.isSafeInteger(a.delivery_revision)&&(a.delivery_revision??0)>0&&!execution.attempts.some(other=>other.step_id===a.step_id&&other.attempt_no>a.attempt_no)
}

export function canActivateTaskPlan(execution:TaskPlanExecution,plan:TaskPlanSnapshot|undefined,limit:number):boolean {
 return execution.can_control&&execution.execution_enabled&&!execution.runtime&&execution.revision===0&&plan?.task_id===execution.task_id&&!!plan.plan&&plan.plan.revision===plan.revision&&plan.plan.steps.length>0&&Number.isSafeInteger(limit)&&limit>=plan.plan.steps.length&&limit<=128
}

export function canAdoptTaskPlan(execution:TaskPlanExecution,draft:TaskPlanSnapshot|undefined):boolean {
 return execution.can_control&&execution.execution_enabled&&execution.runtime?.state==='paused'&&draft?.task_id===execution.task_id&&!!draft.plan&&draft.plan.revision===draft.revision&&draft.revision>execution.runtime.plan_revision
}

export interface TaskPlanDraft {
 request_id:string;expected_revision:number;team_session_id:string;context_version:number;spec_revision:number;steps:TaskPlanStep[]
}
export function validTaskPlanDraft(value:unknown):value is TaskPlanDraft {
 const p=value as TaskPlanDraft
 const text=(v:unknown,max:number)=>typeof v==='string'&&!!v.trim()&&v.length<=max
 if(!p||!text(p.request_id,128)||!text(p.team_session_id,128)||!Number.isSafeInteger(p.expected_revision)||p.expected_revision<0||!Number.isSafeInteger(p.context_version)||p.context_version<0||!Number.isSafeInteger(p.spec_revision)||p.spec_revision<1||!Array.isArray(p.steps)||!p.steps.length||p.steps.length>32)return false
 const ids=new Set(p.steps.map(s=>s?.step_id));if(ids.size!==p.steps.length)return false
 for(const s of p.steps){const r=s?.review_policy
  if(!s||typeof s.step_id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(s.step_id)||!text(s.title,120)||!text(s.instruction,16000)||!text(s.acceptance,8000)||typeof s.required!=='boolean'||!Array.isArray(s.depends_on)||new Set(s.depends_on).size!==s.depends_on.length||s.depends_on.some(id=>id===s.step_id||!ids.has(id))||!r||!Number.isSafeInteger(r.reviewer_user_id)||r.reviewer_user_id<1||!text(r.primary_offer_id,128)||!Array.isArray(r.required_checks)||r.required_checks.length>32||new Set(r.required_checks).size!==r.required_checks.length||r.required_checks.some(c=>!text(c,120)))return false
 }
 const visited=new Set<string>(),visiting=new Set<string>(),byId=new Map(p.steps.map(s=>[s.step_id,s]))
 function visit(id:string):boolean{if(visiting.has(id))return false;if(visited.has(id))return true;visiting.add(id);if(!byId.get(id)!.depends_on.every(visit))return false;visiting.delete(id);visited.add(id);return true}
 return p.steps.some(s=>s.required)&&p.steps.every(s=>visit(s.step_id))&&new TextEncoder().encode(JSON.stringify(p)).length<=128*1024
}

export interface TaskPlanEditingOptions {
 task_id:string;can_edit:boolean;revision:number;spec_revision:number;started_step_ids:string[];locked_session_id:string|null;
 reviewers:Array<{user_id:number}>;offers:Array<{offer_id:string;provider:string;owner_user_id:number}>;
 sessions:Array<{team_session_id:string;title:string;current_context_version:number;offer_ids:string[]}>
}
