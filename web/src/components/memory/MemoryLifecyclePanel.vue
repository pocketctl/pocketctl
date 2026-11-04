<template>
  <section class="memory-lifecycle" data-testid="memory-lifecycle-panel" :aria-busy="loading">
    <header><div><h3>{{ t('memory.lifecycle.title') }}</h3><p class="memory-muted">{{ t('memory.lifecycle.intro') }}</p></div>
      <button class="memory-button" :disabled="loading" @click="refresh">{{ t('memory.lifecycle.refresh') }}</button></header>
    <p v-if="loading" role="status">{{ t('memory.loading') }}</p>
    <p v-else-if="error" class="memory-notice is-error" role="alert">{{ t('memory.lifecycle.unavailable') }}</p>
    <template v-else-if="status">
      <p class="memory-notice">{{ t(status.mode === 'enabled' && status.personal ? 'memory.lifecycle.enabled_copy' : 'memory.lifecycle.legacy_copy') }}</p>
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
      <p v-if="!status.records.length" class="memory-muted" data-testid="lifecycle-empty">{{ t('memory.lifecycle.no_records') }}</p>
      <ol v-else class="memory-lifecycle-records">
        <li v-for="record in status.records" :key="record.bundle_id">
          <div><strong>{{ label(record.state) }}</strong><span>{{ new Date(record.updated_at).toLocaleString() }}</span></div>
          <p>{{ label(record.reason) }}<template v-if="record.run_state"> · {{ label(record.run_state) }} · {{ label(record.run_reason) }}</template></p>
          <p v-if="record.action">{{ t('memory.lifecycle.result') }}: {{ label(record.action) }} · {{ label(record.decision_state) }} · {{ label(record.decision_reason) }}</p>
        </li>
      </ol>
      <p v-if="status.has_more" class="memory-muted">{{ t('memory.lifecycle.latest_only') }}</p>
      <details v-if="status.personal && status.mode === 'enabled'" data-testid="lifecycle-legacy-review"><summary>{{ t('memory.lifecycle.legacy_review') }}</summary><slot /></details>
      <slot v-else />
    </template>
  </section>
</template>
<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue'
import {useLocale} from '../../composables/useLocale'
import {getMemoryLifecycleStatus,type MemoryLifecycleStatus} from '../../services/memoryClient'
const props=defineProps<{installationId:string}>()
const emit=defineEmits<{(event:'mode',mode:'off'|'shadow'|'enabled'|'unknown'):void}>()
const {t}=useLocale()
const status=ref<MemoryLifecycleStatus|null>(null),loading=ref(false),error=ref(false)
let epoch=0
const stages=computed(()=>status.value?[
  {key:'write',mode:status.value.mode},{key:'consume',mode:status.value.consume_mode},
  {key:'cold',mode:status.value.cold_mode},{key:'reclaim',mode:status.value.reclaim_mode},
]:[])
function label(value:string|null){const key=`memory.lifecycle.${value??'unknown'}`;const translated=t(key);return translated===key?t('memory.lifecycle.unknown'):translated}
async function refresh(){const request=++epoch;loading.value=true;error.value=false;status.value=null;emit('mode','unknown')
  try{const result=await getMemoryLifecycleStatus(props.installationId);if(request!==epoch)return;status.value=result;emit('mode',result.personal?result.mode:'off')}
  catch{if(request===epoch)error.value=true}finally{if(request===epoch)loading.value=false}}
watch(()=>props.installationId,refresh,{immediate:true})
onUnmounted(()=>{epoch++})
defineExpose({refresh})
</script>
<style scoped>
.memory-lifecycle{min-width:0}.memory-lifecycle header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.memory-lifecycle h3{margin:0}.memory-lifecycle header p{margin:8px 0 16px}.memory-lifecycle-stages{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}.memory-lifecycle-stages div{padding:12px;border:1px solid var(--border);border-radius:10px}.memory-lifecycle-stages dt{font-size:12px;color:var(--muted)}.memory-lifecycle-stages dd{margin:8px 0 0}.memory-lifecycle-counts{display:flex;gap:12px;flex-wrap:wrap}.memory-lifecycle-counts span{font-size:13px}.memory-lifecycle-records{list-style:none;padding:0}.memory-lifecycle-records li{border-bottom:1px solid var(--border);padding:14px 0;overflow-wrap:anywhere}.memory-lifecycle-records li div{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.memory-lifecycle-records p{font-size:13px;color:var(--muted);margin:8px 0}.memory-lifecycle summary{cursor:pointer;min-height:44px;padding:12px 0}.memory-lifecycle button{min-height:44px}
</style>
