<template>
 <ActionList :width="640" prefer-above mobile-sheet title="管理协作模板" @close="emit('close')">
  <button class="btn" :disabled="busy" @click="emit('close')">返回模板创建</button>
  <p>模板只定义角色、步骤和验收要求。创建任务时另行选择 Agent 与验收人；不会扩大权限或自动执行。</p>
  <p v-if="loading" role="status">读取模板目录与原保存记录…</p>
  <p v-if="notice" role="status">{{notice}}</p><p v-if="error" role="alert">{{error}}</p>
  <section v-if="pending && ready" aria-label="原模板保存">
   <p>保存结果尚未确认。原内容和版本已保留，请先核对。</p>
   <button class="btn" :disabled="busy||loading||!online||revoked" @click="resolve">查询原保存结果</button>
   <button v-if="missing && page?.can_manage && !retryConfirm" class="btn" :disabled="busy||!online" @click="retryConfirm=true">重试原保存</button>
   <div v-if="retryConfirm"><p>只重试原版本、原内容和原请求。不会覆盖其他人保存的新版本。</p><button class="btn" :disabled="busy||!online" @click="retry">确认重试原保存</button><button class="btn" :disabled="busy" @click="retryConfirm=false">取消重试</button></div>
  </section>
  <template v-if="page && !revoked">
   <p v-if="!page.can_manage">当前不能保存模板；仍可读取目录和查询本人原保存结果。</p>
   <section aria-label="模板目录"><button class="btn" :disabled="!canEdit" @click="create">新建模板</button>
    <p v-if="!page.items.length">此团队还没有协作模板。</p>
    <ul class="template-directory"><li v-for="item in page.items" :key="item.template_id"><button class="btn" :disabled="!canEdit" @click="edit(item.template_id,item.revision)">{{item.name}} · v{{item.revision}} · 编辑新版本</button></li></ul>
    <button v-if="page.next_cursor" class="btn" :disabled="locked" @click="load(true)">加载更多模板</button>
   </section>
   <form v-if="templateId && ready" @submit.prevent="prepare">
    <p>{{revision===0?'新模板 · 将保存 v1':`基于 v${revision} · 将另存 v${revision+1}`}}。旧版本和已有任务保持不变。</p>
    <fieldset :disabled="!canEdit||!!confirmation"><legend>名称、目标与验收</legend>
     <label>模板名称<input v-model="definition.name" maxlength="120" required></label>
     <label>默认任务说明<textarea v-model="definition.goal" maxlength="32000" rows="3" required /></label>
     <label>默认验收要求<textarea v-model="definition.acceptance" maxlength="16000" rows="3" required /></label>
    </fieldset>
    <fieldset :disabled="!canEdit||!!confirmation"><legend>协作角色</legend>
     <div v-for="(role,index) in definition.roles" :key="role.role_id" class="editor-card">
      <label>角色 {{index+1}} 名称<input v-model="role.label" maxlength="120" required></label>
      <label>角色 {{index+1}} 类型<ActionSelect><select v-model="role.kind" :disabled="!canEdit||!!confirmation"><option value="agent">执行 Agent</option><option value="reviewer">验收人</option></select></ActionSelect></label>
      <button type="button" class="btn" :disabled="definition.steps.some(s=>s.agent_role===role.role_id||s.reviewer_role===role.role_id)" @click="definition.roles=definition.roles.filter(r=>r.role_id!==role.role_id)">删除角色 {{index+1}}</button>
     </div>
     <p>被步骤使用的角色需先修改步骤关联，才能删除。</p><button type="button" class="btn" :disabled="definition.roles.length>=32" @click="addRole">添加角色</button>
    </fieldset>
    <fieldset :disabled="!canEdit||!!confirmation"><legend>步骤与依赖</legend>
     <details v-for="(step,index) in definition.steps" :key="step.step_id" open class="editor-card"><summary>步骤 {{index+1}} · {{step.title||'未命名'}}</summary>
      <label>步骤 {{index+1}} 名称<input v-model="step.title" maxlength="120" required></label>
      <label>步骤 {{index+1}} 工作说明<textarea v-model="step.instruction" maxlength="16000" rows="2" required /></label>
      <label>步骤 {{index+1}} 验收要求<textarea v-model="step.acceptance" maxlength="8000" rows="2" required /></label>
      <label><input type="checkbox" v-model="step.required">必需步骤</label>
      <label>步骤 {{index+1}} 执行角色<ActionSelect><select v-model="step.agent_role" :disabled="!canEdit||!!confirmation"><option value="">请选择角色</option><option v-for="role in definition.roles.filter(r=>r.kind==='agent')" :key="role.role_id" :value="role.role_id">{{role.label||'未命名角色'}}</option></select></ActionSelect></label>
      <label>步骤 {{index+1}} 验收角色<ActionSelect><select v-model="step.reviewer_role" :disabled="!canEdit||!!confirmation"><option value="">请选择角色</option><option v-for="role in definition.roles.filter(r=>r.kind==='reviewer')" :key="role.role_id" :value="role.role_id">{{role.label||'未命名角色'}}</option></select></ActionSelect></label>
      <fieldset><legend>前置步骤</legend><label v-for="other in definition.steps.filter(s=>s.step_id!==step.step_id)" :key="other.step_id"><input type="checkbox" :value="other.step_id" v-model="step.depends_on">{{other.title||'未命名步骤'}}</label></fieldset>
      <label>步骤 {{index+1}} 必需检查项（每行一项）<textarea :value="step.required_checks.join('\n')" @input="step.required_checks=($event.target as HTMLTextAreaElement).value.split('\n')" rows="2" /></label>
      <button type="button" class="btn" :disabled="definition.steps.some(s=>s.depends_on.includes(step.step_id))" @click="definition.steps=definition.steps.filter(s=>s.step_id!==step.step_id)">删除步骤 {{index+1}}</button>
     </details>
     <p>依赖不能形成循环；必需步骤不能依赖可选步骤。被引用的步骤需先解除依赖才能删除。</p><button type="button" class="btn" :disabled="definition.steps.length>=32" @click="addStep">添加步骤</button>
    </fieldset>
    <fieldset :disabled="!canEdit||!!confirmation"><legend>预算建议</legend>
     <label><input type="checkbox" :checked="!!definition.budget_suggestion" @change="toggleBudget(($event.target as HTMLInputElement).checked)">保存预算建议</label>
     <template v-if="definition.budget_suggestion"><label>建议调用上限<input type="number" v-model.number="definition.budget_suggestion.invocation_limit" :min="Math.max(1,definition.steps.length)" max="128"></label>
      <label>建议并发上限<input type="number" min="1" max="32" :value="definition.budget_suggestion.policy?.max_concurrent_calls" @input="budget('max_concurrent_calls',$event)"></label>
      <label>建议停止新派发时限（秒）<input type="number" min="1" max="604800" :value="definition.budget_suggestion.policy?.max_duration_seconds" @input="budget('max_duration_seconds',$event)"></label>
      <label>建议 Token 提醒<input type="number" min="1" max="1000000000000" :value="definition.budget_suggestion.policy?.token_warning_limit" @input="budget('token_warning_limit',$event)"></label></template>
     <p>仅供激活时参考，不自动设置执行预算。Token 提醒不是硬限制。</p>
    </fieldset>
    <p v-if="!canSave&&!pending">请填写名称、目标、验收与完整步骤，核对角色、依赖、必需检查及预算范围；最多 32 个角色/步骤、100 个版本。</p>
    <div v-if="confirmation" role="group" aria-label="确认保存模板"><p>确认保存 {{confirmation.input.definition.name}} v{{confirmation.input.expected_revision+1}}？会保留旧版本和已有任务。本次不创建任务或发起调用。</p><button type="button" class="btn" :disabled="!canSave" @click="save">确认保存新版本</button><button type="button" class="btn" :disabled="busy" @click="confirmation=null">取消保存</button></div>
    <button v-else type="submit" class="btn" :disabled="!canSave">保存模板新版本</button>
   </form>
  </template>
  <button v-if="!revoked" class="btn" :disabled="busy||loading||!online" @click="load()">重新读取模板目录</button>
 </ActionList>
