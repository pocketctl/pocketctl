import type { TeamApiError } from './teamClient'

export function deliveryOperationError(error: TeamApiError): string {
 if(['revision_conflict','context_revision_conflict'].includes(error.code))return '交付、规格或共享材料版本已变化，请重新核对。'
 if(error.code==='budget_exhausted') {
  const budgets:Record<string,string>={
   'plan invocation limit exhausted':'调用次数已达到上限，不能再开始新步骤。',
   'plan concurrent reservation limit reached':'并发调用已达到上限，请等待已发出的调用结束。',
   'plan duration limit reached; issued Calls are not stopped':'计划执行时限已到，停止新派发；已发出的调用继续运行。',
   'plan invocation limit cannot cover the planned work':'调用次数预算不足以覆盖计划，请核对预算与步骤数量。',
  }
  if(budgets[error.message])return `${budgets[error.message]}（budget_exhausted）`
 }
 const reasons:Record<string,string>={
  capability_not_supported:'所选 Agent 暂不支持步骤执行，请核对主机版本与能力开关。',
  acceptance_required:'依赖步骤尚未验收通过，请先完成指定交付的验收。',
  budget_exhausted:'执行预算不足或已达到调用、并发或时限上限，请查看执行预算。',
 }
 return reasons[error.code]?`${reasons[error.code]}（${error.code}）`:error.message
}

export function deliveryFailureReason(code: string): string {
 if(code==='context_budget_exceeded')return '完整交付规格超过上下文上限 32,000 字节，本次执行未派发且不会截断规格。请缩减任务目标、验收标准或检查项后重新执行。'
 if(code==='context_snapshot_unavailable')return '执行上下文快照无法准备，本次执行未派发。请核对共享材料与交付规格后重试；旧记录未保留具体原因，不能确定是否超限。'
 if(code==='delivery_http_503:source_busy')return '步骤输入暂时繁忙，有限重试后仍未取得输入。请核对原调用，再决定是否重新尝试。'
 if(code==='delivery_http_503:step_input_unavailable')return '步骤输入读取失败（旧版本未保留具体原因）。请核对服务状态和原调用，再决定是否重新尝试。'
 if(code.startsWith('delivery_http_'))return '步骤输入请求被拒绝或暂时不可用，请核对权限、输入来源和服务状态。'
 if(code.startsWith('step_input_'))return '步骤输入准备失败，请核对输入完整性与当前授权。'
 return '执行失败，请核对原调用状态与诊断记录。'
}
