<template>
 <section aria-label="AgentTeams 原执行恢复">
  <h5>AgentTeams · 最近操作结果</h5>
  <p class="delivery-muted">结果为最近一次查询或重试的记录，不代表实时状态。</p>
  <p role="status">{{ status }}</p>
  <p v-if="error" role="alert">{{ error }}</p>
  <details v-if="snapshot?.operation?.result?.remote_task_id"><summary>执行标识</summary><p>{{ snapshot.operation.result.remote_task_id }}</p></details>
  <button class="btn" :disabled="busy || !available || revoked" @click="refresh">刷新恢复记录</button>
  <button v-if="snapshot?.can_query" class="btn" :disabled="busy || !available" @click="send('query')">查询原执行</button>
  <button v-if="snapshot?.can_retry_original && !confirmation" class="btn" :disabled="busy || !available" @click="confirmation=snapshot.operation?.request_id || ''">重试原请求…</button>
  <div v-if="confirmation" role="group" aria-label="确认重试原请求">
   <p>已明确查无原执行。确认后仅使用原请求和冻结内容重试一次；保留原调用记录。</p>
   <button class="btn" :disabled="busy" @click="confirmation=''">取消</button>
   <button class="btn primary" :disabled="busy || !available" @click="send('retry_original')">确认重试原请求</button>
  </div>
  <p class="delivery-muted">不会自动重试。费用硬限制不可用；执行结束后仍需核对交付与验收。</p>
 </section>
</template>
<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {useAuth} from '../../composables/useAuth'
import {getRelayOrigin} from '../../composables/useEnv'
import {TeamApiError} from '../../services/teamClient'
import {readExternalRecovery,requestExternalRecovery,type ExternalRecoveryView} from '../../services/teamExternalRecoveryClient'
const props=defineProps<{sessionId:string;callId:string;currentUserId:number;available:boolean}>()
const emit=defineEmits<{revoked:[]}>(),auth=useAuth()
const snapshot=ref<ExternalRecoveryView|null>(null),busy=ref(false),error=ref(''),confirmation=ref(''),revoked=ref(false)
let generation=0,disposed=false,timer:ReturnType<typeof setInterval>|undefined
const status=computed(()=>{
 const op=snapshot.value?.operation
 if(!props.available)return '连接恢复后可核对原执行。'
 if(!snapshot.value)return '尚未核对恢复记录。'
 if(!op)return snapshot.value.can_query?'可查询原请求的实际执行状态。':'由当前 Agent 所有者查询原执行。'
 if(op.state==='pending')return '已保存操作，等待原执行器响应。'
 if(op.state==='expired')return '本次查询或重试未获确认，请先查询原执行。'
 return ({absent:'已明确查无原执行。',unknown:'结果仍不确定，请继续查询原执行。',pending:'原执行等待开始。',running:'原执行正在运行。',succeeded:'原执行已结束，请核对交付。',failed:'原执行失败，请核对记录。',cancelled:'已确认原执行停止。'} as Record<string,string>)[op.result?.state||'']||'执行结果待核对。'
})
function clear(){generation++;snapshot.value=null;confirmation.value='';busy.value=false;error.value=''}
function identity(){const g=generation,origin=getRelayOrigin(),userId=props.currentUserId;return {userId,origin,isCurrent:()=>!disposed&&g===generation&&props.available&&!revoked.value&&auth.user.value?.id===userId&&getRelayOrigin()===origin}}
function accept(value:ExternalRecoveryView){if(value.call_id!==props.callId||value.team_session_id!==props.sessionId||value.provider!=='agentteams'||typeof value.can_query!=='boolean'||typeof value.can_retry_original!=='boolean')throw Error('mismatched recovery');snapshot.value=value;if(!value.can_retry_original||value.operation?.request_id!==confirmation.value)confirmation.value=''}
function failure(e:unknown){confirmation.value='';snapshot.value=null;if(e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')){revoked.value=true;error.value='你已无权操作此执行。';emit('revoked')}else error.value='尚未确认结果，请刷新恢复记录；不会自动重发。'}
async function refresh(){if(busy.value||!props.available||revoked.value)return;const id=identity();if(!id.isCurrent())return;busy.value=true;try{const result=await readExternalRecovery(props.sessionId,props.callId,id);if(id.isCurrent()){accept(result);error.value=''}}catch(e){if(id.isCurrent())failure(e)}finally{if(id.isCurrent())busy.value=false}}
async function send(action:'query'|'retry_original'){
 if(busy.value||!props.available||!snapshot.value||revoked.value)return
 const query=confirmation.value
 if(action==='query'?!snapshot.value.can_query:!snapshot.value.can_retry_original||query!==snapshot.value.operation?.request_id||!query)return
 const id=identity();if(!id.isCurrent())return;busy.value=true;confirmation.value=''
 try{const result=await requestExternalRecovery(props.sessionId,props.callId,{request_id:crypto.randomUUID(),action,...(action==='retry_original'?{expected_query_id:query}:{})},id);if(id.isCurrent()){accept(result);error.value=''}}catch(e){if(id.isCurrent())failure(e)}finally{if(id.isCurrent())busy.value=false}
}
watch([()=>props.sessionId,()=>props.callId,()=>props.currentUserId,()=>props.available,()=>auth.user.value?.id,()=>getRelayOrigin()],()=>{clear();revoked.value=false;void refresh()},{immediate:true})
onMounted(()=>{timer=setInterval(()=>{if(snapshot.value?.operation?.state==='pending')void refresh()},5000)})
onBeforeUnmount(()=>{disposed=true;clear();clearInterval(timer)})
</script>
