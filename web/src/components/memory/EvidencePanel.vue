<template>
  <section class="evidence-panel" data-testid="memory-evidence-panel">
    <header>
      <strong>{{ t('memory.evidence_title') }}</strong>
      <span class="hint">{{ t('memory.evidence_hint') }}</span>
    </header>
    <p v-if="rows.length === 0" class="empty">{{ t('memory.evidence_empty') }}</p>
    <ul v-else class="evidence-list">
      <li v-for="row in rows" :key="row.evidence_id" class="evidence"
        :data-testid="`memory-evidence-${row.evidence_id}`">
        <p class="excerpt">{{ row.excerpt }}<em v-if="row.truncated">…</em></p>
        <p class="meta">{{ row.evidence_kind }} · {{ row.occurred_at }}</p>
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
const props = defineProps<{ versionId: string }>()

const rows = ref<MemoryEvidence[]>([])

watch(() => props.versionId, async versionId => {
  try {
    rows.value = await listVersionEvidence(versionId)
  } catch {
    rows.value = []
  }
}, { immediate: true })
</script>

<style scoped>
.evidence-panel { border: 1px solid #2a2f3a; border-radius: 8px; padding: 0.75rem; margin-top: 0.75rem; }
.evidence-panel header { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; }
.evidence .excerpt { margin: 0.25rem 0 0; font-family: var(--font-mono, monospace); }
.evidence .meta { margin: 0 0 0.5rem; color: #8b93a7; font-size: 0.8rem; }
/* Evidence text is visually distinct from generated claim text. */
.excerpt { background: #141821; border-left: 3px solid #4a7dff; padding: 0.25rem 0.5rem; }
</style>
