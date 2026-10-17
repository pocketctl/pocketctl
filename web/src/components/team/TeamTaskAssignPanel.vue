<template>
 <ActionList :width="560" prefer-above mobile-sheet title="分派任务" @close="emit('close')">
  <form id="team-assign-task" class="task-form" @submit.prevent="submit">
   <label>任务说明（必填）<textarea v-model="instruction" required maxlength="32000" rows="5" placeholder="说明目标、范围和约束" /></label>
   <label>交付与验收（必填）<textarea v-model="acceptance" required maxlength="16000" rows="3" placeholder="例如：提交修改文件，并说明验证命令和结果" /></label>
   <fieldset><legend>执行 Agent</legend><label v-for="b in session.agent_bindings" :key="b.id"><input v-model="targets" type="checkbox" :value="b.offer_id" :disabled="b.availability!=='online'" />{{ b.provider }} · {{ b.daemon_id }}</label></fieldset>
   <p>本轮材料：Context v{{ session.current_context_version }}。派发后固定该版本和 Agent 配置。</p>
   <p v-if="error" role="alert">{{ error }}</p>
  </form>
  <template #footer><button type="submit" form="team-assign-task" :disabled="busy||!instruction.trim()||!acceptance.trim()||!targets.length">{{ busy?'正在派发…':'分派任务' }}</button></template>
 </ActionList>
</template>
<script setup lang="ts">
import {ref} from 'vue'
import ActionList from '../ActionList.vue'
import {assignTeamTask} from '../../services/teamClient'
import type {TeamSession,TeamEvent} from '../../types/team'
const props=defineProps<{session:TeamSession}>(),emit=defineEmits<{close:[];sent:[event:TeamEvent]}>()
const instruction=ref(''),acceptance=ref(''),targets=ref<string[]>([]),busy=ref(false),error=ref('')
let key='',signature=''
async function submit(){if(busy.value||!instruction.value.trim()||!acceptance.value.trim()||!targets.value.length)return;busy.value=true;error.value='';try{
 const body={instruction:instruction.value.trim(),acceptance:acceptance.value.trim(),target_offer_ids:targets.value,context_version:props.session.current_context_version},next=JSON.stringify(body)
 if(signature!==next){signature=next;key=crypto.randomUUID()}
 const result=await assignTeamTask(props.session.id,{...body,request_id:key});emit('sent',result.event);emit('close')
 }catch(e){error.value=e instanceof Error?e.message:'派发失败；重试保留原请求身份'}finally{busy.value=false}}
</script>
<style scoped>
.task-form{display:grid;gap:18px}.task-form>label{display:grid;gap:8px}textarea{width:100%;box-sizing:border-box;resize:vertical;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}fieldset{display:grid;gap:12px;border:1px solid var(--border)}p{font-size:12px;color:var(--fg-secondary)}button{padding:10px 18px;border:0;border-radius:6px;background:var(--accent);color:var(--bg)}
</style>
