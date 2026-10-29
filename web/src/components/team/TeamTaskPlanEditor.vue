<template>
 <section aria-label="计划草稿编辑">
  <p v-if="error || operations.error.value" role="alert">{{ error || operations.error.value }}</p>
  <p v-if="operations.storageError.value" role="alert">{{ operations.storageError.value }} <button class="btn" @click="operations.refresh()">重新读取操作记录</button></p>
  <template v-if="pending">
   <p>草稿保存结果尚未确认。查询原操作后再继续，不会自动激活计划。</p>
   <button class="btn" :disabled="!available || operations.busy.value || !operations.ready.value" @click="operations.resolve()">查询原草稿保存</button>
   <button v-if="operations.receiptMissing.value" class="btn" :disabled="!available || operations.busy.value" @click="operations.confirmRetry.value=true">重试原草稿保存</button>
   <div v-if="operations.confirmRetry.value"><p>使用原版本、原请求和原内容重试保存；不会启动调度。</p><button class="btn" :disabled="!available || operations.busy.value" @click="operations.retry()">确认重试原草稿</button><button class="btn" @click="operations.confirmRetry.value=false">取消重试</button></div>
  </template>
  <template v-else-if="execution.can_control">
   <button v-if="!editing" class="btn" :disabled="!ready" @click="edit">{{ loading?'读取草稿…':'编辑计划草稿' }}</button>
   <form v-else @submit.prevent="confirm ? save() : confirm=true">
    <p>保存只创建新草稿，不会激活或采用修订。已开始步骤保留原定义与冻结输入。</p>
    <fieldset :disabled="!ready || confirm">
     <label>共享会话<ActionSelect><select v-model="sessionId" aria-label="计划共享会话" :disabled="!!options?.locked_session_id"><option value="">请选择</option><option v-for="s in options?.sessions" :key="s.team_session_id" :value="s.team_session_id">{{ s.title }}</option></select></ActionSelect></label>
     <p>规格 v{{ options?.spec_revision }} · 共享材料 Context v{{ session?.current_context_version ?? '—' }}</p>
     <fieldset v-for="(step,index) in steps" :key="step.step_id" :disabled="locked(step.step_id)">
      <legend>步骤 {{ index+1 }}{{ locked(step.step_id)?' · 已开始，只读':'' }}</legend>
      <label>标题<input v-model="step.title" :aria-label="`步骤 ${index+1} 标题`" maxlength="120" required /></label>
      <label>执行目标<textarea v-model="step.instruction" :aria-label="`步骤 ${index+1} 目标`" maxlength="16000" rows="3" required /></label>
      <label>验收标准<textarea v-model="step.acceptance" :aria-label="`步骤 ${index+1} 验收标准`" maxlength="8000" rows="3" required /></label>
      <label><input type="checkbox" v-model="step.required" />必需步骤</label>
      <label>主交付 Agent<ActionSelect><select v-model="step.review_policy.primary_offer_id" :aria-label="`步骤 ${index+1} Agent`"><option v-if="!session?.offer_ids.includes(step.review_policy.primary_offer_id)" :value="step.review_policy.primary_offer_id">{{ step.review_policy.primary_offer_id?'原 Agent 当前不可用':'请选择' }}</option><option v-for="id in session?.offer_ids" :key="id" :value="id">{{ offerName(id) }}</option></select></ActionSelect></label>
      <label>验收人<ActionSelect><select v-model.number="step.review_policy.reviewer_user_id" :aria-label="`步骤 ${index+1} 验收人`"><option v-if="!options?.reviewers.some(r=>r.user_id===step.review_policy.reviewer_user_id)" :value="step.review_policy.reviewer_user_id">请选择当前可用验收人</option><option v-for="r in options?.reviewers" :key="r.user_id" :value="r.user_id">{{ memberName(r.user_id) }}</option></select></ActionSelect></label>
      <label>必需检查项（每行一项）<textarea :value="step.review_policy.required_checks.join('\n')" :aria-label="`步骤 ${index+1} 必需检查项`" @input="step.review_policy.required_checks=($event.target as HTMLTextAreaElement).value.split('\n')" rows="3" /></label>
      <p>前置步骤（全部验收后才能开始）</p>
      <label v-for="parent in steps.filter(s=>s.step_id!==step.step_id)" :key="parent.step_id"><input type="checkbox" v-model="step.depends_on" :value="parent.step_id" />{{ parent.title||'未命名步骤' }}</label>
      <button class="btn" type="button" :disabled="steps.length<=1 || steps.some(s=>locked(s.step_id)&&s.depends_on.includes(step.step_id))" @click="remove(step.step_id)">移除此步骤</button>
     </fieldset>
     <button class="btn" type="button" :disabled="steps.length>=32" @click="add">添加步骤</button>
    </fieldset>
    <p v-if="!valid">请补齐所有步骤、可用 Agent 与验收人，至少保留一个必需步骤；依赖不能成环，已开始步骤不能修改，草稿请求不得超过 128 KiB。</p>
    <p v-if="confirm" role="status">确认保存为草稿 v{{ (options?.revision??0)+1 }}？当前生效计划、调用与预算保持不变。</p>
    <button class="btn" type="button" :disabled="operations.busy.value" @click="confirm ? confirm=false : close()">{{ confirm?'返回修改':'取消编辑' }}</button>
    <button class="btn" type="submit" :disabled="!ready || !valid">{{ confirm?'确认保存草稿':'核对草稿' }}</button>
   </form>
  </template>
 </section>