</template>
<script setup lang="ts">
import ActionList from '../ActionList.vue'
import ActionSelect from '../ActionSelect.vue'
import {useTeamTemplateEditor} from '../../composables/useTeamTemplateEditor'
const props=defineProps<{teamId:string;currentUserId:number}>(),emit=defineEmits<{close:[]}>()
const {page,definition,templateId,revision,pending,confirmation,retryConfirm,missing,loading,busy,ready,revoked,online,error,notice,locked,canEdit,canSave,load,create,edit,prepare,save,resolve,retry}=useTeamTemplateEditor(props)
function addRole(){definition.value.roles.push({role_id:`role_${crypto.randomUUID().replace(/-/g,'')}`,label:'',kind:'agent'})}
function addStep(){definition.value.steps.push({step_id:`step_${crypto.randomUUID().replace(/-/g,'')}`,title:'',instruction:'',acceptance:'',required:true,depends_on:[],agent_role:'',reviewer_role:'',required_checks:[]})}
function toggleBudget(value:boolean){if(value)definition.value.budget_suggestion={invocation_limit:Math.max(4,definition.value.steps.length)};else delete definition.value.budget_suggestion}
function budget(key:'max_concurrent_calls'|'max_duration_seconds'|'token_warning_limit',event:Event){const b=definition.value.budget_suggestion;if(!b)return;const raw=(event.target as HTMLInputElement).value;b.policy??={};if(raw==='')delete b.policy[key];else b.policy[key]=Number(raw)}
</script>
<style scoped>
.template-directory{list-style:none;padding:0;margin:0}form,fieldset,label{display:grid;gap:10px}fieldset{border:1px solid var(--border);border-radius:8px;padding:12px;margin:12px 0;min-width:0}.editor-card{border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:12px}label:has(input[type=checkbox]){display:flex;align-items:center}input:not([type=checkbox]),textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}textarea{resize:vertical}p{color:var(--fg-secondary);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}[role=alert]{color:var(--error)}.btn{margin:8px 8px 0 0}summary{cursor:pointer}select{max-width:100%}
</style>
