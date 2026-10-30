<template>
 <section class="delivery-panel" aria-label="交付与验收">
  <p v-if="attemptId" class="delivery-notice">当前仅查看本次步骤尝试的交付；验收通过按依赖解锁后续步骤。</p>
  <div class="delivery-toolbar"><h3>交付与验收</h3><button class="btn" :disabled="loading || busy || operations.busy.value || managementBusy" @click="load">刷新</button></div>
  <p v-if="loading" role="status">正在读取交付…</p>
  <p v-if="error" class="delivery-error" role="alert">{{ error }}</p>
  <p v-if="!operations.ready.value && !operations.storageError.value && !operations.revoked.value" role="status">正在读取操作记录…</p>
  <p v-if="operations.error.value" role="alert">{{ operations.error.value }}</p>
  <p v-if="operations.storageError.value" role="alert">{{ operations.storageError.value }} <button class="btn" :disabled="operations.busy.value" @click="operations.refresh()">重新读取操作记录</button></p>
  <p v-if="legacy">此任务沿用原有完成流程，没有版本化交付或人工验收记录。</p>
  <div v-if="pending" class="delivery-notice" role="status">
   <p>验收结果尚未确认。请查询原操作，避免重复提交。</p>
   <button class="btn" :disabled="busy || operations.busy.value || !online || !operations.ready.value" @click="operations.resolve()">查询原操作</button>
   <button v-if="receiptMissing && !confirmRetry" class="btn" :disabled="busy || operations.busy.value || !online" @click="confirmRetry=true">重试原操作</button>
   <div v-if="confirmRetry"><p>确认使用原请求和原内容重试？不会创建新的操作标识。</p><button class="btn" :disabled="operations.busy.value" @click="operations.retry()">确认重试原操作</button><button class="btn" :disabled="operations.busy.value" @click="confirmRetry=false">取消重试</button></div>
  </div>
  <template v-if="delivery">
   <p v-if="!verified || !online" class="delivery-notice">当前为上次同步的只读内容。恢复连接并刷新后才能验收或执行；已缓存文件可离线查看。</p>
   <TeamTaskExecutionPanel v-if="!attemptId" :delivery="delivery" :current-user-id="currentUserId" :members="members" :locked="busy || operations.busy.value || !!pending" :verified="verified && online" @blocked="managementBusy=$event" @changed="emit('changed'); load()" @revoked="operations.revoke()" />
   <TeamTaskTemplateSource v-if="!attemptId && delivery.team_id" :team-id="delivery.team_id" :task-id="taskId" :current-user-id="currentUserId" :available="verified && online" :members="members" @revoked="operations.revoke()" />
   <div class="delivery-tabs" role="tablist" aria-label="任务交付内容">
    <button role="tab" :aria-selected="tab==='delivery'" @click="tab='delivery'">交付结果</button>
    <button role="tab" :aria-selected="tab==='history'" @click="tab='history'; loadHistory()">执行记录</button>
    <button v-if="!attemptId" role="tab" :aria-selected="tab==='steps'" @click="tab='steps'">执行步骤</button>
   </div>
   <TeamTaskSteps v-if="!attemptId && tab==='steps'" :task-id="taskId" :current-user-id="currentUserId" :available="verified && online" :members="members" @revoked="operations.revoke()" />
   <template v-if="tab==='delivery'">
    <label v-if="delivery.submissions.length" class="delivery-version">提交版本
     <ActionSelect><select v-model="selectedId" aria-label="提交版本" :disabled="busy">
      <option v-for="item in delivery.submissions.slice().reverse()" :key="item.submission_id" :value="item.submission_id">{{ item.state==='preparing'?'准备中':`v${item.version}` }} · {{ item.delivery_role==='primary'?'主交付':'贡献' }}{{ Number(item.spec_revision)!==Number(delivery.spec.revision)?' · 历史规格':item.submission_id===delivery.latest_submission_id?' · 当前':'' }}</option>
     </select></ActionSelect>
    </label>
    <p v-if="!selected" class="delivery-notice">尚无主交付结果。文件准备完成并发布后，才能进行验收。</p>
    <template v-if="selected">
     <section class="delivery-section"><h4>提交摘要</h4><p class="delivery-copy">{{ selected.summary }}</p><small>{{ memberName(selected.submitted_by_user_id) }} · {{ selected.state==='preparing'?'产物准备中':date(selected.published_at) }}</small>
      <p v-if="selected.decision_reason" class="delivery-notice">{{ selected.decision === 'changes_requested' ? '修改意见' : '验收说明' }}：{{ selected.decision_reason }}</p>
     </section>
     <section class="delivery-section"><h4>交付文件</h4>
      <button v-for="file in selected.manifest" :key="file.id" class="delivery-file" :disabled="busy || selected.revoked_artifact_ids.includes(file.id)" @click="openFile(file)">
       <span>{{ file.name }}<small>{{ Math.ceil(file.byte_size/1024) }} KB · {{ selected.revoked_artifact_ids.includes(file.id)?'已撤销':'只读快照' }}</small></span><span aria-hidden="true">›</span>
      </button>
     </section>
     <section v-if="preview" class="delivery-section" aria-label="文件预览">
      <div class="delivery-toolbar"><h4>{{ preview.name }}</h4><button class="btn" @click="clearPreview">关闭预览</button></div>
      <pre v-if="preview.text!==null">{{ preview.text }}</pre><p v-else>此文件以附件下载后查看。</p>
      <a :href="preview.url" :download="preview.name">下载已校验文件</a>
      <button v-if="selected.can_revoke_artifacts" class="btn" :disabled="!canRevoke" @click="revokeEditing=true">撤销附件</button>
      <div v-if="revokeEditing">
       <label>撤销原因（必填，最多 2000 字符）<textarea v-model="revokeReason" aria-label="撤销原因" maxlength="2000" :disabled="!canRevoke" @input="revokeConfirmation=null" /></label>
       <p>撤销后团队成员无法再预览或下载此附件，相关证据将不可用。历史记录保留，不会删除私有源文件；已下载的副本无法收回。</p>
       <button v-if="!revokeConfirmation" class="btn" :disabled="!canRevoke || !revokeReason.trim() || revokeReason.length>2000" @click="prepareRevoke">核对撤销</button>
       <template v-else><p>确认撤销 {{ preview.name }}？原因：{{ revokeReason }}</p><button class="btn" :disabled="!canRevoke" @click="submitRevoke">确认撤销附件</button><button class="btn" @click="revokeConfirmation=null">返回修改</button></template>
       <button class="btn" :disabled="operations.busy.value" @click="revokeEditing=false;revokeConfirmation=null">取消撤销</button>
      </div>
     </section>
     <section class="delivery-section"><h4>验证证据</h4><p>Agent 自述不等于验收通过，请核对对应文件和代码版本。</p>
      <ul class="delivery-evidence"><li v-for="check in selectedSpec?.required_checks || []" :key="check">
       <label><input v-if="canReview" v-model="verifiedChecks" type="checkbox" :value="check" :disabled="busy || operations.blocked.value || !checkAvailable(check)" />
        <span>{{ check }}<small>{{ evidenceLabel(check) }} · Agent 自述</small></span></label>
      </li></ul>
      <p v-if="!selectedSpec?.required_checks.length">此规格未指定独立检查项，仍需核对验收标准与必要文件。</p>
     </section>
     <TeamTrustedEvidence :task-id="taskId" :current-user-id="currentUserId" :submission="selected" :evidence="delivery.trusted_evidence || []" :available="verified && online" :members="members" @revoked="operations.revoke()" />
     <section class="delivery-section"><h4>验收标准 · 规格 v{{ selected.spec_revision }}</h4>
      <p class="delivery-copy">{{ selectedSpec?.acceptance || '规格暂不可用，请刷新后再核对。' }}</p>
      <p>验收人：{{ memberName(selectedSpec?.reviewer_user_id) }}</p>
     </section>
     <TeamDeliveryMemoryStatus :task-id="taskId" :team-id="delivery.team_id" :current-user-id="currentUserId" :available="verified && online" :submission="selected" />
     <details class="delivery-section"><summary>交付来源与版本</summary><dl>
      <dt>来源执行</dt><dd>{{ selected.source_call_id }}</dd><dt>代码版本</dt><dd>{{ selected.code_revision || '未提供' }}</dd>
      <dt>共享材料</dt><dd>Context v{{ selected.context_version }}</dd><dt>贡献版本</dt><dd>{{ selected.contribution_ids.length || '无' }}</dd>
     </dl></details>
     <p v-if="selected.state==='preparing'" class="delivery-notice">产物仍在准备，暂不能验收。</p>
     <p v-else-if="!current" class="delivery-notice">历史提交或贡献版本，只读查看。</p>
     <p v-else-if="selected.decision" class="delivery-notice">{{ selected.decision==='accepted'?'本版已验收通过。任务状态仍以任务列表为准。':'已要求修改，等待新的交付版本。' }}</p>
     <p v-else-if="!canReview" class="delivery-notice">由 {{ memberName(delivery.spec.reviewer_user_id) }} 负责验收。当前为只读状态。</p>
     <div v-if="canReview" class="delivery-review">
      <p v-if="!evidenceReady">必要证据尚不可用，暂不能通过；可以要求补充。</p>
      <template v-if="confirmAction">
       <h4>{{ confirmAction==='accepted'?'确认本版验收通过？':'要求修改' }}</h4>
       <label v-if="confirmAction==='changes_requested'">需要修改的内容<textarea v-model="reason" maxlength="8000" rows="4" aria-label="需要修改的内容" :disabled="busy" /></label>
       <p>决定只关联当前提交 v{{ selected.version }}，不会自动授予 Agent 执行权限。</p>
       <button class="btn" :disabled="busy" @click="confirmAction=null">取消</button>
       <button class="btn primary" :disabled="busy || operations.blocked.value || (confirmAction==='accepted'?!canAccept:!reason.trim())" @click="submitDecision">{{ busy?'正在提交…':'确认提交' }}</button>
      </template>
      <template v-else><button class="btn" :disabled="busy || operations.blocked.value" @click="confirmAction='changes_requested'">要求修改</button><button class="btn primary" :disabled="!canAccept" @click="confirmAction='accepted'">验收通过</button></template>
     </div>
    </template>
   </template>
   <section v-else-if="tab==='history'" class="delivery-section" aria-label="执行记录">
    <p>派发、接收、执行结束与产物保存分别记录。缺少原生开始事实时显示未知。</p>
    <p v-if="historyLoading">正在读取执行记录…</p>
    <article v-for="call in history" :key="call.call_id" class="delivery-execution">
     <h4>规格 v{{ call.spec_revision || '—' }} · {{ stateLabel(call.state) }}</h4>
     <p v-if="call.failure_code" class="delivery-notice">{{ deliveryFailureReason(call.failure_code) }}<br><small>诊断代码：{{ call.failure_code }}</small></p><dl>
      <dt>派发</dt><dd>{{ date(call.dispatched_at) }}</dd><dt>接收</dt><dd>{{ date(call.accepted_at) }}</dd>
      <dt>原生开始</dt><dd>{{ date(call.started_at) }}</dd><dt>执行结束</dt><dd>{{ date(call.finished_at) }}</dd>
     </dl><p v-if="call.export_status && !call.deliveries.length" class="delivery-notice" role="status"><strong>{{ exportPhase(call.export_status.phase) }}</strong><br>{{ exportReason(call.export_status.error_code) }}<small>状态更新 · {{ date(call.export_status.updated_at) }}</small></p>
     <TeamExternalRecovery v-if="call.provider==='agentteams'" :session-id="call.team_session_id" :call-id="call.call_id" :current-user-id="currentUserId" :available="verified && online && !operations.revoked.value" @revoked="operations.revoke()" />
     <p v-for="result in call.deliveries" :key="result.submission_id">交付 v{{ result.version }} · {{ date(result.published_at) }}</p>
    </article><p v-if="!historyLoading && !history.length">暂无执行记录。</p><p v-if="historyMore">显示最近 200 条执行记录。</p>
   </section>
  </template>
 </section>