</template>
<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue'
import ActionSelect from '../ActionSelect.vue'
import {getRelayOrigin} from '../../composables/useEnv'
import {useTeamDeliveryOperation} from '../../composables/useTeamDeliveryOperation'
import {TeamApiError} from '../../services/teamClient'
import {getTaskPlan,getTaskPlanEditingOptions} from '../../services/teamPlanClient'
import {validTaskPlanDraft,type TaskPlanDraft,type TaskPlanEditingOptions,type TaskPlanExecution,type TaskPlanStep} from '../../types/teamPlan'
import type {TeamMember} from '../../types/team'
const props=defineProps<{taskId:string;currentUserId:number;available:boolean;execution:TaskPlanExecution;members?:TeamMember[]}>()
const emit=defineEmits<{changed:[failure?:string];revoked:[]}>()
const editing=ref(false),loading=ref(false),confirm=ref(false),error=ref(''),sessionId=ref(''),steps=ref<TaskPlanStep[]>([]),original=ref<TaskPlanStep[]>([]),options=ref<TaskPlanEditingOptions|null>(null)
let generation=0
function close(){generation++;editing.value=false;loading.value=false;confirm.value=false;steps.value=[];original.value=[];options.value=null;sessionId.value=''}
const operations=useTeamDeliveryOperation(()=>props.taskId,()=>props.currentUserId,failure=>{close();emit('changed',failure)},()=>{close();emit('revoked')})
const pending=computed(()=>operations.pending.value?.operation.kind==='plan_draft')
const ready=computed(()=>props.available&&props.execution.can_control&&!operations.blocked.value&&!loading.value)
const session=computed(()=>options.value?.sessions.find(s=>s.team_session_id===sessionId.value))
function locked(id:string){return options.value?.started_step_ids.includes(id)||props.execution.attempts.some(a=>a.step_id===id)}
const normalized=(s:TaskPlanStep)=>locked(s.step_id)?s:({...s,review_policy:{...s.review_policy,required_checks:s.review_policy.required_checks.map(c=>c.trim()).filter(Boolean)}})
const input=computed<TaskPlanDraft>(()=>({request_id:'validation',expected_revision:options.value?.revision??0,team_session_id:sessionId.value,context_version:session.value?.current_context_version??-1,spec_revision:options.value?.spec_revision??0,steps:steps.value.map(normalized)}))
const valid=computed(()=>options.value?.can_edit&&!!session.value&&validTaskPlanDraft(input.value)&&steps.value.every(s=>session.value!.offer_ids.includes(s.review_policy.primary_offer_id)&&options.value!.reviewers.some(r=>r.user_id===s.review_policy.reviewer_user_id)&&(!locked(s.step_id)||JSON.stringify(normalized(s))===JSON.stringify(original.value.find(o=>o.step_id===s.step_id)))))
function memberName(id:number){return props.members?.find(m=>m.user_id===id)?.display_label||(id===props.currentUserId?'我':`成员 ${id}`)}
function offerName(id:string){const o=options.value?.offers.find(o=>o.offer_id===id);return o?`${o.provider} · ${memberName(o.owner_user_id)}`:'原 Agent'}
function add(){steps.value.push({step_id:`step_${crypto.randomUUID().replace(/-/g,'')}`,title:'',instruction:'',acceptance:'',required:true,depends_on:[],review_policy:{reviewer_user_id:options.value?.reviewers[0]?.user_id??0,primary_offer_id:session.value?.offer_ids[0]??'',required_checks:[]}})}
function remove(id:string){if(locked(id)||steps.value.some(s=>locked(s.step_id)&&s.depends_on.includes(id)))return;steps.value=steps.value.filter(s=>s.step_id!==id).map(s=>({...s,depends_on:s.depends_on.filter(d=>d!==id)}))}
async function edit(){if(!ready.value)return;close();const g=generation;loading.value=true;error.value=''
 try{const [snapshot,choices]=await Promise.all([getTaskPlan(props.taskId),getTaskPlanEditingOptions(props.taskId)]);if(g!==generation)return
  if(snapshot.task_id!==props.taskId||choices.task_id!==props.taskId||snapshot.revision!==choices.revision)throw Error('草稿版本已变化，请重新读取。')
  if(!snapshot.writes_enabled||!choices.can_edit)throw Error('当前不能编辑计划草稿。')
  options.value=choices;sessionId.value=snapshot.plan?.team_session_id||choices.locked_session_id||choices.sessions[0]?.team_session_id||''
  original.value=JSON.parse(JSON.stringify(snapshot.plan?.steps||[]));steps.value=JSON.parse(JSON.stringify(original.value));if(!steps.value.length)add();editing.value=true
 }catch(e){if(g!==generation)return;if(e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')){close();emit('revoked')}else error.value=e instanceof Error?e.message:'读取草稿失败，请重试。'}finally{if(g===generation)loading.value=false}}
async function save(){if(!ready.value||!valid.value||!confirm.value)return;confirm.value=false;await operations.submit({kind:'plan_draft',input:JSON.parse(JSON.stringify({...input.value,request_id:crypto.randomUUID()}))})}
watch([()=>props.taskId,()=>props.currentUserId,()=>props.available,()=>getRelayOrigin()],close)
watch(()=>props.execution.revision,()=>{confirm.value=false})
onBeforeUnmount(close)
</script>
<style scoped>
form,fieldset,label{display:grid;gap:10px}fieldset{border:1px solid var(--border);border-radius:8px;padding:12px;margin:12px 0}label:has(input[type=checkbox]){display:flex;align-items:center}input:not([type=checkbox]),textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}textarea{resize:vertical}p{color:var(--fg-secondary);font-size:12px}[role=alert]{color:var(--error)}.btn{margin:8px 8px 0 0}
</style>
