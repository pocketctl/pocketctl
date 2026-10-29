<template>
 <section class="task-management" aria-label="任务修订与执行">
  <p v-if="!operations.ready.value && !operations.storageError.value && !operations.revoked.value" role="status">正在读取操作记录…</p>
  <p v-if="operations.error.value" role="alert">{{ operations.error.value }}</p>
  <p v-if="operations.storageError.value" role="alert">{{ operations.storageError.value }} <button class="btn" :disabled="busy" @click="operations.refresh()">重新读取操作记录</button></p>
  <p v-if="error" role="alert">{{ error }}</p>
  <div v-if="pending" role="status">
   <p>操作结果尚未确认。查询原操作后再继续修改或执行。</p>
   <button class="btn" :disabled="busy || !online || !operations.ready.value" @click="operations.resolve()">查询修订或执行结果</button>
   <button v-if="receiptMissing && !confirmRetry" class="btn" :disabled="busy || !online || locked" @click="confirmRetry=true">重试原修订或执行</button>
   <div v-if="confirmRetry"><p>确认使用原请求和原内容重试？不会创建新的操作标识。</p><button class="btn" :disabled="busy || !online || locked" @click="operations.retry()">确认重试原修订或执行</button><button class="btn" :disabled="busy" @click="confirmRetry=false">取消重试</button></div>
  </div>
  <template v-if="options?.can_manage">
   <h4>当前规格 v{{ delivery.spec.revision }}</h4>
   <p class="copy">{{ delivery.spec.goal }}</p>
   <p class="copy">{{ delivery.spec.acceptance }}</p>
   <p>修订会生成新的规格版本。重新执行需要单独确认。</p>
   <div v-if="!mode" class="actions">
    <button class="btn" :disabled="!ready" @click="editSpec">修订验收要求</button>
    <button class="btn" :disabled="!ready || !!executionBlock" @click="editExecution">重新执行</button>
   </div>
   <p v-if="executionBlock">{{ executionBlock }}</p>
   <form v-if="mode" @submit.prevent="confirm ? submit() : confirm = true">
    <fieldset :disabled="!ready || confirm">
     <template v-if="mode==='revise'">
      <label>任务目标<textarea v-model="goal" aria-label="任务目标" maxlength="32000" rows="3" required /></label>
      <label>验收标准<textarea v-model="acceptance" aria-label="修订验收标准" maxlength="16000" rows="4" required /></label>
      <label>验收人<ActionSelect><select v-model.number="reviewer" aria-label="修订验收人"><option v-for="m in options.reviewers" :key="m.user_id" :value="m.user_id">{{ memberName(m.user_id) }}</option></select></ActionSelect></label>
      <label>主交付 Agent<ActionSelect><select v-model="primary" aria-label="修订主交付 Agent"><option v-for="o in options.offers" :key="o.offer_id" :value="o.offer_id">{{ offerName(o.offer_id) }}</option></select></ActionSelect></label>
      <label>必需检查项（每行一项）<textarea v-model="checks" aria-label="修订必需检查项" rows="3" maxlength="4128" /></label>
      <p>最多 32 项，每项不超过 120 字符；已有交付仍保留原规格和验收记录。</p>
     </template>
     <template v-else>
      <label>执行会话<ActionSelect><select v-model="sessionId" aria-label="执行会话"><option v-for="s in sessions" :key="s.team_session_id" :value="s.team_session_id">{{ s.title }}</option></select></ActionSelect></label>
      <p>使用规格 v{{ delivery.spec.revision }} · 共享材料 Context v{{ session?.current_context_version }}
      <span> · 任务版本 {{ options.task_revision }} · 需求 v{{ options.requirements_revision }}</span></p>
      <label v-for="id in session?.offer_ids || []" :key="id" class="agent-choice"><input v-model="targets" type="checkbox" :value="id" :disabled="id===delivery.spec.primary_offer_id" />{{ offerName(id) }}{{ id===delivery.spec.primary_offer_id?' · 主交付':'' }}</label>
      <p>需求或负责人状态变化后须重新核对。确认的需求版本随本次执行保留。
      这会创建新的执行调用，可能产生费用。原执行和交付记录会保留。</p>
     </template>
    </fieldset>
    <p v-if="confirm" role="status">{{ mode==='revise'?'确认保存新规格？保存后需要重新提交符合新标准的交付。':'确认按上述会话、Agent 和版本重新执行？' }}</p>
    <div class="actions"><button class="btn" type="button" :disabled="busy || !!pending" @click="confirm ? confirm=false : mode=null">{{ confirm?'返回修改':'取消' }}</button>
     <button class="btn primary" type="submit" :disabled="!ready || !valid">{{ confirm ? (mode==='revise'?'确认保存新规格':'确认重新执行') : '核对本次操作' }}</button></div>
   </form>
  </template>
  <button v-if="error && !pending" class="btn" :disabled="busy || loading" @click="load">重新读取操作权限</button>
 </section>