</template>
<script setup lang="ts">
import '../../assets/team-delivery.css'
import { deliveryFailureReason } from '../../services/teamDeliveryDiagnostics'
import TeamExternalRecovery from './TeamExternalRecovery.vue'
import TeamDeliveryMemoryStatus from './TeamDeliveryMemoryStatus.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ActionSelect from '../ActionSelect.vue'
import TeamTaskExecutionPanel from './TeamTaskExecutionPanel.vue'
import TeamTaskSteps from './TeamTaskSteps.vue'
import TeamTaskTemplateSource from './TeamTaskTemplateSource.vue'
import { TeamApiError } from '../../services/teamClient'
import { getTaskDelivery, getDeliveryHistory, readDeliveryArtifact } from '../../services/teamDeliveryClient'
import { getRelayOrigin } from '../../composables/useEnv'
import { deliveryCacheScope, teamDeliveryCache } from '../../services/teamDeliveryCache'
import type { TeamMember } from '../../types/team'
import type { TaskDelivery, DeliveryArtifact, DeliveryDecision, DeliveryExecution } from '../../types/teamDelivery'
const props = withDefaults(defineProps<{ taskId: string; attemptId?:string; currentUserId: number; members?: TeamMember[] }>(), { members: () => [] })
import TeamTrustedEvidence from './TeamTrustedEvidence.vue'
import { useTeamDeliveryOperation } from '../../composables/useTeamDeliveryOperation'
const emit = defineEmits<{ changed: []; revoked: [] }>()
const delivery=ref<TaskDelivery|null>(null), selectedId=ref(''), loading=ref(false), busy=ref(false), error=ref(''), legacy=ref(false), verified=ref(false), online=ref(navigator.onLine)
const managementBusy=ref(false)
const tab=ref('delivery'), history=ref<DeliveryExecution[]>([]), historyLoading=ref(false), historyMore=ref(false)
function exportPhase(phase:string){return ({waiting_for_files:'等待交付文件',publication_pending:'交付发布待恢复',blocked:'交付需处理',published:'交付已保存'} as Record<string,string>)[phase]||'交付状态待核对'}
function exportReason(code:string|null){return ({manifest_unavailable:'尚未找到本次执行的交付清单，执行结束不代表文件已保存。',manifest_invalid:'交付清单或证据格式不符合要求，需要 Agent 修正。',artifact_too_large:'交付文件超过单文件上限 2 MiB（2,097,152 字节），未保存且不会截断。请减小文件或拆分为多个文件后重新执行。',artifact_unavailable:'交付文件缺失或不可读，请检查文件；旧版 Agent 的此错误也可能表示文件超限。',source_changed:'来源绑定或规格已变化，需要核对当前任务。',transport_unavailable:'连接暂不可用，恢复后会先查询原操作回执。',authorization_changed:'发布权限发生变化，需要核对当前成员和 Agent 权限。',revision_conflict:'交付版本已变化，正在核对原操作与当前版本。',quota_exceeded:'交付存储或文件配额已达到上限，需要处理后再继续。',retry_pending:'发布尚未完成，将保留原文件快照继续恢复。'} as Record<string,string>)[code||'']||'以当前交付文件和发布记录为准。'}
const verifiedChecks=ref<string[]>([]), reason=ref(''), confirmAction=ref<'accepted'|'changes_requested'|null>(null)
const revokeEditing=ref(false),revokeReason=ref(''),revokeConfirmation=ref<import('../../services/teamDeliveryRecovery').DeliveryPendingOperation|null>(null)
const canRevoke=computed(()=>!!preview.value&&selected.value?.can_revoke_artifacts===true&&!selected.value.revoked_artifact_ids.includes(preview.value.artifactId)&&verified.value&&online.value&&!loading.value&&!busy.value&&!managementBusy.value&&!operations.blocked.value)
function prepareRevoke(){if(!canRevoke.value||!selected.value||!preview.value||!delivery.value||!revokeReason.value.trim()||revokeReason.value.length>2000)return;revokeConfirmation.value={kind:'revoke_artifact',submissionId:selected.value.submission_id,artifactId:preview.value.artifactId,attemptId:props.attemptId,input:{request_id:crypto.randomUUID(),expected_revision:delivery.value.revision,reason:revokeReason.value.trim()}}}
async function submitRevoke(){const op=revokeConfirmation.value;if(!op||!canRevoke.value||op.input.expected_revision!==delivery.value?.revision)return;await operations.submit(op)}
const preview=ref<{ artifactId:string;name:string;url:string;text:string|null }|null>(null)
let generation=0, scope=0,ownFileInvalidation=false
let authorityTimer:ReturnType<typeof setInterval>|undefined, authorityReading=false, historyRead=0
const operations=useTeamDeliveryOperation(()=>props.taskId,()=>props.currentUserId,async()=>{confirmAction.value=null;reason.value='';await load();emit('changed');window.dispatchEvent(new Event('team-delivery-changed'))},()=>{generation++;loading.value=false;busy.value=false;historyLoading.value=false;delivery.value=null;verified.value=false;history.value=[];clearPreview();revokeCached();emit('revoked')})
const {receiptMissing,confirmRetry}=operations
const pending=computed(()=>operations.pending.value && ['acceptance','revoke_artifact'].includes(operations.pending.value.operation.kind)?operations.pending.value.operation.input:null)
const cacheId=()=>props.attemptId?JSON.stringify([props.taskId,props.attemptId]):props.taskId
const cacheScope=()=>deliveryCacheScope(props.currentUserId,getRelayOrigin())
function cacheResult(result:TaskDelivery){if(result.task_id!==props.taskId||(result.attempt_id||undefined)!==props.attemptId)throw Error('交付范围不匹配，请刷新。');delivery.value=result;if(!result.submissions.some(s=>s.submission_id===selectedId.value))selectedId.value=result.latest_submission_id||result.submissions.at(-1)?.submission_id||''}
function revokeCached(){void teamDeliveryCache.purge(cacheScope(),{task:props.taskId}).catch(()=>{})}
async function discardCachedFiles(g:number){
 if(g!==generation)return
 clearPreview();verified.value=false;ownFileInvalidation=true
 try{await teamDeliveryCache.purge(cacheScope(),{task:props.taskId,filesOnly:true})}catch{/* Keep the authoritative file error visible. */}finally{ownFileInvalidation=false}
}
function cacheRevoked(event:Event){const d=(event as CustomEvent).detail;if(d?.scope&&d.scope!==cacheScope())return;if(d?.task&&d.task!==props.taskId)return;if(d?.team&&d.team!==delivery.value?.team_id)return;if(d?.filesOnly){clearPreview();if(!ownFileInvalidation){generation++;verified.value=false;loading.value=false;historyLoading.value=false}return}generation++;verified.value=false;delivery.value=null;history.value=[];clearPreview();loading.value=false;historyLoading.value=false}
const selected=computed(()=>delivery.value?.submissions.find(s=>s.submission_id===selectedId.value))
const selectedSpec=computed(()=>delivery.value?.specs?.find(s=>Number(s.revision)===Number(selected.value?.spec_revision)))
const current=computed(()=>selected.value?.submission_id===delivery.value?.latest_submission_id && Number(selected.value?.spec_revision)===Number(delivery.value?.spec.revision))
const canReview=computed(()=>!operations.revoked.value && !managementBusy.value && !!delivery.value && verified.value && online.value && delivery.value.writes_enabled && ['open','in_progress'].includes(delivery.value.task_state)
 && current.value && selected.value?.state==='published' && !selected.value.decision && Number(delivery.value.spec.reviewer_user_id)===props.currentUserId)
