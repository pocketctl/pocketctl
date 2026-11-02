<template>
  <section class="memory-evidence-panel" data-testid="memory-evidence-panel">
    <div class="memory-section-label"><span>{{ t('memory.evidence_title') }}</span></div>
    <p class="memory-evidence-hint">{{ t('memory.evidence_hint') }}</p>
    <p v-if="loading" role="status" class="memory-inline-empty">{{ t('memory.loading') }}</p>
    <div v-else-if="error" class="memory-notice is-error" role="alert"><p>{{ t('memory.evidence_load_failed') }}</p><button type="button" class="memory-button" data-testid="memory-evidence-retry" @click="load">{{ t('common.retry') }}</button></div>
    <p v-else-if="rows.length === 0" class="memory-inline-empty">{{ t('memory.evidence_empty') }}</p>
    <ul v-else class="memory-evidence-thread">
      <li v-for="row in rows" :key="row.evidence_id" class="evidence"
        :data-testid="`memory-evidence-${row.evidence_id}`">
        <blockquote>{{ row.excerpt }}<em v-if="row.truncated">…</em></blockquote>
        <footer><span>{{ row.locator?.source_kind === 'manual_entry' ? t('memory.manual.source') : row.evidence_kind }}</span><span>{{ row.occurred_at }}</span></footer>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { listVersionEvidence } from '../../services/memoryClient'
import type { MemoryEvidence } from '../../types/memory'

const { t } = useLocale()
const props = withDefaults(defineProps<{
  versionId: string
  installationId?: string | null
}>(), { installationId: null })

const rows=ref<MemoryEvidence[]>([]),loading=ref(false),error=ref(false)
let generation=0
onUnmounted(()=>{generation++})
async function load(){
  const request=++generation,versionId=props.versionId,installationId=props.installationId
  rows.value=[];loading.value=true;error.value=false
  try{
    const result=await (installationId?listVersionEvidence(versionId,installationId):listVersionEvidence(versionId))
    if(request===generation)rows.value=result
  }catch{if(request===generation)error.value=true}
  finally{if(request===generation)loading.value=false}
}
watch([()=>props.versionId,()=>props.installationId],load,{immediate:true})
</script>
