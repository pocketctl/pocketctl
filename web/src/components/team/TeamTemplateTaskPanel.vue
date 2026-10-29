<template>
 <TeamTemplateEditorPanel v-if="managementOpen" :team-id="props.session.team_id" :current-user-id="currentUserId??0" @close="managementOpen=false;load()" />
 <ActionList v-else :width="560" prefer-above mobile-sheet title="从模板创建" @close="emit('close')">
  <button type="button" :disabled="busy" @click="emit('back')">返回分派</button>
  <button v-if="list&&!revoked" type="button" :disabled="busy||loading||!!pending" @click="managementOpen=true">管理协作模板</button>
  <p v-if="loading" role="status">正在读取模板与会话设置…</p>
  <div v-if="pending" class="template-recovery" role="status">
   <p>创建结果尚未确认。原版本、角色绑定和请求已保留，请先查询原结果，避免重复创建。</p>
   <button type="button" :disabled="busy||loading||!online||revoked" @click="resolve">查询原创建结果</button>
   <button v-if="missing&&!confirmRetry" type="button" :disabled="busy||loading||!online" @click="confirmRetry=true">重试原创建</button>
   <div v-if="confirmRetry"><p>使用相同版本、角色绑定、材料和请求身份重试。</p><button type="button" :disabled="busy||loading||!online" @click="retry">确认重试原创建</button><button type="button" :disabled="busy" @click="confirmRetry=false">取消重试</button></div>
  </div>
  <form v-if="!revoked" class="template-form" @submit.prevent="confirm=true">
   <fieldset :disabled="locked||confirm">
    <legend>协作模板</legend>
    <label>模板<ActionSelect><select :disabled="locked||confirm" v-model="templateId" aria-label="协作模板" @change="revision=list?.items.find(t=>t.template_id===templateId)?.revision??1"><option value="">请选择模板</option><option v-for="t in list?.items" :key="t.template_id" :value="t.template_id">{{t.name}} · 最新 v{{t.revision}}</option></select></ActionSelect></label>
    <label>固定版本<ActionSelect><select :disabled="locked||confirm" v-model="revision" aria-label="模板版本"><option v-for="n in (list?.items.find(t=>t.template_id===templateId)?.revision??1)" :key="n" :value="n">v{{n}}</option></select></ActionSelect></label>
    <button type="button" :disabled="!templateId" @click="select">读取所选版本</button>
    <button v-if="list?.next_cursor" type="button" @click="load(true)">加载更多模板</button>
   </fieldset>
   <p v-if="list&&!list.items.length">此团队还没有协作模板。</p>
   <template v-if="selected">
    <p>{{selected.definition.name}} · 固定 v{{selected.revision}}。模板更新不会修改已有任务。</p>
    <fieldset :disabled="locked||confirm"><legend>角色绑定</legend>
     <label v-for="role in selected.definition.roles" :key="role.role_id">{{role.label}} · {{role.kind==='agent'?'执行 Agent':'验收人'}}
      <ActionSelect><select :disabled="locked||confirm" v-if="role.kind==='agent'" :value="roles[role.role_id]??''" @change="bindRole(role,$event)" :aria-label="role.label+' 执行 Agent'"><option value="">请选择在线 Agent</option><option v-for="b in bindings" :key="b.offer_id" :value="b.offer_id" :disabled="b.availability!=='online'">{{b.provider}} · {{b.daemon_id}} {{b.availability!=='online'?'（不可用）':''}}</option></select>
       <select :disabled="locked||confirm" v-else :value="roles[role.role_id]??''" @change="bindRole(role,$event)" :aria-label="role.label+' 验收人'"><option value="">请选择验收人</option><option v-for="m in reviewers" :key="m.user_id" :value="m.user_id">{{m.display_label}} · 成员 {{m.user_id}}{{m.user_id===currentUserId?' · 我':''}}</option></select></ActionSelect>
     </label>
     <p>仅选择当前会话可用 Agent 和有权限的成员。执行权限审批仍由 Agent 所有者处理。</p>
    </fieldset>
    <fieldset :disabled="locked||confirm"><legend>目标与验收</legend><label>任务说明<textarea v-model="goal" aria-label="任务说明" rows="4" maxlength="32000" required /></label><label>验收要求<textarea v-model="acceptance" aria-label="验收要求" rows="3" maxlength="16000" required /></label></fieldset>
    <details open><summary>步骤与依赖 · {{selected.definition.steps.length}} 步</summary><ol><li v-for="s in selected.definition.steps" :key="s.step_id"><strong>{{s.title}}</strong> · {{s.required?'必需':'可选'}}<p>{{s.instruction}}</p><p>验收：{{s.acceptance}}</p><p>执行：{{roleLabel(s.agent_role)}}；验收人：{{roleLabel(s.reviewer_role)}}</p><p>依赖：{{s.depends_on.map(stepLabel).join('、')||'无'}}；必需检查：{{s.required_checks.join('、')||'无'}}</p></li></ol></details>
    <details v-if="selected.definition.budget_suggestion"><summary>预算建议</summary><p>调用上限 {{selected.definition.budget_suggestion.invocation_limit}}</p><p v-if="selected.definition.budget_suggestion.policy?.max_concurrent_calls">并发上限 {{selected.definition.budget_suggestion.policy.max_concurrent_calls}}</p><p v-if="selected.definition.budget_suggestion.policy?.max_duration_seconds">停止新派发时限 {{selected.definition.budget_suggestion.policy.max_duration_seconds}} 秒</p><p v-if="selected.definition.budget_suggestion.policy?.token_warning_limit">Token 提醒 {{selected.definition.budget_suggestion.policy.token_warning_limit}}，非硬限制</p><p>仅供激活时参考，本次不会设置执行预算。</p></details>
    <p>共享材料：Context v{{pending?.input.context_version??session?.current_context_version??'未知'}}。本次只保存草稿，执行需在计划页面另行激活。</p>
   </template>
   <div v-if="confirm" class="template-recovery" role="group" aria-label="确认创建草稿"><p>确认使用 {{selected?.definition.name}} v{{selected?.revision}} 和当前角色绑定创建草稿？只保存计划，不发起执行。</p><button type="button" :disabled="!!disabledReason" @click="submit">确认创建草稿</button><button type="button" :disabled="busy" @click="confirm=false">取消</button></div>
   <button v-else type="submit" :disabled="!!disabledReason">创建计划草稿</button>
  </form>
  <p v-if="disabledReason">{{disabledReason}}</p><p v-if="error" role="alert">{{error}}</p>
  <button v-if="!revoked" type="button" :disabled="busy||loading||!online" @click="load()">重新读取模板与会话</button>
 </ActionList>
