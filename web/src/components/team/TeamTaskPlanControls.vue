<template>
 <section aria-label="计划调度控制">
  <p v-if="operations.error.value" role="alert">{{ operations.error.value }}</p>
  <p v-if="operations.storageError.value" role="alert">{{ operations.storageError.value }} <button class="btn" @click="operations.refresh()">重新读取操作记录</button></p>
  <template v-if="pending">
   <p role="status">计划控制结果尚未确认。查询原操作后再继续，不能创建另一个请求。</p>
   <button class="btn" :disabled="!available || operations.busy.value || !operations.ready.value" @click="operations.resolve()">查询原计划操作</button>
   <button v-if="operations.receiptMissing.value && !operations.confirmRetry.value" class="btn" :disabled="!available || operations.busy.value" @click="operations.confirmRetry.value=true">重试原计划操作</button>
   <div v-if="operations.confirmRetry.value"><p>使用原请求、原计划版本和原内容重试。已发出的调用不会停止。</p><button class="btn" :disabled="!available || operations.busy.value" @click="operations.retry()">确认重试原计划操作</button><button class="btn" :disabled="operations.busy.value" @click="operations.confirmRetry.value=false">取消重试</button></div>
  </template>
  <template v-else-if="!execution.runtime && execution.can_control && plan?.plan">
   <label>调用总上限 <input aria-label="调用总上限" type="number" v-model.number="invocationLimit" min="1" max="128" :disabled="operations.blocked.value || !available" /></label>
   <p>必须覆盖全部步骤，最多 128 次；重试也计入上限。</p>
   <details><summary>可选预算</summary>
    <label>并发调用上限 <input aria-label="并发调用上限" type="number" v-model.number="concurrentLimit" min="1" max="32" placeholder="不设置" :disabled="operations.blocked.value || !available" /></label>
    <label>停止新派发时限（秒） <input aria-label="停止新派发时限" type="number" v-model.number="durationLimit" min="1" max="604800" placeholder="不设置" :disabled="operations.blocked.value || !available" /></label>
    <label>Token 提醒阈值 <input aria-label="Token 提醒阈值" type="number" v-model.number="tokenWarning" min="1" max="1000000000000" placeholder="不设置" :disabled="operations.blocked.value || !available" /></label>
    <p>时限从激活开始累计，暂停仍计时；到期只停止新派发，已发出的调用继续。Token 仅提醒，用量可能不完整；不提供 Token 或费用硬限制。</p>
    <p v-if="!validBudget" role="alert">可选值须为正整数：并发最多 32，时限最多 604800 秒，Token 提醒最多 1000000000000。</p>
   </details>
   <button class="btn" :disabled="!canActivate" @click="confirm='activate'">激活此计划</button>
   <div v-if="confirm==='activate'"><p>确认激活草稿 v{{ plan.plan.revision }}，调用总上限 {{ invocationLimit }} 次。{{ budgetSummary }} 激活后按依赖自动调度，预算不能修改或通过暂停、恢复重置。</p><button class="btn" :disabled="!canActivate" @click="submit">确认激活计划</button><button class="btn" @click="confirm=null">取消</button></div>
  </template>
  <template v-else-if="execution.can_control && action">
   <button class="btn" :disabled="!allowed" @click="confirm=action">{{ action==='pause'?'暂停后续调度':'恢复后续调度' }}</button>
   <button class="btn" :disabled="!cancellable" @click="confirm='cancel'">取消后续调度</button>
   <div v-if="confirm && !['reconcile','retry','new_version','adopt_revision'].includes(confirm)"><p>{{ confirm==='cancel'?'取消后不能恢复本计划的调度；已发出的调用继续运行，仍需核对结果。':confirm==='pause'?'只暂停新步骤预留，已发出的调用继续运行。':'恢复后将按依赖继续预留新步骤，预算不会重置。' }}</p><button class="btn" :disabled="confirm==='cancel'?!cancellable:!allowed" @click="submit">{{ confirm==='cancel'?'确认取消后续调度':confirm==='pause'?'确认暂停':'确认恢复' }}</button><button class="btn" @click="confirm=null">取消</button></div>
  </template>
  <template v-if="!pending && canAdoptTaskPlan(execution,draft) && draft?.plan">
   <details><summary>待采用草稿 v{{ draft.plan.revision }}</summary>
    <article v-for="step in draft.plan.steps" :key="step.step_id"><h4>{{ step.title }}</h4><p>{{ step.instruction }}</p><p>验收：{{ step.acceptance }}</p><p>{{ step.required?'必需':'可选' }} · 依赖：{{ step.depends_on.map(id=>draft?.plan?.steps.find(s=>s.step_id===id)?.title||id).join('、')||'无' }}</p><p>主交付 Agent：{{ offerName(step.review_policy.primary_offer_id) }} · 验收人：{{ memberName(step.review_policy.reviewer_user_id) }} · 必需检查：{{ step.review_policy.required_checks.join('、')||'无' }}</p></article>
   </details>
   <button class="btn" :disabled="!canAdopt" @click="confirm='adopt_revision'">采用草稿 v{{ draft.plan.revision }}</button>
   <div v-if="confirm==='adopt_revision'"><p>将生效计划切换到草稿 v{{ draft.plan.revision }}，随后仍保持暂停；恢复需要另行确认。已开始步骤、冻结输入和累计预算保留。</p><button class="btn" :disabled="!canAdopt" @click="submit">确认采用修订</button><button class="btn" @click="confirm=null">取消</button></div>
  </template>
  <template v-if="!pending && execution.can_control && execution.runtime && execution.attempts.some(a=>a.call_id)">
   <label>核对原步骤 <ActionSelect><select aria-label="核对原步骤" v-model="selectedAttempt" :disabled="operations.blocked.value || !available"><option value="">选择尝试</option><option v-for="attempt in execution.attempts.filter(a=>a.call_id)" :key="attempt.attempt_id" :value="attempt.attempt_id">{{ attempt.step_id }} · 第 {{ attempt.attempt_no }} 次</option></select></ActionSelect></label>
   <button class="btn" :disabled="!canReconcile" @click="confirm='reconcile'">核对原步骤状态</button>
   <button v-if="canRetryTaskAttempt(execution,selectedAttempt)" class="btn" :disabled="!canRetry" @click="confirm='retry'">重新尝试此步骤</button>
   <template v-if="canCreateTaskStepVersion(execution,selectedAttempt)">
    <button class="btn" :disabled="!canReconcile" @click="versionForm=true;confirm=null">生成新版本</button>
    <div v-if="versionForm">
     <p>保留步骤 {{ original?.step_id }} 第 {{ original?.attempt_no }} 次的已验收交付。新增一次调用，消耗剩余预算；已开始的下游继续使用原输入，不会自动更新。</p>
     <label>新版本说明（必填，最多 1000 字符）<textarea aria-label="新版本说明" v-model="versionReason" rows="4" maxlength="1000" :disabled="operations.blocked.value || !available" /></label>
     <button class="btn" :disabled="!canNewVersion" @click="confirm='new_version'">核对新版本</button>
     <button class="btn" @click="versionForm=false;confirm=null">收起</button>
     <div v-if="confirm==='new_version'" role="group" aria-label="确认生成新版本"><p>确认生成新版本？说明：{{ versionReason }}</p><button class="btn" :disabled="!canNewVersion" @click="submit">确认生成新版本</button><button class="btn" @click="confirm=null">返回修改</button></div>
    </div>
   </template>
   <div v-if="confirm==='retry'"><p>将创建新的步骤尝试和一次调用，沿用已验收的依赖与剩余预算；原尝试和文件保留。结果未知时不能重试。</p><button class="btn" :disabled="!canRetry" @click="submit">确认新建尝试</button><button class="btn" @click="confirm=null">取消</button></div>
   <div v-if="confirm==='reconcile'"><p>只按 Relay 保存的原调用核对步骤状态，不探测原生进程、不创建新调用。未知结果仍可能保持未知。</p><button class="btn" :disabled="!canReconcile" @click="submit">确认核对原步骤</button><button class="btn" @click="confirm=null">取消</button></div>
  </template>
 </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TeamMember } from '../../types/team'