function checkAvailable(id:string){const s=selected.value,e=s?.evidence.find(e=>e.check_id===id);return !!s&&!!e&&e.result!=='failed'&&s.manifest.some(a=>a.id===e.artifact_id)&&!s.revoked_artifact_ids.includes(e.artifact_id)}
const evidenceReady=computed(()=>!!selectedSpec.value && !!selected.value && selected.value.manifest.filter(a=>a.required).every(a=>!selected.value!.revoked_artifact_ids.includes(a.id)) && selectedSpec.value.required_checks.every(checkAvailable))
const canAccept=computed(()=>!operations.blocked.value && canReview.value && evidenceReady.value && !busy.value && !pending.value && selectedSpec.value!.required_checks.every(id=>verifiedChecks.value.includes(id)))
function memberName(id?:number){return props.members.find(m=>m.user_id===Number(id))?.display_label || (Number(id)===props.currentUserId?'我':id?`成员 ${id}`:'未知')}
function date(value:string|null){return value?new Date(value).toLocaleString():'未知'}
function stateLabel(value:string){return ({pending:'等待派发',dispatched:'已派发',accepted:'已接收',completed:'执行结束',failed:'失败',blocked:'阻塞',cancelled:'已取消',uncertain:'结果待核对'} as Record<string,string>)[value]||value}
function evidenceLabel(id:string){const e=selected.value?.evidence.find(e=>e.check_id===id);return !checkAvailable(id)?'证据缺失或不可用':selected.value?.decision==='accepted'?'已由验收人核对':e?.result==='passed'?'声明通过，待人工核对':'未验证，待人工核对'}
function clearPreview(){revokeEditing.value=false;revokeConfirmation.value=null;revokeReason.value='';if(preview.value)URL.revokeObjectURL(preview.value.url);preview.value=null}

