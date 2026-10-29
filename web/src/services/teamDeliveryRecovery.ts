import {sameTaskBudget} from '../types/teamPlan'
import type { TaskPlanControl, TaskPlanDraft } from '../types/teamPlan'
import type { DeliveryDecision, DeliverySpecRevision, DeliveryExecute } from '../types/teamDelivery'

export type DeliveryPendingOperation =
 | { kind: 'acceptance'; input: DeliveryDecision; attemptId?:string }
 | { kind: 'revise_spec'; input: DeliverySpecRevision; specRevision?: number }
 | { kind: 'plan_draft'; input:TaskPlanDraft }
 | { kind: 'plan_control'; input: TaskPlanControl; expectedState?:string; expectedCallId?:string }
 | { kind: 'execute_task'; input: DeliveryExecute; session?: string }

/** Unknown routes and malformed/foreign receipts must never enable a retry. */
export function confirmedDeliveryReceipt(value: unknown, task: string, op: DeliveryPendingOperation): boolean {
 const result = value as Record<string, any> | null
 if (!result || result.task_id !== task || result.request_id !== op.input.request_id || typeof result.found !== 'boolean') throw new Error('原操作查询不匹配，已保留记录。')
 if (op.kind === 'acceptance' && op.attemptId && result.attempt_id !== op.attemptId) throw new Error('步骤回执范围不匹配，已保留记录。')
 if (result.found === false && result.receipt === null) return false
 const receipt = result.receipt, response = receipt?.response
 if (result.found !== true || receipt?.operation !== op.kind || response?.revision !== op.input.expected_revision + 1) throw new Error('原操作回执不匹配，已保留记录。')
 if (op.kind === 'acceptance' && op.attemptId && response.attempt_id !== op.attemptId) throw new Error('步骤决定范围不匹配，已保留记录。')
 if (op.kind === 'acceptance' && (response.submission_id !== op.input.submission_id || response.decision !== op.input.decision || typeof response.decision_id !== 'string' || !response.decision_id)) throw new Error('验收回执不匹配，已保留记录。')
 if (op.kind === 'revise_spec' && (!Number.isSafeInteger(response.spec_revision) || response.spec_revision < 2)) throw new Error('规格回执不匹配，已保留记录。')
 if (op.kind === 'revise_spec' && op.specRevision !== undefined && response.spec_revision !== op.specRevision + 1) throw new Error('规格回执不匹配，已保留记录。')
 if (op.kind === 'execute_task' && (response.spec_revision !== op.input.spec_revision || !Array.isArray(response.call_ids) || response.call_ids.length !== op.input.target_offer_ids.length || new Set(response.call_ids).size !== response.call_ids.length || response.call_ids.some((id: unknown) => typeof id !== 'string' || !id))) throw new Error('执行回执不匹配，已保留记录。')
 if (op.kind === 'plan_control' && (response.task_id !== task || response.plan_revision !== op.input.plan_revision || response.state !== (['reconcile','retry','new_version'].includes(op.input.action) ? op.expectedState : op.input.action === 'cancel' ? 'cancelled' : ['pause','adopt_revision'].includes(op.input.action) ? 'paused' : 'active') || response.issued_calls_stopped !== false)) throw new Error('计划控制回执不匹配，已保留记录。')
 if(op.kind==='plan_control'&&op.input.action==='reconcile'&&(response.recovery?.attempt_id!==op.input.attempt_id||response.recovery?.call_id!==op.expectedCallId||response.recovery?.new_call_created!==false))throw Error('原步骤核对回执不匹配，已保留记录。')
 if(op.kind==='plan_control'&&['retry','new_version'].includes(op.input.action)&&(response.recovery?.previous_attempt_id!==op.input.attempt_id||!/^([a-f0-9]{8}-)([a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(response.recovery?.attempt_id||'')||response.recovery.attempt_id===op.input.attempt_id||typeof response.recovery?.call_id!=='string'||!response.recovery.call_id||response.recovery.call_id===op.expectedCallId||response.recovery.attempt_state!=='reserved'))throw Error('步骤重试回执不匹配，已保留记录。')
 if(op.kind==='plan_control'&&op.input.action==='activate'&&response.invocation_limit!==op.input.invocation_limit)throw Error('激活预算回执不匹配，已保留记录。')
 if(op.kind==='plan_control'&&op.input.action==='activate'&&(op.input.budget!==undefined||response.budget!==undefined)&&!sameTaskBudget(response.budget,op.input.budget??{}))throw Error('激活预算回执不匹配，已保留记录。')
 if(op.kind==='plan_draft'&&(response.task_id!==task||response.state!=='draft'||response.execution_enabled!==false||!/^([a-f0-9]{64})$/.test(response.plan_hash||'')))throw Error('计划草稿回执不匹配，已保留记录。')
 return true
}
