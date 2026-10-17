<template>
 <ActionList title="Agent 配置" :width="560" back @back="emit('close')" @close="emit('close')">
  <div class="agent-config">
   <p>{{ offer.provider }} · {{ offer.daemon_id }}</p>
   <p v-if="loading" role="status">正在读取主机能力…</p>
   <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">重试加载</button></p>
   <template v-if="capability">
    <label>配置来源<select v-model="mode"><option value="default">默认配置（创建时快照）</option><option value="custom">仅本会话自定义</option></select></label>
    <p>默认来源：{{ capability.default_source }}。仅影响该会话的独立 Agent，下次调用生效。</p>
    <label>模型<select v-model="runtime.model" :disabled="mode==='default'||!canModel" @change="normalizeEffort"><option v-for="m in capability.models" :key="m.id" :value="m.id">{{ m.id }}</option></select></label>
    <label>思考强度<select v-model="runtime.reasoning_effort" :disabled="mode==='default'||!canEffort||!efforts.length"><option :value="null">由模型决定</option><option v-for="effort in efforts" :key="effort" :value="effort">{{ effort }}</option></select></label>
    <label>权限<select v-model="runtime.permission_profile" :disabled="mode==='default'||!isOwner"><option v-for="p in capability.permission_profiles" :key="p" :value="p">{{ p }}</option></select></label>
    <p v-if="!isOwner">只有 Agent 所有者可修改权限边界；模型和强度须在预授权范围内。</p>
    <p v-if="bindingConfig">{{ ({unresolved:'待确认',pending:'下次调用生效',applied:'已应用',rejected:'应用被拒绝'})[bindingConfig.status] }} · 修订 {{ bindingConfig.config_revision }}</p>
    <p v-if="bindingConfig?.applied_config">最近实际应用：{{ bindingConfig.applied_config.model }} / {{ bindingConfig.applied_config.reasoning_effort || '默认强度' }} / {{ bindingConfig.applied_config.permission_profile }}（修订 {{ bindingConfig.applied_revision }}）</p>
    <button type="button" :disabled="mode==='default'" @click="mode='default';runtime={...snapshot!}">恢复创建时默认</button>
    <fieldset v-if="isOwner && session && capability.policy_revision" :disabled="busy"><legend>本团队的配置预授权</legend><p>适用于此 Agent 在本团队的所有会话。权限边界始终仅你可改。</p><label><input type="checkbox" v-model="delegateModel" />允许成员调整模型</label><label><input type="checkbox" v-model="delegateEffort" />允许成员调整思考强度</label><button type="button" :disabled="busy" @click="savePolicy">保存预授权</button><p v-if="policyNotice" role="status">{{ policyNotice }}</p></fieldset>
   </template>
  </div>
  <template #footer><button type="button" :disabled="busy||loading||!capability" @click="save">{{ busy?'正在保存…':session?'保存配置':'完成' }}</button></template>
 </ActionList>
