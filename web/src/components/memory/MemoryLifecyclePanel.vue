<template>
  <section class="memory-lifecycle" data-testid="memory-lifecycle-panel" :aria-busy="loading">
    <header><div><h3>{{ t('memory.lifecycle.title') }}</h3><p class="memory-muted">{{ t('memory.lifecycle.intro') }}</p></div>
      <button class="memory-button" :disabled="loading" @click="refresh">{{ t('memory.lifecycle.refresh') }}</button></header>
    <p v-if="loading" role="status">{{ t('memory.loading') }}</p>
    <p v-else-if="error" class="memory-notice is-error" role="alert">{{ t('memory.lifecycle.unavailable') }}</p>
    <template v-else-if="status">
      <p class="memory-notice">{{ t(status.mode === 'enabled' && status.personal ? 'memory.lifecycle.enabled_copy' : 'memory.lifecycle.legacy_copy') }}</p>
      <p class="memory-muted" data-testid="lifecycle-mode-fences">{{ t('memory.ui.review.configuredMode') }}: {{ t(`memory.lifecycle.${status.configured_mode ?? 'unknown'}`) }} · {{ t('memory.ui.review.policyMode') }}: {{ t(`memory.lifecycle.${status.policy_mode ?? 'unknown'}`) }} · {{ t('memory.ui.context.revision') }} {{ status.revision ?? t('memory.lifecycle.unknown') }}</p>
      <dl class="memory-lifecycle-stages">
        <div v-for="stage in stages" :key="stage.key"><dt>{{ t(`memory.lifecycle.${stage.key}`) }}</dt><dd>{{ t(`memory.lifecycle.${stage.mode}`) }}</dd></div>
        <div><dt>{{ t('memory.lifecycle.oldest') }}</dt><dd>{{ status.oldest_pending_seconds === null ? '—' : `${Math.floor(status.oldest_pending_seconds / 60)} min` }}</dd></div>
      </dl>
      <p class="memory-muted">{{ t('memory.lifecycle.usage') }}: {{ status.usage.input_tokens }} / {{ status.usage.output_tokens }}</p>
      <details v-if="Object.values(status.assessments ?? {}).some(count=>count>0)" data-testid="lifecycle-assessments"><summary>{{ t('memory.lifecycle.assessments') }}</summary><p>{{ t('memory.lifecycle.usage') }}: {{ status.assessment_usage?.input_tokens ?? 0 }} / {{ status.assessment_usage?.output_tokens ?? 0 }}</p><ul><li v-for="(count,state) in status.assessments" :key="state">{{ label(String(state)) }} · {{ count }}</li></ul></details>
      <div class="memory-lifecycle-counts"><span v-for="key in ['pending','running','completed','deferred_semantic','blocked','failed','skipped_unresolved']" :key="key">{{ t(`memory.lifecycle.${key}`) }} <strong>{{ status.bundles[key] ?? 0 }}</strong></span></div>
      <details v-if="status.stage_jobs?.length" class="memory-lifecycle-jobs"><summary>{{ t('memory.lifecycle.stage_jobs') }}</summary><ul><li v-for="job in status.stage_jobs" :key="`${job.stage}:${job.state}`">{{ label(job.stage) }} · {{ label(job.state) }} · {{ job.count }}<template v-if="job.oldest_seconds !== null"> · {{ Math.floor(job.oldest_seconds / 60) }} min</template></li></ul></details>
      <details v-if="Object.keys(status.validation_rejections ?? {}).length"><summary>{{ t('memory.lifecycle.validation_rejections') }}</summary><ul><li v-for="(count,reason) in status.validation_rejections" :key="reason">{{ label(String(reason)) }} · {{ count }}</li></ul></details>
      <p v-if="status.receipts.provenance_unknown" class="memory-notice" data-testid="lifecycle-provenance-unknown">{{ t('memory.lifecycle.provenance_unknown') }}: {{ status.receipts.provenance_unknown }}</p>
      <p v-if="status.runs.provider_result_unknown" class="memory-notice is-error">{{ t('memory.lifecycle.provider_result_unknown') }}: {{ status.runs.provider_result_unknown }}</p>
      <p v-if="status.assessments?.provider_result_unknown" class="memory-notice is-error" data-testid="lifecycle-assessment-unknown">{{ t('memory.lifecycle.assessments') }} · {{ t('memory.lifecycle.provider_result_unknown') }}: {{ status.assessments.provider_result_unknown }}</p>
      <p v-if="!status.records.length" class="memory-muted" data-testid="lifecycle-empty">{{ t('memory.lifecycle.no_records') }}</p>
      <div v-else class="memory-lifecycle-workspace">
        <ol class="memory-lifecycle-records" :aria-label="t('memory.ui.review.processingRecords')">
          <li v-for="record in status.records" :key="record.bundle_id">
            <button type="button" :data-testid="`lifecycle-record-${record.bundle_id}`" :aria-current="selectedRecord?.bundle_id === record.bundle_id ? 'true' : undefined" @click="selectedRecordId = record.bundle_id">
              <strong>{{ label(record.state) }}</strong><span>{{ label(record.reason) }}</span><small>{{ new Date(record.updated_at).toLocaleString() }}</small>
            </button>
          </li>
        </ol>
        <article v-if="selectedRecord" class="memory-lifecycle-record-detail" data-testid="lifecycle-record-detail">
          <h4>{{ label(selectedRecord.state) }}</h4>
          <p>{{ label(selectedRecord.reason) }}</p>
          <p v-if="selectedRecord.run_state">{{ label(selectedRecord.run_state) }} · {{ label(selectedRecord.run_reason) }}</p>
          <p v-if="selectedRecord.action">{{ t('memory.lifecycle.result') }}: {{ label(selectedRecord.action) }} · {{ label(selectedRecord.decision_state) }} · {{ label(selectedRecord.decision_reason) }}</p>
          <p class="memory-muted">{{ t('memory.ui.review.machineDecision') }}</p>
          <dl><dt>{{ t('memory.ui.review.sourceBundle') }}</dt><dd><code>{{ selectedRecord.bundle_id }}</code></dd><template v-if="selectedRecord.run_mode"><dt>{{ t('memory.governance.automation.mode') }}</dt><dd>{{ selectedRecord.run_mode }}</dd></template></dl>
        </article>
      </div>
      <p v-if="status.has_more" class="memory-muted">{{ t('memory.lifecycle.latest_only') }}</p>
      <details v-if="showLegacy && status.personal && status.mode === 'enabled'" data-testid="lifecycle-legacy-review"><summary>{{ t('memory.lifecycle.legacy_review') }}</summary><slot /></details>
      <slot v-else-if="showLegacy" />
    </template>
  </section>
