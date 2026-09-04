<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import type { MemoryGovernanceQueueEntry } from '../../types/memory'

defineProps<{
  entries: MemoryGovernanceQueueEntry[]
  loading: boolean
  error: string | null
}>()
const emit = defineEmits<{
  (e: 'decide', candidateId: string, decision: 'approve' | 'request_changes' | 'reject'): void
  (e: 'publish', candidateId: string, resolution: 'new' | 'parallel' | 'supersede'): void
}>()
const { t } = useLocale()
</script>

<template>
  <section class="memory-governance-queue" aria-live="polite">
    <p v-if="error" class="memory-governance-error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="memory-governance-muted">{{ t('memory.governance.queue.loading') }}</p>
    <p v-else-if="entries.length === 0" class="memory-governance-muted">
      {{ t('memory.governance.queue.empty') }}
    </p>
    <article v-for="entry in entries" :key="entry.candidate.candidate_id" class="memory-governance-item">
      <header class="memory-governance-item-header">
        <span class="memory-governance-state" :data-state="entry.candidate.state">{{ entry.candidate.state }}</span>
        <span class="memory-governance-revision">r{{ entry.current_revision?.revision_number ?? 1 }}</span>
        <span class="memory-governance-source">{{ entry.candidate.source_scope_kind }}</span>
        <time>{{ new Date(entry.candidate.expires_at).toLocaleDateString() }}</time>
      </header>
      <p class="memory-governance-statement">{{ entry.current_revision?.statement ?? entry.candidate.normalized_key }}</p>
      <p class="memory-governance-muted">
        {{ t('memory.governance.queue.decisions') }}: {{ entry.decisions.map(d => d.decision).join(', ') || '—' }}
      </p>
      <footer class="memory-governance-actions">
        <button type="button" @click="emit('decide', entry.candidate.candidate_id, 'approve')">
          {{ t('memory.governance.queue.approve') }}
        </button>
        <button type="button" @click="emit('decide', entry.candidate.candidate_id, 'request_changes')">
          {{ t('memory.governance.queue.requestChanges') }}
        </button>
        <button type="button" @click="emit('decide', entry.candidate.candidate_id, 'reject')">
          {{ t('memory.governance.queue.reject') }}
        </button>
        <button v-if="entry.candidate.state !== 'conflict'" type="button" class="memory-governance-publish" @click="emit('publish', entry.candidate.candidate_id, 'new')">
          {{ t('memory.governance.queue.publish') }}
        </button>
      </footer>
    </article>
  </section>
</template>
