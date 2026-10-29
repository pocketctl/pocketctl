<template>
 <section class="delivery-section" aria-label="独立验证报告">
  <h4>独立验证报告</h4><p>来源由 Relay 核验；CI 或独立 Review 不代替人工验收。</p>
  <p v-if="!reports.length">本版尚无独立验证报告。</p>
  <article v-for="report in reports" :key="report.evidence_id">
   <h5>{{ report.check_id }} · {{ resultLabel(report.result) }}</h5>
   <p>{{ report.connector_kind==='ci'?'受信 CI':'独立 Review' }} · {{ report.connector_id }}</p>
   <details><summary>来源与版本</summary><dl><dt>仓库</dt><dd>{{ report.repository }}</dd><dt>运行</dt><dd>{{ report.run_id }}</dd><dt>代码版本</dt><dd>{{ report.code_revision }}</dd><dt>验收规格</dt><dd>v{{ report.spec_revision }}</dd><dt>报告 SHA-256</dt><dd>{{ report.report_sha256 }}</dd><dt>签收时间</dt><dd>{{ report.received_at }}</dd></dl></details>
   <button class="btn" :disabled="!available || loading" @click="open(report)">查看验证报告</button>
  </article>
  <p v-if="error" role="alert">{{ error }}</p><p v-if="loading" role="status">正在校验报告…</p>
  <div v-if="preview!==null"><button class="btn" @click="clear">关闭报告</button><pre>{{ preview }}</pre></div>
 </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { TaskSubmission, TrustedDeliveryEvidence } from '../../types/teamDelivery'
import { readTrustedEvidence } from '../../services/teamDeliveryClient'
import { TeamApiError } from '../../services/teamClient'
import { getRelayOrigin } from '../../composables/useEnv'
const props=defineProps<{taskId:string;currentUserId:number;submission:TaskSubmission;evidence:TrustedDeliveryEvidence[];available:boolean}>()
const emit=defineEmits<{revoked:[]}>()
const reports=computed(()=>props.evidence.filter(e=>e.submission_id===props.submission.submission_id&&Number(e.spec_revision)===Number(props.submission.spec_revision)&&e.code_revision===props.submission.code_revision))
const preview=ref<string|null>(null),loading=ref(false),error=ref('');let generation=0
function clear(){generation++;preview.value=null;loading.value=false;error.value=''}
function resultLabel(v:string){return ({passed:'检查通过',failed:'检查失败',unverified:'未验证'} as Record<string,string>)[v]||'未知'}
async function open(report:TrustedDeliveryEvidence){if(!props.available||!reports.value.includes(report))return;clear();const g=generation;loading.value=true
 try{const result=await readTrustedEvidence(props.taskId,report);if(g===generation&&props.available)preview.value=result}
 catch(e){if(g!==generation)return;if(e instanceof TeamApiError&&([401,403].includes(e.status)||e.status===404&&e.code==='team_not_found')){clear();emit('revoked')}else error.value=e instanceof Error?e.message:'报告暂不可用。'}finally{if(g===generation)loading.value=false}}
watch([()=>props.taskId,()=>props.currentUserId,()=>getRelayOrigin(),()=>props.submission.submission_id,()=>JSON.stringify(reports.value),()=>props.available],clear)
onBeforeUnmount(clear)
</script>
<style scoped>
article{padding:12px 0;border-bottom:1px solid var(--border)}h4,h5{margin:8px 0}p,dt{color:var(--fg-secondary)}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto}summary{cursor:pointer}
</style>