</template>
<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue'
import {useLocale} from '../../composables/useLocale'
import {getMemoryLifecycleStatus,type MemoryLifecycleStatus} from '../../services/memoryClient'
const props=withDefaults(defineProps<{installationId:string;showLegacy?:boolean}>(),{showLegacy:true})
const emit=defineEmits<{(event:'mode',mode:'off'|'shadow'|'enabled'|'unknown'):void}>()
const {t}=useLocale()
const status=ref<MemoryLifecycleStatus|null>(null),loading=ref(false),error=ref(false)
const selectedRecordId=ref<string|null>(null)
const selectedRecord=computed(()=>status.value?.records.find(record=>record.bundle_id===selectedRecordId.value)??status.value?.records[0]??null)
let epoch=0
const stages=computed(()=>status.value?[
  {key:'write',mode:status.value.mode},{key:'consume',mode:status.value.consume_mode},
  {key:'cold',mode:status.value.cold_mode},{key:'reclaim',mode:status.value.reclaim_mode},
]:[])
function label(value:string|null){const key=`memory.lifecycle.${value??'unknown'}`;const translated=t(key);return translated===key?t('memory.lifecycle.unknown'):translated}
async function refresh(){const request=++epoch;loading.value=true;error.value=false;status.value=null;selectedRecordId.value=null;emit('mode','unknown')
  try{const result=await getMemoryLifecycleStatus(props.installationId);if(request!==epoch)return;status.value=result;emit('mode',result.personal?result.mode:'off')}
  catch{if(request===epoch)error.value=true}finally{if(request===epoch)loading.value=false}}
watch(()=>props.installationId,refresh,{immediate:true})
onUnmounted(()=>{epoch++})
defineExpose({refresh})
</script>
<style scoped>
.memory-lifecycle{min-width:0}.memory-lifecycle header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.memory-lifecycle h3{margin:0}.memory-lifecycle header p{margin:8px 0 16px}.memory-lifecycle-stages{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}.memory-lifecycle-stages div{padding:12px;border:1px solid var(--border);border-radius:10px}.memory-lifecycle-stages dt{font-size:12px;color:var(--muted)}.memory-lifecycle-stages dd{margin:8px 0 0}.memory-lifecycle-counts{display:flex;gap:12px;flex-wrap:wrap}.memory-lifecycle-counts span{font-size:13px}.memory-lifecycle-records{list-style:none;padding:0}.memory-lifecycle-records li{border-bottom:1px solid var(--border);padding:14px 0;overflow-wrap:anywhere}.memory-lifecycle-records li div{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.memory-lifecycle-records p{font-size:13px;color:var(--muted);margin:8px 0}.memory-lifecycle summary{cursor:pointer;min-height:44px;padding:12px 0}.memory-lifecycle button{min-height:44px}
.memory-lifecycle-workspace{display:grid;grid-template-columns:minmax(190px,230px) minmax(0,1fr);gap:22px;margin-top:20px}.memory-lifecycle-records{margin:0;border-right:1px solid var(--border);padding-right:14px}.memory-lifecycle-records li{padding:0;border:0;margin-bottom:5px}.memory-lifecycle-records button{width:100%;display:grid;gap:6px;text-align:left;padding:12px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--fg);font:inherit;font-size:13px;cursor:pointer}.memory-lifecycle-records button[aria-current=true]{background:var(--accent-muted);border-color:var(--border)}.memory-lifecycle-records small{color:var(--muted)}.memory-lifecycle-record-detail{padding:4px 0;overflow-wrap:anywhere;font-size:13px}.memory-lifecycle-record-detail h4{font-size:17px;margin:4px 0 14px}.memory-lifecycle-record-detail dt{font-size:12px;color:var(--muted)}.memory-lifecycle-record-detail dd{margin:8px 0 16px}.memory-lifecycle-stages div{padding:10px;border-radius:8px}.memory-lifecycle-stages dd{font-size:13px}
@media(max-width:680px){.memory-lifecycle-workspace{grid-template-columns:minmax(0,1fr)}.memory-lifecycle-records{border-right:0;border-bottom:1px solid var(--border);padding:0 0 12px;max-height:260px;overflow:auto}}
</style>