function failure(e:unknown){error.value=e instanceof TeamApiError&&['artifact_unavailable','artifact_integrity'].includes(e.code)?'文件不可用，请刷新后重新读取。':e instanceof TeamApiError&&(e.status===0||e.status>=500)?'交付暂时无法刷新，请恢复连接后重试。':e instanceof Error?e.message:'读取失败，请重试';if(e instanceof TeamApiError && ([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')){operations.revoke()}}
async function load(){if(operations.busy.value||operations.revoked.value)return;void operations.refresh();const g=++generation,owner=cacheScope(),ticket=teamDeliveryCache.ticket();loading.value=true;verified.value=false;error.value='';legacy.value=false;verifiedChecks.value=[];confirmAction.value=null;historyLoading.value=false;clearPreview();try{
 if(!delivery.value){const saved=await teamDeliveryCache.read<TaskDelivery>(owner,'detail',cacheId()).catch(()=>null);if(g!==generation)return;if(saved&&saved.data.task_id===props.taskId&&(saved.data.attempt_id||undefined)===props.attemptId)cacheResult(saved.data)}
 const result=await getTaskDelivery(props.taskId,props.attemptId);if(g!==generation)return;cacheResult(result);verified.value=true
 // A newly observed file revocation invalidates every old byte snapshot of this task.
 const previous=await teamDeliveryCache.read<TaskDelivery>(owner,'detail',cacheId()).catch(()=>null)
 if(g!==generation)return
 if(result.submissions.some(s=>s.revoked_artifact_ids.some(id=>!previous?.data.submissions.find(old=>old.submission_id===s.submission_id)?.revoked_artifact_ids.includes(id)))){
  ownFileInvalidation=true;const cleanup=teamDeliveryCache.purge(owner,{task:props.taskId,filesOnly:true}),nextTicket=teamDeliveryCache.ticket();await cleanup.catch(()=>{});ownFileInvalidation=false;if(g!==generation)return
  void teamDeliveryCache.write(owner,'detail',cacheId(),result.team_id||'', [props.taskId],result,nextTicket).catch(()=>{})
 }else void teamDeliveryCache.write(owner,'detail',cacheId(),result.team_id||'',[props.taskId],result,ticket).catch(()=>{})
  if(tab.value==='history')await loadHistory()
 }catch(e){if(g!==generation)return;if(e instanceof TeamApiError&&e.code==='capability_not_supported'){legacy.value=true;delivery.value=null;revokeCached()}else failure(e)}finally{if(g===generation)loading.value=false}}
async function loadHistory(){const r=++historyRead,g=generation,owner=cacheScope(),ticket=teamDeliveryCache.ticket();historyLoading.value=true;try{
 const saved=await teamDeliveryCache.read<{executions:DeliveryExecution[];has_more:boolean}>(owner,'history',cacheId()).catch(()=>null);if(g!==generation||r!==historyRead)return;if(saved){history.value=saved.data.executions;historyMore.value=saved.data.has_more}
 const result=await getDeliveryHistory(props.taskId,props.attemptId);if(g!==generation||r!==historyRead)return;history.value=result.executions;historyMore.value=result.has_more;void teamDeliveryCache.write(owner,'history',cacheId(),delivery.value?.team_id||'',[props.taskId],result,ticket).catch(()=>{})
 }catch(e){if(g===generation&&r===historyRead)failure(e)}finally{if(g===generation&&r===historyRead)historyLoading.value=false}}
async function openFile(file:DeliveryArtifact){if(!selected.value||selected.value.revoked_artifact_ids.includes(file.id))return;const g=generation, owner=scope,cacheOwner=cacheScope(),ticket=teamDeliveryCache.ticket(),id=selected.value.submission_id,key=JSON.stringify(props.attemptId?[props.taskId,props.attemptId,id,file.id,file.sha256]:[props.taskId,id,file.id,file.sha256]);busy.value=true;error.value='';try{
 let blob:Blob
 try{if(!verified.value||!online.value)throw new TeamApiError(0,{error:{code:'offline',message:'离线'}});blob=await readDeliveryArtifact(props.taskId,id,file,props.attemptId);const bytes=await blob.arrayBuffer();if(g!==generation)return;void teamDeliveryCache.write(cacheOwner,'file',key,delivery.value?.team_id||'',[props.taskId],bytes,ticket).catch(()=>{})}
 catch(e){if(e instanceof TeamApiError&&['artifact_unavailable','artifact_integrity'].includes(e.code)){await discardCachedFiles(g);throw e}if(!(e instanceof TeamApiError&& (e.status===0||e.status>=500)))throw e
  const saved=await teamDeliveryCache.read<ArrayBuffer>(cacheOwner,'file',key).catch(()=>null);if(!saved)throw new Error('此文件尚未缓存，请恢复连接后读取。')
  const digest=await crypto.subtle.digest('SHA-256',saved.data),hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')
  if(saved.data.byteLength!==file.byte_size||hash!==file.sha256){await discardCachedFiles(g);throw new Error('缓存文件校验失败，请重新读取。')}
  blob=new Blob([saved.data]);error.value='正在查看已校验的离线文件快照。'
 }
 const text=file.mime_type.startsWith('text/')||file.mime_type==='application/json'?await blob.text():null
 if(g!==generation||selected.value?.submission_id!==id)return;clearPreview();preview.value={artifactId:file.id,name:file.name,url:URL.createObjectURL(blob),text}
 }catch(e){if(g===generation)failure(e)}finally{if(owner===scope)busy.value=false}}
async function submitDecision(){if(!canReview.value||!selected.value||!delivery.value||!confirmAction.value||operations.blocked.value||busy.value)return
 if(confirmAction.value==='accepted'&&!canAccept.value)return
 const input:DeliveryDecision={request_id:crypto.randomUUID(),expected_revision:delivery.value.revision,submission_id:selected.value.submission_id,spec_revision:Number(delivery.value.spec.revision),decision:confirmAction.value,reason:reason.value.trim(),verified_checks:confirmAction.value==='accepted'?[...verifiedChecks.value]:[]}
 await operations.submit({kind:'acceptance',input,...(props.attemptId?{attemptId:props.attemptId}:{})})
}


// Authorization reads must continue while a mutation awaits its original receipt.
// Do not replace the displayed snapshot or resolve/replay that mutation here.
async function checkAuthority(){
 if(authorityReading||!navigator.onLine||operations.revoked.value)return
 const g=generation,owner=cacheScope(),task=props.taskId,attempt=props.attemptId
 authorityReading=true
 try{await getTaskDelivery(task,attempt)}catch(e){if(g===generation&&owner===cacheScope())failure(e)}finally{authorityReading=false}
}
watch(canRevoke,allowed=>{if(!allowed)revokeConfirmation.value=null})
function connectivity(){online.value=navigator.onLine;verified.value=false;clearPreview();if(online.value)void load()}
watch([()=>props.taskId,()=>props.attemptId,()=>props.currentUserId,()=>getRelayOrigin()],()=>{generation++;scope++;tab.value='delivery';delivery.value=null;historyLoading.value=false;reason.value='';verifiedChecks.value=[];history.value=[];selectedId.value='';busy.value=false;confirmAction.value=null;clearPreview();void load()},{immediate:true})
watch(selectedId,()=>{verifiedChecks.value=[];confirmAction.value=null;clearPreview()})
onMounted(()=>{authorityTimer=setInterval(()=>void checkAuthority(),15000);window.addEventListener('focus',checkAuthority);window.addEventListener('team-delivery-cache-revoked',cacheRevoked);window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity)})
onBeforeUnmount(()=>{clearInterval(authorityTimer);window.removeEventListener('focus',checkAuthority);window.removeEventListener('team-delivery-cache-revoked',cacheRevoked);generation++;scope++;clearPreview();window.removeEventListener('online',connectivity);window.removeEventListener('offline',connectivity)})
</script>
<style scoped>
.delivery-panel{font-size:13px;line-height:1.7;color:var(--fg)}.delivery-toolbar,.delivery-version{display:flex;align-items:center;justify-content:space-between;gap:12px}.delivery-toolbar h3{margin:0}.delivery-tabs{display:flex;gap:16px;border-bottom:1px solid var(--border);margin:18px 0}.delivery-tabs button{padding:10px 0;border:0;border-bottom:2px solid transparent;background:none;color:var(--fg-secondary);cursor:pointer}.delivery-tabs button[aria-selected=true]{color:var(--accent);border-bottom-color:var(--accent)}.delivery-section{padding:18px 0;border-bottom:1px solid var(--border)}h4{margin:0 0 10px;font-size:13px;font-weight:600}p{color:var(--fg-secondary)}.delivery-copy{white-space:pre-wrap;overflow-wrap:anywhere}.delivery-file{display:flex;justify-content:space-between;align-items:center;width:100%;padding:13px 0;background:none;color:var(--fg);border:0;border-bottom:1px solid var(--border);text-align:left;cursor:pointer}.delivery-file span{min-width:0;overflow-wrap:anywhere}small{display:block;color:var(--fg-secondary);font-size:11px}.delivery-notice{padding:12px;border:1px solid var(--border);border-radius:7px;background:var(--surface)}.delivery-error{color:var(--error)}.delivery-evidence{list-style:none;padding:0}.delivery-evidence label{display:flex;gap:10px;align-items:flex-start;padding:8px 0}.delivery-evidence input{accent-color:var(--accent);margin-top:5px}.delivery-review{padding:18px 0}.delivery-review .btn{margin-right:8px}.delivery-review label{display:grid;gap:8px}textarea{width:100%;box-sizing:border-box;padding:10px;background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:6px;font:inherit}dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px}dt{color:var(--fg-secondary)}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;padding:12px;background:var(--surface);font-size:12px}a{color:var(--accent)}summary{cursor:pointer}.delivery-execution{padding:14px 0;border-bottom:1px solid var(--border)}button:disabled{opacity:.5;cursor:not-allowed}
</style>