</template>
<script setup lang="ts">
import {ref} from 'vue'
import TeamTemplateEditorPanel from './TeamTemplateEditorPanel.vue'
import ActionList from '../ActionList.vue'
import ActionSelect from '../ActionSelect.vue'
import {useTeamTemplateTask} from '../../composables/useTeamTemplateTask'
import type {TeamSession} from '../../types/team'
const managementOpen=ref(false)
const props=defineProps<{session:TeamSession;currentUserId?:number}>(),emit=defineEmits<{close:[];back:[];created:[task:string]}>()
const {list,selected,templateId,revision,goal,acceptance,roles,session,pending,busy,loading,online,revoked,error,missing,confirm,confirmRetry,bindings,reviewers,locked,disabledReason,load,select,setRole,submit,resolve,retry}=useTeamTemplateTask(props,task=>emit('created',task))
function bindRole(role:{role_id:string;kind:string},event:Event){const value=(event.target as HTMLSelectElement).value;setRole(role.role_id,role.kind==='reviewer'&&value?Number(value):value)}
const roleLabel=(id:string)=>selected.value?.definition.roles.find(r=>r.role_id===id)?.label??id
const stepLabel=(id:string)=>selected.value?.definition.steps.find(s=>s.step_id===id)?.title??id
</script>
<style scoped>
.template-form{display:grid;gap:16px;margin-top:16px}fieldset{display:grid;gap:12px;min-width:0;border:1px solid var(--border);border-radius:6px}label{display:grid;gap:8px}textarea{box-sizing:border-box;width:100%;resize:vertical;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}p{font-size:12px;color:var(--fg-secondary);overflow-wrap:anywhere;white-space:pre-wrap}button{padding:10px 18px;border:0;border-radius:6px;background:var(--accent);color:var(--bg)}button:disabled{opacity:.5;cursor:not-allowed}.template-recovery{padding:12px;border:1px solid var(--border);border-radius:10px}.template-recovery button{margin:4px 8px 4px 0}li{margin-block:12px;overflow-wrap:anywhere}summary{cursor:pointer}select{max-width:100%}
</style>