</template>
<script setup lang="ts">
import {computed,onMounted,ref,watch} from 'vue'
import ActionList from '../ActionList.vue'
import {getTeamAgentCapabilities,saveTeamAgentConfig,saveTeamConfigPolicy} from '../../services/teamClient'
import type {TeamAgentOffer,TeamSessionAgentBinding,TeamSession,TeamRuntimeConfig,TeamAgentConfigCapabilities,SessionAgentConfig} from '../../types/team'
export interface TeamConfigDraft{mode:'default'|'custom';override:Partial<TeamRuntimeConfig>;capability_revision:string}
const props=defineProps<{teamID:string;offer:TeamAgentOffer|TeamSessionAgentBinding;session?:TeamSession;currentUserID:number;initial?:TeamConfigDraft}>()
const emit=defineEmits<{close:[];saved:[config:TeamConfigDraft]}>()
const capability=ref<TeamAgentConfigCapabilities|null>(null),bindingConfig=ref<SessionAgentConfig|null>('config' in props.offer?props.offer.config??null:null)
const mode=ref<'default'|'custom'>(props.initial?.mode??bindingConfig.value?.mode??'default')
const delegateModel=ref(false),delegateEffort=ref(false),policyNotice=ref('')
const runtime=ref<TeamRuntimeConfig>({model:'',reasoning_effort:null,permission_profile:''}),loading=ref(true),busy=ref(false),error=ref('')
const offerID=computed(()=> 'offer_id' in props.offer?props.offer.offer_id:props.offer.id)
const isOwner=computed(()=>props.currentUserID===props.offer.owner_user_id)
const canModel=computed(()=>isOwner.value||capability.value?.overridable_fields.includes('model'))
const canEffort=computed(()=>isOwner.value||capability.value?.overridable_fields.includes('reasoning_effort'))
const snapshot=computed(()=>bindingConfig.value?.default_snapshot??capability.value?.default_config)
const efforts=computed(()=>capability.value?.models.find(m=>m.id===runtime.value.model)?.reasoning_efforts??[])
function normalizeEffort(){if(runtime.value.reasoning_effort&&!efforts.value.includes(runtime.value.reasoning_effort))runtime.value.reasoning_effort=null}
watch(mode,m=>{if(m==='default'&&snapshot.value)runtime.value={...snapshot.value}})
async function load(){loading.value=true;error.value='';try{capability.value=await getTeamAgentCapabilities(props.session?.id??'',offerID.value,props.session?undefined:props.teamID);delegateModel.value=capability.value.overridable_fields.includes('model');delegateEffort.value=capability.value.overridable_fields.includes('reasoning_effort');runtime.value={...snapshot.value!,...(props.initial?.override??bindingConfig.value?.override??{})}}catch(e){error.value=e instanceof Error?e.message:'能力读取失败'}finally{loading.value=false}}
let policyKey='',policySignature=''
async function savePolicy(){if(!capability.value?.policy_revision||busy.value)return;const fields=[...(delegateModel.value?['model']:[]),...(delegateEffort.value?['reasoning_effort']:[])],signature=JSON.stringify([capability.value.policy_revision,fields]);if(signature!==policySignature){policySignature=signature;policyKey=crypto.randomUUID()};busy.value=true;try{const policy=await saveTeamConfigPolicy(props.teamID,offerID.value,capability.value.policy_revision,fields,policyKey);capability.value={...capability.value,...policy};policyNotice.value='预授权已保存'}catch(e){error.value=e instanceof Error?e.message:'预授权保存失败'}finally{busy.value=false}}
let saveKey='',saveSignature=''
async function save(){if(!capability.value||!snapshot.value||busy.value)return;busy.value=true;error.value='';try{
 const override:Partial<TeamRuntimeConfig>={}
 if(mode.value==='custom')for(const key of ['model','reasoning_effort','permission_profile'] as const){if(runtime.value[key]!==snapshot.value[key])Object.assign(override,{[key]:runtime.value[key]})}
 const draft:TeamConfigDraft={mode:mode.value,override,capability_revision:capability.value.revision}
 if(props.session){const signature=JSON.stringify(draft);if(saveSignature!==signature){saveSignature=signature;saveKey=crypto.randomUUID()};bindingConfig.value=await saveTeamAgentConfig(props.session.id,offerID.value,{...draft,request_id:saveKey,expected_config_revision:bindingConfig.value?.config_revision??1})}
 emit('saved',draft);emit('close')
 }catch(e){error.value=e instanceof Error?e.message:'配置保存失败'}finally{busy.value=false}}
onMounted(load)
</script>
<style scoped>
.agent-config{display:grid;gap:16px;padding:20px 24px;overflow-wrap:anywhere}.agent-config p{margin:0;color:var(--fg-secondary);font-size:12px;line-height:1.6}.agent-config label{display:grid;gap:8px;font-size:13px}.agent-config select{width:100%;min-height:36px;padding:8px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:6px}.agent-config button{justify-self:start}.agent-config fieldset{margin:0;min-width:0;padding:14px;border:1px solid var(--border);border-radius:8px;display:grid;gap:12px}.agent-config fieldset label{display:flex;align-items:center;gap:8px}.agent-config legend{font-size:13px;font-weight:600}button{min-height:36px;padding:8px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--accent)}button:disabled{opacity:.5}
</style>
