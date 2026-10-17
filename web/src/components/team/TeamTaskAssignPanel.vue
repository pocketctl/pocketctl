<template>
 <ActionList :width="560" prefer-above mobile-sheet title="分派任务" @close="emit('close')">
  <form id="team-assign-task" class="task-form" @submit.prevent="submit">
   <label>任务说明（必填）<textarea v-model="instruction" required maxlength="32000" rows="5" placeholder="说明目标、范围和约束" /></label>
   <label>交付与验收（必填）<textarea v-model="acceptance" required maxlength="16000" rows="3" placeholder="例如：提交修改文件，并说明验证命令和结果" /></label>
   <fieldset class="task-agents" aria-describedby="task-agent-hint">
    <legend><span class="task-agent-heading"><span>执行 Agent</span><span class="task-agent-count" aria-live="polite">已选 {{ targets.length }}</span></span></legend>
    <p id="task-agent-hint" class="task-agent-hint">选择本次任务的执行 Agent，可多选。</p>
    <div v-if="session.agent_bindings.length" class="task-agent-list">
     <label v-for="binding in session.agent_bindings" :key="binding.id" class="task-agent-option" :class="{ selected:targets.includes(binding.offer_id), unavailable:binding.availability!=='online' }">
      <input v-model="targets" type="checkbox" :value="binding.offer_id" :disabled="binding.availability!=='online'" />
      <span class="task-agent-copy"><AgentBadge :agent="binding.provider" size="md" /><small>主机 · {{ binding.daemon_id }}</small></span>
      <span class="task-agent-status" :class="{ online:binding.availability==='online' }"><i aria-hidden="true"></i>{{ teamAvailabilityLabel(binding.availability) }}</span>
     </label>
    </div>
    <div v-else class="task-agent-empty"><strong>此会话还没有 Agent</strong><span>先在“参与者与 Agent”中加入，再分派任务。</span></div>
   </fieldset>
   <p>本轮材料：Context v{{ session.current_context_version }}。派发后固定该版本和 Agent 配置。</p>
   <p v-if="error" role="alert">{{ error }}</p>
  </form>
  <template #footer><button type="submit" form="team-assign-task" :disabled="busy||!instruction.trim()||!acceptance.trim()||!targets.length">{{ busy?'正在派发…':'分派任务' }}</button></template>
 </ActionList>
</template>
<script setup lang="ts">
import {ref} from 'vue'
import ActionList from '../ActionList.vue'
import AgentBadge from '../AgentBadge.vue'
import {teamAvailabilityLabel} from '../../utils/teamLabels'
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
.task-agents{display:block;min-width:0;margin:0;padding:0;border:0}
.task-agents legend{width:100%;padding:0;margin-bottom:6px}
.task-agent-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;font-weight:600}
.task-agent-count{padding:2px 8px;border-radius:6px;background:var(--accent-muted);color:var(--accent);font-size:11px;font-weight:500;white-space:nowrap}
.task-agents .task-agent-hint{margin:0 0 10px;font-size:12px;color:var(--fg-secondary)}
.task-agent-list{display:grid;gap:8px}
.task-form .task-agent-option{display:flex;align-items:center;gap:12px;min-height:72px;box-sizing:border-box;margin:0;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer;transition:background .15s,border-color .15s}
.task-agent-option:hover:not(.unavailable){background:var(--surface-hover);border-color:var(--border-light)}
.task-agent-option.selected,.task-agent-option.selected:hover{border-color:var(--accent);background:var(--accent-muted)}
.task-agent-option:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.task-agent-option input{width:18px;height:18px;flex:none;margin:0;accent-color:var(--accent);cursor:inherit}
.task-agent-copy{display:flex;flex:1;min-width:0;flex-direction:column;align-items:flex-start;gap:6px}
.task-agent-copy small{font-size:12px;line-height:1.5;color:var(--fg-secondary);overflow-wrap:anywhere}
.task-agent-copy :deep(.agent-badge){max-width:100%;box-sizing:border-box;white-space:normal}
.task-agent-status{display:inline-flex;flex:none;align-items:center;gap:5px;font-size:11px;color:var(--fg-secondary);white-space:nowrap}
.task-agent-status i{width:6px;height:6px;flex:none;border-radius:50%;background:currentColor}
.task-agent-status.online{color:var(--success)}
.task-agent-option.unavailable{background:var(--bg);cursor:not-allowed}
.task-agent-option.unavailable .task-agent-copy{opacity:.65}
.task-agent-empty{display:grid;gap:5px;padding:16px;border:1px dashed var(--border-light);border-radius:10px;background:var(--bg);color:var(--fg-secondary);font-size:12px;line-height:1.6}
.task-agent-empty strong{color:var(--fg);font-weight:500}
@media(max-width:480px){.task-form .task-agent-option{gap:10px;padding:12px 10px}.task-agent-copy small{font-size:11px}}
</style>
