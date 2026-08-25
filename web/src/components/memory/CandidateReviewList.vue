<template>
  <section class="memory-panel" data-testid="memory-review-list">
    <header><strong>{{ t('memory.review_title') }}</strong></header>
    <p v-if="candidates.length === 0" class="empty" data-testid="memory-review-empty">{{ t('memory.review_empty') }}</p>
    <ul v-else class="candidate-list" data-testid="memory-review-items">
      <li v-for="candidate in candidates" :key="candidate.candidate_id" class="candidate">
        <span class="type">{{ candidate.claim_type }}</span>
        <p class="statement" :data-testid="`memory-candidate-statement-${candidate.candidate_id}`">{{ candidate.statement }}</p>
        <div v-if="Object.keys(candidate.structured_content || {}).length" class="structured" :data-testid="`memory-candidate-structured-${candidate.candidate_id}`">
          <span class="meta">{{ t('memory.structured_fields') }}</span>
          <pre>{{ JSON.stringify(candidate.structured_content, null, 2) }}</pre>
        </div>
        <p class="meta">{{ t('memory.confidence') }} {{ candidate.confidence }} · {{ t(`memory.status_${candidate.status}`) || candidate.status }}</p>
        <p class="meta">{{ candidate.scope_kind }} · {{ candidate.scope_key }}<template v-if="candidate.branch"> · {{ candidate.branch }}</template></p>
        <ul class="candidate-evidence" :data-testid="`memory-candidate-evidence-${candidate.candidate_id}`">
          <li v-for="item in candidate.evidence" :key="item.handle">
            <code>{{ item.handle }}</code> {{ item.excerpt }}
          </li>
        </ul>
        <div v-if="editingId === candidate.candidate_id" class="edit-row">
          <textarea v-model="editedStatement" rows="3" :data-testid="`memory-edit-${candidate.candidate_id}`" />
          <button type="button" data-testid="memory-edit-save" @click="accept(candidate, true)">{{ t('memory.accept_edited') }}</button>
          <button type="button" @click="editingId = null">{{ t('common.cancel') }}</button>
        </div>
        <div class="actions">
          <button type="button" :data-testid="`memory-accept-${candidate.candidate_id}`" @click="accept(candidate, false)">{{ t('memory.accept') }}</button>
          <button type="button" :data-testid="`memory-edit-start-${candidate.candidate_id}`" @click="startEdit(candidate)">{{ t('memory.edit') }}</button>
          <button type="button" :data-testid="`memory-reject-${candidate.candidate_id}`" @click="reject(candidate)">{{ t('memory.reject') }}</button>
        </div>
        <p v-if="errorFor(candidate.candidate_id)" class="error">{{ errorFor(candidate.candidate_id) }}</p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  acceptMemoryCandidate,
  listMemoryCandidates,
  rejectMemoryCandidate,
} from '../../services/memoryClient'
import type { MemoryCandidate } from '../../types/memory'

const { t } = useLocale()
const emit = defineEmits<{
  (e: 'changed'): void
}>()

const candidates = ref<MemoryCandidate[]>([])
const editingId = ref<string | null>(null)
const editedStatement = ref('')
const errors = ref<Record<string, string>>({})

async function refresh(): Promise<void> {
  try {
    const result = await listMemoryCandidates()
    candidates.value = result.candidates
  } catch {
    candidates.value = []
  }
}

onMounted(refresh)
defineExpose({ refresh })

function errorFor(id: string): string {
  return errors.value[id] ?? ''
}

function startEdit(candidate: MemoryCandidate): void {
  editingId.value = candidate.candidate_id
  editedStatement.value = candidate.statement
}

async function accept(candidate: MemoryCandidate, edited: boolean): Promise<void> {
  try {
    await acceptMemoryCandidate(
      candidate.candidate_id,
      Number(candidate.revision),
      edited ? editedStatement.value.trim() || candidate.statement : null,
      `web-accept-${candidate.candidate_id}-${Date.now()}`,
    )
    editingId.value = null
    await refresh()
    emit('changed')
  } catch (err) {
    errors.value[candidate.candidate_id] = err instanceof Error ? err.message : 'accept failed'
  }
}

async function reject(candidate: MemoryCandidate): Promise<void> {
  try {
    await rejectMemoryCandidate(
      candidate.candidate_id, Number(candidate.revision), null,
      `web-reject-${candidate.candidate_id}-${Date.now()}`,
    )
    await refresh()
    emit('changed')
  } catch (err) {
    errors.value[candidate.candidate_id] = err instanceof Error ? err.message : 'reject failed'
  }
}
</script>