</template>
<script setup lang="ts">
import '../../assets/team-delivery.css'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ActionSelect from '../ActionSelect.vue'
import { getRelayOrigin } from '../../composables/useEnv'
import { TeamApiError } from '../../services/teamClient'
import { getDeliveryManagement } from '../../services/teamDeliveryClient'
import type { DeliveryManagement, DeliverySpecRevision, DeliveryExecute, TaskDelivery } from '../../types/teamDelivery'
import type { TeamMember } from '../../types/team'
import { useTeamDeliveryOperation } from '../../composables/useTeamDeliveryOperation'
const props=defineProps<{delivery:TaskDelivery; currentUserId:number; members:TeamMember[]; locked:boolean; verified:boolean}>()
const emit=defineEmits<{changed:[]; blocked:[boolean]; revoked:[]}>()
type Operation={kind:'revise_spec';input:DeliverySpecRevision;specRevision:number}|{kind:'execute_task';session:string;input:DeliveryExecute}
const options=ref<DeliveryManagement|null>(null), loading=ref(false), error=ref(''), online=ref(navigator.onLine)
const mode=ref<'revise'|'execute'|null>(null), confirm=ref(false), goal=ref(''), acceptance=ref(''), reviewer=ref(0), primary=ref(''), checks=ref('')
const sessionId=ref(''), targets=ref<string[]>([])
let epoch=0, read=0
const operations=useTeamDeliveryOperation(()=>props.delivery.task_id,()=>props.currentUserId,()=>{mode.value=null;confirm.value=false;options.value=null;emit('changed');window.dispatchEvent(new Event('team-delivery-changed'))},()=>{epoch++;read++;loading.value=false;options.value=null;mode.value=null;goal.value='';acceptance.value='';checks.value='';emit('revoked')})
const {busy,receiptMissing,confirmRetry}=operations
const pending=computed(()=>['revise_spec','execute_task'].includes(operations.pending.value?.operation.kind||'')?operations.pending.value?.operation:null)
const sessions=computed(()=>options.value?.sessions.filter(s=>s.offer_ids.includes(props.delivery.spec.primary_offer_id))||[])
const session=computed(()=>sessions.value.find(s=>s.team_session_id===sessionId.value))
const checkList=computed(()=>checks.value.split('\n').map(s=>s.trim()).filter(Boolean))
const ready=computed(()=>props.verified && !operations.blocked.value && online.value && !props.locked && !busy.value && !loading.value && !pending.value && options.value?.can_manage && options.value.revision===props.delivery.revision)
const executionBlock=computed(()=> !Number.isSafeInteger(options.value?.task_revision)||(options.value?.task_revision??0)<1||!Number.isSafeInteger(options.value?.requirements_revision)||(options.value?.requirements_revision??-1)<0?'此 Relay 未提供执行确认版本，请更新服务端并重新读取。':options.value?.execution_block==='outstanding_execution'?'已有执行尚未结束或结果待核对，请先处理原执行。':options.value?.execution_block==='accepted_delivery'?'当前规格的主交付已通过；再次执行前请先修订规格。':!sessions.value.length?'没有包含主交付 Agent 的可执行会话。请检查会话参与权限、Agent 绑定及主机能力。':'')
const valid=computed(()=>mode.value==='revise' ? !!goal.value.trim() && !!acceptance.value.trim() && options.value?.reviewers.some(m=>m.user_id===reviewer.value) && options.value?.offers.some(o=>o.offer_id===primary.value) && checkList.value.length<=32 && checkList.value.every(c=>c.length<=120) && new Set(checkList.value).size===checkList.value.length : !executionBlock.value && !!session.value && targets.value.length<=16 && targets.value.includes(props.delivery.spec.primary_offer_id) && targets.value.every(id=>session.value!.offer_ids.includes(id)))
function memberName(id:number){return props.members.find(m=>m.user_id===id)?.display_label || (id===props.currentUserId?'我':`成员 ${id}`)}
function offerName(id:string){const o=options.value?.offers.find(o=>o.offer_id===id);return o?`${o.provider} · ${memberName(o.owner_user_id)}`:id}
function failure(e:unknown){error.value=e instanceof Error?e.message:'操作失败，请重试';if(e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found'))operations.revoke()}
async function load(){if(operations.revoked.value)return;const e=epoch,r=++read,id=props.delivery.task_id;if(!props.verified){options.value=null;loading.value=false;error.value='';return}loading.value=true;error.value='';try{const result=await getDeliveryManagement(id);if(e!==epoch||r!==read)return;options.value=result;if(!result.can_manage){mode.value=null;confirm.value=false}}catch(err){if(e===epoch&&r===read){options.value=null;if(err instanceof TeamApiError&&err.status===404&&err.code!=='team_not_found')error.value='此 Relay 暂不支持规格管理，请更新服务端。';else failure(err)}}finally{if(e===epoch&&r===read)loading.value=false}}
function editSpec(){if(!ready.value)return;const s=props.delivery.spec;goal.value=s.goal;acceptance.value=s.acceptance;reviewer.value=Number(s.reviewer_user_id);primary.value=s.primary_offer_id;checks.value=s.required_checks.join('\n');mode.value='revise';confirm.value=false}
function editExecution(){if(!ready.value||executionBlock.value)return;mode.value='execute';confirm.value=false;sessionId.value=sessions.value[0]?.team_session_id||'';targets.value=[props.delivery.spec.primary_offer_id]}
watch([()=>options.value?.task_revision,()=>options.value?.requirements_revision],()=>{confirm.value=false},{flush:'sync'})
watch(sessionId,()=>{targets.value=[props.delivery.spec.primary_offer_id];confirm.value=false})
async function submit(){if(!ready.value||!valid.value||!confirm.value)return
 const shared={request_id:crypto.randomUUID(),expected_revision:props.delivery.revision}
 const op:Operation=mode.value==='revise'?{kind:'revise_spec',specRevision:Number(props.delivery.spec.revision),input:{...shared,goal:goal.value.trim(),acceptance:acceptance.value.trim(),policy:{reviewer_user_id:reviewer.value,primary_offer_id:primary.value,required_checks:[...checkList.value]}}}:{kind:'execute_task',session:sessionId.value,input:{...shared,expected_task_revision:options.value!.task_revision,spec_revision:Number(props.delivery.spec.revision),context_version:session.value!.current_context_version,target_offer_ids:[...targets.value]}}
 await operations.submit(op)
}
watch([()=>props.delivery.task_id,()=>props.currentUserId,()=>getRelayOrigin()],()=>{epoch++;read++;loading.value=false;options.value=null;mode.value=null;confirm.value=false;error.value='';goal.value='';acceptance.value='';checks.value='';void load()},{immediate:true})
watch(()=>props.verified,()=>void load())
watch(()=>props.delivery.revision,()=>{confirm.value=false;mode.value=null;void load()})
watch(()=>!operations.ready.value||!!pending.value||busy.value,(value)=>emit('blocked',value),{immediate:true,flush:'sync'})
function connectivity(){online.value=navigator.onLine;confirm.value=false;if(online.value)void load()}
onMounted(()=>{window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity)})
onBeforeUnmount(()=>{epoch++;read++;window.removeEventListener('online',connectivity);window.removeEventListener('offline',connectivity);emit('blocked',false)})
</script>
<style scoped>
.task-management{padding:18px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.7}.task-management:empty{display:none}h4{margin:0}p{color:var(--fg-secondary)}.copy{white-space:pre-wrap;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;gap:8px}fieldset{border:0;padding:0;margin:0;min-width:0}label{display:grid;gap:8px;margin:12px 0}.agent-choice{display:flex;align-items:center}textarea{box-sizing:border-box;width:100%;padding:10px;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:6px;font:inherit}button:disabled{opacity:.5;cursor:not-allowed}[role=alert]{color:var(--error)}
</style>
