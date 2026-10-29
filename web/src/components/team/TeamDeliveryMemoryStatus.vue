<template>
 <section v-if="submission.decision==='accepted' && submission.personal_memory_capture != null" class="delivery-section" aria-label="个人 Memory">
  <h4>个人 Memory</h4>
  <p>{{ label }}</p>
  <p>验收通过只提供候选来源；个人确认不会自动发布到团队。</p>
  <p v-if="status?.source" class="delivery-copy">规格 v{{status.source.spec_revision}} · 交付 v{{status.source.submission_version}}</p>
  <p v-if="status?.personal_claims?.confirmed">已确认个人知识 {{status.personal_claims.confirmed}} 条，当前有效 {{status.personal_claims.current}} 条；不代表已进入 Context。</p>
  <p v-if="status?.candidates?.pending">待个人确认 {{status.candidates.pending}} 条</p>
  <p v-if="status?.candidates?.stale">{{status.candidates.stale}} 条候选的来源已变化，等待重新处理。</p>
  <p v-if="status?.candidates?.rejected">已忽略 {{status.candidates.rejected}} 条</p>
  <p v-if="error" role="alert">{{error}}</p>
  <div class="delivery-toolbar">
   <button v-if="canRead" class="btn" :disabled="loading" @click="load">{{loading?'正在核对…':'刷新 Memory 状态'}}</button>
   <RouterLink v-if="available && !blocked && auth.user.value?.id===currentUserId && submission.personal_memory_capture!=='withdrawn'" class="btn" :to="memoryLink">{{status?.candidates?.pending?'审核此交付候选':'打开个人记忆'}}</RouterLink>
  </div>
 </section>
</template>
<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {RouterLink} from 'vue-router'
import {useAuth} from '../../composables/useAuth'
import {getRelayOrigin} from '../../composables/useEnv'
import {deliveryCacheScope} from '../../services/teamDeliveryCache'
import {readDeliveryMemoryStatus,type DeliveryMemoryStatus} from '../../services/teamDeliveryMemoryClient'
import type {TaskSubmission} from '../../types/teamDelivery'
const props=defineProps<{taskId:string;teamId?:string;currentUserId:number;available:boolean;submission:TaskSubmission}>()
const auth=useAuth(),status=ref<DeliveryMemoryStatus|null>(null),error=ref(''),loading=ref(false)
let generation=0,disposed=false,controller:AbortController|undefined
const blocked=ref(false)
const canRead=computed(()=>props.available&&!blocked.value&&auth.user.value?.id===props.currentUserId&&props.submission.decision==='accepted'&&!!props.submission.decision_id&&['captured','access_revoked'].includes(props.submission.personal_memory_capture??''))
const memoryLink=computed(()=>status.value?.candidates?.pending?{path:'/memory',query:{tab:'review',submission:props.submission.submission_id,decision:props.submission.decision_id}}:{path:'/memory'})
const label=computed(()=>{
 if(!props.available||blocked.value)return '请联网并重新核对任务访问权限。'
 if(props.submission.personal_memory_capture==='withdrawn'||status.value?.source?.state==='withdrawn')return '交付来源已失效。'
 if(props.submission.personal_memory_capture==='not_captured')return '此验收未向你的个人 Memory 提供来源。'
 if(loading.value)return '正在核对个人 Memory 状态…'
 if(error.value)return 'Memory 状态尚未核对。'
 if(status.value?.source){
  if(status.value.candidates?.pending)return '候选已生成，等待个人确认。'
  if(status.value.personal_claims?.confirmed)return '此来源已有个人确认记录。'
  if(['failed','quarantined','provider_result_unknown'].includes(status.value.extraction_state??''))return '提取未成功完成，请在 Memory 中查看运行状态。'
  if(status.value.extraction_state==='succeeded')return '提取已完成，当前没有待确认候选。'
  return 'Memory 已收到来源，尚无可审核候选。'
 }
 if(props.submission.personal_memory_capture==='access_revoked')return '来源访问已撤销；已确认个人知识的状态需由 Memory 核对。'
 return '来源已写出，Memory 尚无可读取记录；不代表候选已生成。'
})
function clear(){generation++;controller?.abort();controller=undefined;status.value=null;error.value='';loading.value=false}
async function load(){
 clear();if(!canRead.value||disposed)return
 const g=generation,task=props.taskId,submission=props.submission.submission_id,decision=props.submission.decision_id!,actor=props.currentUserId,origin=getRelayOrigin()
 const current=()=>!disposed&&g===generation&&canRead.value&&auth.user.value?.id===actor&&props.taskId===task&&props.submission.submission_id===submission&&props.submission.decision_id===decision&&getRelayOrigin()===origin
 if(!current())return
 controller=new AbortController();loading.value=true
 try{const result=await readDeliveryMemoryStatus(task,submission,decision,{userId:actor,origin,isCurrent:current,signal:controller.signal});if(current())status.value=result}
 catch(e){if(current())error.value=e instanceof Error?e.message:'无法核对 Memory 状态，请重试。'}
 finally{if(g===generation)loading.value=false}
}
watch([()=>props.taskId,()=>props.submission.submission_id,()=>props.submission.decision_id,()=>props.submission.personal_memory_capture,()=>props.available,()=>props.currentUserId,()=>auth.user.value?.id,()=>getRelayOrigin()],()=>{blocked.value=false;void load()},{immediate:true})
function invalidated(event:Event){const d=(event as CustomEvent).detail;if(d?.filesOnly||d?.scope&&d.scope!==deliveryCacheScope(props.currentUserId,getRelayOrigin())||d?.team&&d.team!==props.teamId||d?.task&&d.task!==props.taskId)return;clear();blocked.value=true}
onMounted(()=>window.addEventListener('team-delivery-cache-revoked',invalidated))
onBeforeUnmount(()=>{disposed=true;clear();window.removeEventListener('team-delivery-cache-revoked',invalidated)})
</script>
