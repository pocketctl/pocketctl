<template>
 <section aria-label="执行步骤">
  <div class="delivery-toolbar"><h4>{{ page==='steps'?'执行步骤':page==='budget'?'执行预算':page==='delivery'?'步骤交付':'恢复上下文' }}</h4><button class="btn" :disabled="loading || !available || revoked" @click="load">刷新步骤</button></div>
  <p v-if="!available">恢复连接并确认当前权限后才能读取步骤。</p>
  <p v-if="notice" role="status">{{ notice }}</p>
  <p v-if="error" role="alert">{{ error }}</p><p v-if="loading" role="status">正在读取计划…</p>
  <template v-if="execution && plan">
   <TeamTaskPlanEditor :task-id="taskId" :current-user-id="currentUserId" :available="available && !revoked" :execution="execution" :members="members" @changed="operationChanged" @revoked="clear(); revoked=true; emit('revoked')" />
   <button v-if="page!=='steps'" class="btn" @click="page='steps'">返回执行步骤</button>
   <template v-if="page==='steps'">
   <p v-if="!plan.plan">尚无执行计划。此任务沿用原有交付流程。</p>
   <template v-else>
    <p>{{ execution.runtime?'生效计划':'未激活草稿' }} v{{ plan.plan.revision }} · {{ execution.runtime?runtimeLabel:'尚未调度' }}</p>
    <p v-if="execution.runtime">暂停或取消只影响后续预留。已经发出的调用继续运行。</p>
    <p v-if="!execution.execution_enabled">服务端未开放新步骤执行；仍可查阅已有记录。</p>
    <p v-if="execution.scheduler.last_error_code">调度待处理：{{ taskDiagnosticLabel(execution.scheduler.last_error_code) }}</p>
    <TeamTaskPlanControls :task-id="taskId" :current-user-id="currentUserId" :available="available && !revoked" :execution="execution" :plan="plan" :draft="newDraft||undefined" :members="members" :offers="management?.display_offers" @changed="operationChanged" @revoked="clear(); revoked=true; emit('revoked')" />
    <article v-for="step in plan.plan.steps" :key="step.step_id" class="step">
     <h4>{{ step.title }} · {{ taskStepLabel(latest(step.step_id)?.state) }}</h4><p>{{ step.required?'必需步骤':'可选步骤' }} · {{ step.depends_on.length?`依赖：${step.depends_on.map(title).join('、')}`:'无前置依赖' }}</p>
     <details><summary>目标与验收</summary><p class="copy">{{ step.instruction }}</p><p class="copy">{{ step.acceptance }}</p></details>
     <p v-if="latest(step.step_id)?.call_state">原调用：{{ callLabel(latest(step.step_id)?.call_state) }} · 步骤状态可能稍后同步</p>
     <div v-for="attempt in execution.attempts.filter(a=>a.step_id===step.step_id)" :key="attempt.attempt_id"><button class="btn" @click="selected=attempt.attempt_id; page='delivery'">第 {{ attempt.attempt_no }} 次 · 查看步骤交付</button><button :key="attempt.attempt_id" class="btn" :aria-pressed="selected===attempt.attempt_id" :disabled="contextLoading" @click="select(attempt.attempt_id)">第 {{ attempt.attempt_no }} 次 · {{ taskStepLabel(attempt.state) }} · 查看上下文</button></div>
    </article>
   </template>
   <button class="btn" @click="page='budget'">查看执行预算</button>
   <button class="btn" :disabled="contextLoading" @click="select()">恢复任务上下文</button>
   </template>
   <TeamTaskDeliveryPanel v-if="page==='delivery' && selected" :key="selected" :task-id="taskId" :attempt-id="selected" :current-user-id="currentUserId" @revoked="clear(); revoked=true; emit('revoked')" />
   <TeamTaskBudget v-if="page==='budget'" :budget="execution.budget" />
   <TeamTaskRecovery v-if="page==='recovery'" :context="context" :loading="contextLoading" />
  </template>
 </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { getRelayOrigin } from '../../composables/useEnv'
