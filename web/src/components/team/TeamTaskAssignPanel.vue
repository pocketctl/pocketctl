<template>
 <TeamTemplateTaskPanel v-if="templateOpen" :session="props.session" :current-user-id="currentUserId" @close="emit('close')" @back="templateOpen=false;load()" @created="templateCreated" />
 <ActionList v-else :width="560" prefer-above mobile-sheet title="分派任务" @close="emit('close')">
  <button v-if="!revoked" type="button" :disabled="busy||loading||!!pending" @click="templateOpen=true">从协作模板创建草稿</button>
  <div v-if="pending" class="task-recovery" role="status">
   <p>分派结果尚未确认。原请求已保留，重新打开后先查询结果，避免重复创建任务。</p>
   <button type="button" :disabled="busy||loading||!online" @click="resolve">查询原分派结果</button>
   <button v-if="receiptMissing&&!confirmRetry" type="button" :disabled="busy||loading||!online" @click="confirmRetry=true">重试原分派</button>
   <div v-if="confirmRetry"><p>使用已保留的内容和同一请求身份重试，不创建新的请求。</p><button type="button" :disabled="busy||!online" @click="retry">确认重试原分派</button><button type="button" :disabled="busy" @click="confirmRetry=false">取消重试</button></div>
  </div>
  <p v-if="journalError" role="alert">{{ journalError }}</p>
  <p v-if="loading" role="status">正在读取分派设置…</p>
  <form v-if="!revoked" id="team-assign-task" class="task-form" @submit.prevent="submit">
   <label>任务说明（必填）<textarea v-model="instruction" :disabled="locked" required maxlength="32000" rows="5" placeholder="说明目标、范围和约束" /></label>
   <label>交付与验收（必填）<textarea v-model="acceptance" :disabled="locked" required maxlength="16000" rows="3" placeholder="例如：提交修改文件，并说明验证命令和结果" /></label>
   <fieldset class="task-agents" aria-describedby="task-agent-hint">
    <legend><span class="task-agent-heading"><span>执行 Agent</span><span class="task-agent-count" aria-live="polite">已选 {{ targets.length }}</span></span></legend>
    <p id="task-agent-hint" class="task-agent-hint">选择本次任务的执行 Agent，可多选。</p>
    <div v-if="bindings.length" class="task-agent-list">
     <label v-for="binding in bindings" :key="binding.id" class="task-agent-option" :class="{ selected:targets.includes(binding.offer_id), unavailable:binding.availability!=='online' }">
      <input v-model="targets" type="checkbox" :value="binding.offer_id" :disabled="locked || binding.availability!=='online'" />
      <span class="task-agent-copy"><AgentBadge :agent="binding.provider" size="md" /><small>主机 · {{ binding.daemon_id }}</small></span>
      <span class="task-agent-status" :class="{ online:binding.availability==='online' }"><i aria-hidden="true"></i>{{ teamAvailabilityLabel(binding.availability) }}</span>
     </label>
    </div>
    <div v-else class="task-agent-empty"><strong>此会话还没有 Agent</strong><span>先在“参与者与 Agent”中加入，再分派任务。</span></div>
   </fieldset>
   <fieldset v-if="deliveryEnabled||reviewRequired" class="task-review-settings"><legend>验收设置</legend>
    <label><input v-model="reviewRequired" type="checkbox" :disabled="locked" />需要人工验收</label>
    <template v-if="reviewRequired">
     <label>验收人<ActionSelect><select v-model="reviewer" aria-label="验收人" :disabled="locked"><option :value="0" disabled>请选择</option><option v-for="member in reviewers" :key="member.user_id" :value="member.user_id">{{ memberLabel(member) }}</option></select></ActionSelect></label>
     <label>主交付 Agent<ActionSelect><select v-model="primary" aria-label="主交付 Agent" :disabled="locked"><option v-for="binding in bindings.filter(b=>targets.includes(b.offer_id))" :key="binding.offer_id" :value="binding.offer_id">{{ binding.provider }} · {{ binding.daemon_id }}</option></select></ActionSelect></label>
     <label>必需检查项（每行一项）<textarea v-model="checks" rows="3" maxlength="3800" aria-label="必需检查项" :disabled="locked" placeholder="例如：单元测试、重连验证" /></label>
     <p>只有主交付进入人工验收。其他 Agent 的贡献不会覆盖主交付；执行权限审批仍由 Agent 所有者处理。</p>
    </template>
   </fieldset>
   <p>本轮材料：Context v{{ pending?.input.context_version ?? currentSession?.current_context_version ?? "未知" }}。派发后固定该版本和 Agent 配置。</p>
  </form>
  <p v-if="disabledReason">{{ disabledReason }}</p>
  <p v-if="error" role="alert">{{ error }}</p>
  <button v-if="!revoked" type="button" :disabled="busy||loading" @click="load">重新读取分派设置</button>
  <template #footer><button type="submit" form="team-assign-task" :disabled="!!disabledReason">{{ busy?'正在派发…':'分派任务' }}</button></template>
 </ActionList>
</template>
<script setup lang="ts">
import {ref} from 'vue'
import TeamTemplateTaskPanel from './TeamTemplateTaskPanel.vue'
import ActionSelect from '../ActionSelect.vue'
import ActionList from '../ActionList.vue'
import AgentBadge from '../AgentBadge.vue'
import {teamAvailabilityLabel} from '../../utils/teamLabels'
import {useTeamTaskAssignment} from '../../composables/useTeamTaskAssignment'
import type {TeamSession,TeamEvent,TeamMember} from '../../types/team'
const props=defineProps<{session:TeamSession;members?:TeamMember[];currentUserId?:number}>(),emit=defineEmits<{close:[];sent:[event:TeamEvent];assigned:[taskId:string]}>()
const {instruction,acceptance,targets,reviewRequired,reviewer,primary,checks,busy,loading,error,journalError,online,locked,revoked,pending,receiptMissing,confirmRetry,session:currentSession,bindings,reviewers,deliveryEnabled,disabledReason,load,submit,resolve,retry}=useTeamTaskAssignment(props,result=>{emit('sent',result.event);emit('assigned',result.task_id);emit('close')})
const templateOpen=ref(false)
function templateCreated(task:string){emit('assigned',task);emit('close')}
function memberLabel(member:TeamMember){if(member.user_id===props.currentUserId)return member.display_label+' · 我';return reviewers.value.filter(m=>m.display_label===member.display_label).length>1?member.display_label+' · 成员 '+member.user_id:member.display_label}
</script>
<style scoped>
.task-recovery{padding:12px;border:1px solid var(--border);border-radius:10px}.task-recovery button{margin:4px 8px 4px 0}.task-form{display:grid;gap:18px}.task-form>label{display:grid;gap:8px}textarea{width:100%;box-sizing:border-box;resize:vertical;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}fieldset{display:grid;gap:12px;border:1px solid var(--border)}p{font-size:12px;color:var(--fg-secondary)}button{padding:10px 18px;border:0;border-radius:6px;background:var(--accent);color:var(--bg)}
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