import type { DeliveryManagement } from '../../types/teamDelivery'
import ActionSelect from '../ActionSelect.vue'
import { useTeamDeliveryOperation } from '../../composables/useTeamDeliveryOperation'
import { canCreateTaskStepVersion, validNewVersionReason, validTaskBudget, type TaskBudgetPolicy, canAdoptTaskPlan, canActivateTaskPlan, canRetryTaskAttempt, type TaskPlanSnapshot, type TaskPlanExecution } from '../../types/teamPlan'
const props=defineProps<{taskId:string;currentUserId:number;available:boolean;execution:TaskPlanExecution;plan?:TaskPlanSnapshot;draft?:TaskPlanSnapshot;members?:TeamMember[];offers?:DeliveryManagement['offers']}>()
const emit=defineEmits<{changed:[failure?:string];revoked:[]}>()
const confirm=ref<'adopt_revision'|'activate'|'pause'|'resume'|'cancel'|'reconcile'|'retry'|'new_version'|null>(null)
const operations=useTeamDeliveryOperation(()=>props.taskId,()=>props.currentUserId,failure=>{confirm.value=null;emit('changed',failure)},()=>{confirm.value=null;emit('revoked')})
const selectedAttempt=ref('')
const versionForm=ref(false),versionReason=ref('')
const canNewVersion=computed(()=>canReconcile.value&&canCreateTaskStepVersion(props.execution,selectedAttempt.value)&&validNewVersionReason(versionReason.value))
watch(versionReason,()=>{confirm.value=null})
watch([selectedAttempt,()=>props.taskId,()=>props.currentUserId],()=>{versionForm.value=false;versionReason.value=''})
const invocationLimit=ref<number|string>('')
const concurrentLimit=ref<number|string>(''),durationLimit=ref<number|string>(''),tokenWarning=ref<number|string>('')
const budget=computed<TaskBudgetPolicy>(()=>({...concurrentLimit.value!==''?{max_concurrent_calls:Number(concurrentLimit.value)}:{},...durationLimit.value!==''?{max_duration_seconds:Number(durationLimit.value)}:{},...tokenWarning.value!==''?{token_warning_limit:Number(tokenWarning.value)}:{}}))
const validBudget=computed(()=>validTaskBudget(budget.value))
const budgetSummary=computed(()=>`并发 ${concurrentLimit.value||'不设置'}；停止新派发时限 ${durationLimit.value?durationLimit.value+' 秒':'不设置'}；Token 提醒 ${tokenWarning.value||'不设置'}。`)
watch([()=>props.taskId,()=>props.currentUserId],()=>{invocationLimit.value='';concurrentLimit.value='';durationLimit.value='';tokenWarning.value=''})
const canAdopt=computed(()=>props.available&&!operations.blocked.value&&canAdoptTaskPlan(props.execution,props.draft))
watch(()=>props.draft?.revision,()=>{confirm.value=null})
const canActivate=computed(()=>props.available&&!operations.blocked.value&&validBudget.value&&canActivateTaskPlan(props.execution,props.plan,Number(invocationLimit.value)))
watch([()=>props.plan?.plan?.revision,invocationLimit,concurrentLimit,durationLimit,tokenWarning],()=>{confirm.value=null})
const original=computed(()=>props.execution.attempts.find(a=>a.attempt_id===selectedAttempt.value&&a.call_id))
watch(()=>JSON.stringify(original.value),()=>{confirm.value=null})
const canRetry=computed(()=>canReconcile.value&&canRetryTaskAttempt(props.execution,selectedAttempt.value))
const canReconcile=computed(()=>props.available&&!operations.blocked.value&&props.execution.can_control&&!!props.execution.runtime&&!!original.value)
watch(selectedAttempt,()=>{confirm.value=null})
const pending=computed(()=>operations.pending.value?.operation.kind==='plan_control')
const action=computed(()=>props.execution.runtime?.state==='active'?'pause':props.execution.runtime?.state==='paused'?'resume':null)
const cancellable=computed(()=>props.available&&!operations.blocked.value&&props.execution.can_control&&!!action.value)
const allowed=computed(()=>cancellable.value&&(action.value==='pause'||props.execution.execution_enabled))
watch([()=>props.available,()=>props.execution.revision,()=>props.currentUserId,()=>props.taskId,()=>props.execution.can_control],()=>{confirm.value=null})
function memberName(id:number){return props.members?.find(m=>m.user_id===id)?.display_label||(id===props.currentUserId?'我':'原验收人')}
function offerName(id:string){const offer=props.offers?.find(o=>o.offer_id===id);return offer?`${offer.provider} · ${memberName(offer.owner_user_id)}`:'原 Agent（当前目录不可用）'}
async function submit(){
 if(!confirm.value)return
 if(confirm.value==='adopt_revision'){if(!canAdopt.value||!props.draft?.plan)return;confirm.value=null;await operations.submit({kind:'plan_control',input:{request_id:crypto.randomUUID(),expected_revision:props.execution.revision,plan_revision:props.draft.plan.revision,action:'adopt_revision'}});return}
 if(confirm.value==='activate'){if(!canActivate.value||!props.plan?.plan)return;confirm.value=null;await operations.submit({kind:'plan_control',input:{request_id:crypto.randomUUID(),expected_revision:0,plan_revision:props.plan.plan.revision,action:'activate',invocation_limit:Number(invocationLimit.value),...(Object.keys(budget.value).length?{budget:{...budget.value}}:{})}});return}
 if(!props.execution.runtime)return
 if(confirm.value==='new_version'){if(!canNewVersion.value||!original.value)return;const attempt=original.value;confirm.value=null;await operations.submit({kind:'plan_control',expectedState:'active',expectedCallId:attempt.call_id!,input:{request_id:crypto.randomUUID(),expected_revision:props.execution.revision,plan_revision:props.execution.runtime.plan_revision,action:'new_version',attempt_id:attempt.attempt_id,expected_delivery_revision:attempt.delivery_revision!,reason:versionReason.value}});return}
 if(confirm.value==='retry'){if(!canRetry.value||!original.value)return;const attempt=original.value;confirm.value=null;await operations.submit({kind:'plan_control',expectedState:'active',expectedCallId:attempt.call_id!,input:{request_id:crypto.randomUUID(),expected_revision:props.execution.revision,plan_revision:props.execution.runtime.plan_revision,action:'retry',attempt_id:attempt.attempt_id,expected_delivery_revision:attempt.delivery_revision!}});return}
 if(confirm.value==='reconcile'){if(!canReconcile.value||!original.value)return;const attempt=original.value;confirm.value=null;await operations.submit({kind:'plan_control',expectedState:props.execution.runtime.state,expectedCallId:attempt.call_id!,input:{request_id:crypto.randomUUID(),expected_revision:props.execution.revision,plan_revision:props.execution.runtime.plan_revision,action:'reconcile',attempt_id:attempt.attempt_id}});return}
 if(confirm.value==='cancel'?!cancellable.value:!allowed.value||confirm.value!==action.value)return
 const input={request_id:crypto.randomUUID(),expected_revision:props.execution.revision,plan_revision:props.execution.runtime.plan_revision,action:confirm.value!}
 confirm.value=null;await operations.submit({kind:'plan_control',input})
}
</script>

<style scoped>
textarea{display:block;width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
details label{display:block;margin-top:10px}
input[type=number]{width:7rem;margin-left:8px;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
</style>
