<template>
 <section v-if="source || error || loading" aria-label="模板来源">
  <p v-if="loading" role="status">正在核对模板来源…</p>
  <p v-if="error" role="alert">{{error}} <button v-if="!revoked" class="btn" :disabled="!available||loading" @click="load">重新读取来源</button></p>
  <details v-if="source"><summary>模板来源 · {{source.snapshot.name}} v{{source.template_revision}}</summary>
   <p>创建时冻结的模板快照。模板更新不改变此任务；后续计划修订请查看执行步骤。</p>
   <dl><template v-for="role in source.snapshot.roles" :key="role.role_id"><dt>{{role.label}} · {{role.kind==='agent'?'执行 Agent':'验收人'}}</dt><dd>{{binding(role.role_id,role.kind)}}</dd></template></dl>
   <details><summary>原始目标与验收</summary><p>{{source.snapshot.goal}}</p><p>{{source.snapshot.acceptance}}</p></details>
   <details><summary>原始步骤 · {{source.snapshot.steps.length}} 步</summary><ol><li v-for="step in source.snapshot.steps" :key="step.step_id">{{step.title}} · {{step.required?'必需':'可选'}}<p>依赖：{{step.depends_on.map(id=>source?.snapshot.steps.find(s=>s.step_id===id)?.title??id).join('、')||'无'}}</p></li></ol></details>
   <details v-if="source.snapshot.budget_suggestion"><summary>模板预算建议</summary><p>调用上限 {{source.snapshot.budget_suggestion.invocation_limit}}</p><p v-if="source.snapshot.budget_suggestion.policy?.max_concurrent_calls">并发上限 {{source.snapshot.budget_suggestion.policy.max_concurrent_calls}}</p><p v-if="source.snapshot.budget_suggestion.policy?.max_duration_seconds">停止新派发时限 {{source.snapshot.budget_suggestion.policy.max_duration_seconds}} 秒</p><p v-if="source.snapshot.budget_suggestion.policy?.token_warning_limit">Token 提醒 {{source.snapshot.budget_suggestion.policy.token_warning_limit}}，非硬限制</p><p>此处仅为创建时的建议；实际限制以执行预算为准。</p></details>
   <details><summary>快照校验信息</summary><p>模板 {{source.template_id}} · v{{source.template_revision}}</p><p>SHA-256：{{source.content_hash}}</p></details>
  </details>
 </section>
</template>
<script setup lang="ts">
import {onBeforeUnmount,onMounted,ref,watch} from 'vue'
import {useAuth} from '../../composables/useAuth'
import {getRelayOrigin} from '../../composables/useEnv'
import {deliveryCacheScope} from '../../services/teamDeliveryCache'
import {TeamApiError} from '../../services/teamClient'
import {getTaskTemplateSource} from '../../services/teamTemplateClient'
import {validTaskTemplateSource,type TaskTemplateSource} from '../../types/teamTemplate'
import type {TeamMember} from '../../types/team'
const props=defineProps<{teamId:string;taskId:string;currentUserId:number;available:boolean;members?:TeamMember[]}>()
const emit=defineEmits<{revoked:[]}>(),auth=useAuth()
const source=ref<TaskTemplateSource|null>(null),error=ref(''),loading=ref(false),revoked=ref(false)
let generation=0,disposed=false
const scope=()=>deliveryCacheScope(props.currentUserId,getRelayOrigin())
function clear(){generation++;source.value=null;loading.value=false;error.value=''}
function binding(id:string,kind:string){const value=source.value?.role_bindings[id];return kind==='agent'?`Agent · ${value}`:props.members?.find(m=>m.user_id===value)?.display_label??`原验收人 · 成员 ${value}`}
async function load(){
 clear();if(!props.available||revoked.value||disposed)return
 const g=generation,team=props.teamId,task=props.taskId,actor=props.currentUserId,origin=getRelayOrigin()
 const current=()=>!disposed&&g===generation&&props.available&&props.teamId===team&&props.taskId===task&&props.currentUserId===actor&&auth.user.value?.id===actor&&getRelayOrigin()===origin
 if(!current())return;loading.value=true
 try{const result=await getTaskTemplateSource(team,task,{userId:actor,origin,isCurrent:current});if(!current())return;if(!validTaskTemplateSource(result,task))throw Error('模板来源格式或任务身份不匹配。');source.value=result.source}
 catch(e){if(current()){if(e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')){clear();revoked.value=true;error.value='你已无权访问此任务。';emit('revoked')}else error.value=e instanceof TeamApiError&&e.status===404?'此 Relay 暂不支持模板来源读取。':'无法核对模板来源，请重试。'}}
 finally{if(g===generation)loading.value=false}
}
watch([()=>props.teamId,()=>props.taskId,()=>props.currentUserId,()=>props.available,()=>auth.user.value?.id,()=>getRelayOrigin(),scope],()=>{clear();revoked.value=false;void load()},{immediate:true})
function invalidated(event:Event){const d=(event as CustomEvent).detail;if(d?.filesOnly||d?.scope&&d.scope!==scope()||d?.team&&d.team!==props.teamId||d?.task&&d.task!==props.taskId)return;clear();revoked.value=true;emit('revoked')}
onMounted(()=>window.addEventListener('team-delivery-cache-revoked',invalidated))
onBeforeUnmount(()=>{disposed=true;clear();window.removeEventListener('team-delivery-cache-revoked',invalidated)})
</script>
<style scoped>
section{margin-block:12px;padding-block:12px;border-block:1px solid var(--border)}details details{margin-block:12px}summary{cursor:pointer}p,dd{color:var(--fg-secondary);white-space:pre-wrap;overflow-wrap:anywhere}dt{margin-top:12px}dd{margin-left:0}[role=alert]{color:var(--error)}
</style>