import type { TeamMember } from '../../types/team'
import type { DeliveryManagement } from '../../types/teamDelivery'
import { getDeliveryManagement } from '../../services/teamDeliveryClient'
import { TeamApiError } from '../../services/teamClient'
import { getTaskContext, getTaskPlan, getTaskPlanExecution } from '../../services/teamPlanClient'
import { taskDiagnosticLabel, taskStepLabel, type TaskContext, type TaskPlanExecution, type TaskPlanSnapshot } from '../../types/teamPlan'
import TeamTaskDeliveryPanel from './TeamTaskDeliveryPanel.vue'
import TeamTaskPlanEditor from './TeamTaskPlanEditor.vue'
import TeamTaskPlanControls from './TeamTaskPlanControls.vue'
import TeamTaskBudget from './TeamTaskBudget.vue'
import TeamTaskRecovery from './TeamTaskRecovery.vue'
const props=defineProps<{taskId:string;currentUserId:number;available:boolean;members?:TeamMember[]}>()
const emit=defineEmits<{revoked:[]}>()
const plan=ref<TaskPlanSnapshot|null>(null),execution=ref<TaskPlanExecution|null>(null),context=ref<TaskContext|null>(null)
const management=ref<DeliveryManagement|null>(null)
const newDraft=ref<TaskPlanSnapshot|null>(null)
const notice=ref('')
const loading=ref(false),contextLoading=ref(false),error=ref(''),selected=ref(''),revoked=ref(false)
const page=ref<'steps'|'budget'|'recovery'|'delivery'>('steps')
let generation=0,contextGeneration=0
const runtimeLabel=computed(()=>({active:'运行中',paused:'已暂停',cancelled:'已取消'} as Record<string,string>)[execution.value?.runtime?.state||'']||'状态待核对')
function latest(step:string){return execution.value?.attempts.filter(a=>a.step_id===step).reduce<(TaskPlanExecution['attempts'][number])|undefined>((last,a)=>!last||a.attempt_no>last.attempt_no?a:last,undefined)}
function title(id:string){return plan.value?.plan?.steps.find(s=>s.step_id===id)?.title||id}
function callLabel(value?:string|null){return ({pending:'等待派发',dispatched:'已派发',accepted:'已接收',completed:'执行结束',failed:'执行失败',blocked:'执行阻塞',cancelled:'已取消',uncertain:'结果待核对'} as Record<string,string>)[value||'']||'未知'}
function clear(){notice.value='';generation++;contextGeneration++;plan.value=null;newDraft.value=null;management.value=null;execution.value=null;context.value=null;selected.value='';loading.value=false;contextLoading.value=false}
function failure(e:unknown){
 if(e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')){clear();revoked.value=true;error.value='你已无权访问此任务。';emit('revoked')}
 else error.value=e instanceof TeamApiError&&e.status===404?'此 Relay 暂不支持步骤读取。':e instanceof Error?e.message:'读取失败，请刷新重试。'
}
async function select(attempt?:string){if(!props.available||revoked.value)return;const g=generation,c=++contextGeneration;context.value=null;selected.value=attempt||'';contextLoading.value=true;page.value='recovery'
 try{const result=await getTaskContext(props.taskId,attempt);if(g!==generation||c!==contextGeneration)return;if(result.task.task_id!==props.taskId||result.attempt?.attempt_id!==(attempt||undefined))throw Error('上下文身份不匹配，请刷新。');context.value=result}
 catch(e){if(g===generation&&c===contextGeneration)failure(e)}finally{if(g===generation&&c===contextGeneration)contextLoading.value=false}}
async function operationChanged(failure?:string){await load();if(execution.value&&!revoked.value){if(failure)error.value=failure;else notice.value='原计划操作已确认，已刷新步骤状态。'}}
async function load(){if(!props.available||revoked.value)return;clear();page.value='steps';const g=generation;loading.value=true;error.value=''
 try{const result=await getTaskPlanExecution(props.taskId);if(g!==generation)return;const draft=await getTaskPlan(props.taskId,result.runtime?.plan_revision);if(g!==generation)return
  if(result.task_id!==props.taskId||draft.task_id!==props.taskId||result.runtime&&draft.plan?.revision!==result.runtime.plan_revision)throw Error('计划版本发生变化，请刷新。')
  if(result.runtime?.state==='paused'&&result.can_control&&result.execution_enabled&&draft.revision>result.runtime.plan_revision){
   const latest=await getTaskPlan(props.taskId);if(g!==generation)return
   if(latest.task_id!==props.taskId||latest.plan?.revision!==latest.revision)throw Error('新草稿版本不匹配，请刷新。')
   const directory=await getDeliveryManagement(props.taskId);if(g!==generation)return
   management.value=directory;newDraft.value=latest
  }
  execution.value=result;plan.value=draft
 }catch(e){if(g===generation)failure(e)}finally{if(g===generation)loading.value=false}}
watch([()=>props.taskId,()=>props.currentUserId,()=>getRelayOrigin()],()=>{clear();revoked.value=false;error.value='';void load()},{immediate:true})
watch(()=>props.available,()=>{clear();if(props.available)void load()})
onBeforeUnmount(clear)
</script>
<style scoped>
.delivery-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}.step{padding:16px 0;border-bottom:1px solid var(--border)}p{color:var(--fg-secondary)}h4{margin:0}.copy{white-space:pre-wrap;overflow-wrap:anywhere}.btn{margin:8px 8px 0 0}summary{cursor:pointer}[role=alert]{color:var(--error)}
</style>
