<template>
  <section class="memory-evidence-panel" data-testid="memory-evidence-panel">
    <div class="memory-section-label"><span>{{ t('memory.evidence_title') }}</span></div>
    <p class="memory-evidence-hint">{{ t('memory.evidence_hint') }}</p>
    <p v-if="rows.length === 0" class="memory-inline-empty">{{ t('memory.evidence_empty') }}</p>
    <ul v-else class="memory-evidence-thread">
      <li v-for="row in rows" :key="row.evidence_id" class="evidence"
        :data-testid="`memory-evidence-${row.evidence_id}`">
        <blockquote>{{ row.excerpt }}<em v-if="row.truncated">…</em></blockquote>
        <footer><span>{{ row.evidence_kind }}</span><span>{{ row.occurred_at }}</span></footer>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { listVersionEvidence } from '../../services/memoryClient'
import type { MemoryEvidence } from '../../types/memory'

const { t } = useLocale()
const props = withDefaults(defineProps<{
  versionId: string
  installationId?: string | null
}>(), { installationId: null })

const rows = ref<MemoryEvidence[]>([])

watch([() => props.versionId, () => props.installationId], async ([versionId, installationId]) => {
  try {
    rows.value = installationId
      ? await listVersionEvidence(versionId, installationId)
      : await listVersionEvidence(versionId)
  } catch {
    rows.value = []
  }
}, { immediate: true })
</script>
