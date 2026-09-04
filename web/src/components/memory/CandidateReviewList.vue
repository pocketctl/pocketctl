<template>
  <section class="memory-review-workspace" data-testid="memory-review-list">
    <div v-if="loadError" class="memory-empty-state is-error" data-testid="memory-review-error">
      <span class="memory-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></svg></span>
      <strong>{{ t('memory.review_load_failed') }}</strong>
      <p>{{ loadError }}</p>
      <button type="button" class="memory-button" @click="refresh">{{ t('common.retry') }}</button>
    </div>

    <div v-else-if="candidates.length === 0" class="memory-empty-state" data-testid="memory-review-empty">
      <span class="memory-empty-icon is-success" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg></span>
      <strong>{{ t('memory.review_empty') }}</strong>
      <p>{{ t('memory.review_empty_copy') }}</p>
    </div>

    <div v-else class="memory-review-layout">
      <aside class="memory-review-queue">
        <div class="memory-review-filterbar">
          <label class="memory-review-filter-query">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>
            <input v-model="filterQuery" type="search" :placeholder="t('memory.filter_candidates')"
              data-testid="memory-review-filter-query" @input="applyFilters"/>
          </label>
          <label class="memory-review-filter-type">
            <select v-model="filterType" :aria-label="t('memory.filter_candidate_type')"
              data-testid="memory-review-filter-type" @change="applyFilters">
              <option value="all">{{ t('memory.all_types') }}</option>
              <option v-for="type in candidateTypes" :key="type" :value="type">{{ humanizeType(type) }}</option>
            </select>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
          </label>
        </div>
        <ul class="memory-candidate-list" data-testid="memory-review-items">
          <li v-for="candidate in pageCandidates" :key="candidate.candidate_id">
            <button type="button" class="memory-candidate-row"
              :class="{ selected: candidate.candidate_id === selectedCandidateId }"
              :aria-current="candidate.candidate_id === selectedCandidateId ? 'true' : undefined"
              :data-testid="`memory-candidate-row-${candidate.candidate_id}`"
              @click="selectCandidate(candidate.candidate_id)">
              <span class="memory-candidate-topline">
                <span class="memory-candidate-type">{{ humanizeType(candidate.claim_type) }}</span>
                <span v-if="candidate.status === 'conflict'" class="memory-candidate-status is-conflict"
                  :data-testid="`memory-candidate-status-${candidate.candidate_id}`">
                  {{ t('memory.status_conflict') }}
                </span>
                <span class="memory-candidate-confidence">{{ confidencePercent(candidate.confidence) }}</span>
              </span>
              <span class="memory-candidate-statement">{{ candidate.statement }}</span>
              <span class="memory-candidate-meta"><span>{{ candidate.repository_id || candidate.scope_key }}</span><span>{{ formatDate(candidate.created_at) }}</span></span>
            </button>
          </li>
          <li v-if="pageCandidates.length === 0" class="memory-review-filter-empty" data-testid="memory-review-filter-empty">
            {{ t('memory.no_filtered_candidates') }}
          </li>
        </ul>
        <nav v-if="totalPages > 1" class="memory-pagination" :aria-label="t('memory.review_pagination')">
          <button type="button" :aria-label="t('memory.previous_page')" data-testid="memory-review-previous-page"
            :disabled="currentPage === 1" @click="changePage(currentPage - 1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <span data-testid="memory-review-page-status"><strong>{{ currentPage }}</strong> / {{ totalPages }}</span>
          <button type="button" :aria-label="t('memory.next_page')" data-testid="memory-review-next-page"
            :disabled="currentPage === totalPages" @click="changePage(currentPage + 1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </nav>
      </aside>

      <article v-if="selectedCandidate" class="memory-review-detail"
        :data-testid="`memory-review-detail-${selectedCandidate.candidate_id}`">
        <header class="memory-review-detail-head">
          <div>
            <p class="memory-detail-overline">{{ t('memory.candidate') }} · {{ humanizeType(selectedCandidate.claim_type) }}</p>
            <h3 :data-testid="`memory-candidate-statement-${selectedCandidate.candidate_id}`">{{ selectedCandidate.statement }}</h3>
          </div>
          <div class="memory-confidence-ring" :style="{ '--memory-confidence': confidencePercent(selectedCandidate.confidence) }">
            <span>{{ confidencePercent(selectedCandidate.confidence) }}</span>
          </div>
        </header>

        <div class="memory-section-label"><span>{{ t('memory.scope_context') }}</span></div>
        <dl class="memory-fact-grid">
          <div><dt>{{ t('memory.scope') }}</dt><dd>{{ selectedCandidate.scope_kind }}</dd></div>
          <div><dt>{{ t('memory.repository') }}</dt><dd :data-testid="`memory-candidate-repository-${selectedCandidate.candidate_id}`">{{ selectedCandidate.repository_id || selectedCandidate.scope_key }}</dd></div>
          <div><dt>{{ t('memory.branch') }}</dt><dd>{{ selectedCandidate.branch || '—' }}</dd></div>
        </dl>

        <template v-if="structuredEntries.length">
          <div class="memory-section-label"><span>{{ t('memory.structured_fields') }}</span></div>
          <dl class="memory-structured-data" :data-testid="`memory-candidate-structured-${selectedCandidate.candidate_id}`">
            <template v-for="([key, value]) in structuredEntries" :key="key">
              <dt>{{ key }}</dt><dd>{{ formatStructuredValue(value) }}</dd>
            </template>
          </dl>
        </template>

        <div class="memory-section-label"><span>{{ t('memory.evidence_title') }}</span></div>
        <ul class="memory-evidence-thread" :data-testid="`memory-candidate-evidence-${selectedCandidate.candidate_id}`">
          <li v-for="item in selectedCandidate.evidence" :key="item.handle">
            <blockquote>{{ item.excerpt }}</blockquote>
            <footer><code>{{ item.handle }}</code><span>{{ t('memory.source_record') }}</span></footer>
          </li>
        </ul>

        <div v-if="editingId === selectedCandidate.candidate_id" class="memory-edit-panel">
          <label :for="`memory-edit-${selectedCandidate.candidate_id}`">{{ t('memory.correct_before_accept') }}</label>
          <textarea :id="`memory-edit-${selectedCandidate.candidate_id}`" v-model="editedStatement" rows="4"
            :data-testid="`memory-edit-${selectedCandidate.candidate_id}`"/>
        </div>

        <p v-if="errorFor(selectedCandidate.candidate_id)" class="memory-review-inline-error" role="alert"
          :data-testid="`memory-review-action-error-${selectedCandidate.candidate_id}`">
          {{ errorFor(selectedCandidate.candidate_id) }}
        </p>
        <div class="memory-review-actions">
          <button type="button" class="memory-button memory-review-action is-danger" :data-testid="`memory-reject-${selectedCandidate.candidate_id}`" @click="reject(selectedCandidate)">
            {{ t('memory.reject') }}
          </button>
          <button type="button" class="memory-button memory-review-action is-edit"
            :aria-pressed="editingId === selectedCandidate.candidate_id"
            :data-testid="`memory-edit-start-${selectedCandidate.candidate_id}`" @click="toggleEdit(selectedCandidate)">
            {{ t('memory.edit') }}
          </button>
          <button type="button" class="memory-button memory-review-action is-success" :data-testid="`memory-accept-${selectedCandidate.candidate_id}`"
            @click="accept(selectedCandidate, editingId === selectedCandidate.candidate_id)">
            {{ t('memory.accept_publish') }}
          </button>
        </div>
      </article>
      <div v-else class="memory-review-no-selection">
        <span>{{ t('memory.no_filtered_candidates') }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { acceptMemoryCandidate, listMemoryCandidates, MemoryClientError, rejectMemoryCandidate } from '../../services/memoryClient'
import type { MemoryCandidate } from '../../types/memory'

const { t } = useLocale()
const emit = defineEmits<{
  (e: 'changed'): void
  (e: 'count', value: number): void
  (e: 'accepted', claimId: string): void
}>()

const candidates = ref<MemoryCandidate[]>([])
const selectedCandidateId = ref<string | null>(null)
const loadError = ref('')
const editingId = ref<string | null>(null)
const editedStatement = ref('')
const errors = ref<Record<string, string>>({})
const currentPage = ref(1)
const filterQuery = ref('')
const filterType = ref('all')
const pageSize = 5

const selectedCandidate = computed(() => candidates.value.find(candidate => candidate.candidate_id === selectedCandidateId.value) ?? null)
const structuredEntries = computed(() => Object.entries(selectedCandidate.value?.structured_content ?? {}))
const candidateTypes = computed(() => [...new Set(candidates.value.map(candidate => candidate.claim_type))].sort())
const filteredCandidates = computed(() => {
  const query = filterQuery.value.trim().toLocaleLowerCase()
  return candidates.value.filter(candidate => {
    if (filterType.value !== 'all' && candidate.claim_type !== filterType.value) return false
    if (!query) return true
    return [
      candidate.statement,
      humanizeType(candidate.claim_type),
      candidate.scope_kind,
      candidate.scope_key,
      candidate.repository_id,
      candidate.branch,
    ].some(value => value?.toLocaleLowerCase().includes(query))
  })
})
const totalPages = computed(() => Math.max(1, Math.ceil(filteredCandidates.value.length / pageSize)))
const pageCandidates = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  return filteredCandidates.value.slice(start, start + pageSize)
})

async function refresh(): Promise<void> {
  loadError.value = ''
  try {
    const result = await listMemoryCandidates()
    candidates.value = result.candidates
    currentPage.value = Math.min(currentPage.value, totalPages.value)
    if (!pageCandidates.value.some(candidate => candidate.candidate_id === selectedCandidateId.value)) {
      selectedCandidateId.value = pageCandidates.value[0]?.candidate_id ?? null
    }
    emit('count', result.candidates.length)
  } catch (err) {
    candidates.value = []
    selectedCandidateId.value = null
    loadError.value = err instanceof Error ? err.message : t('memory.review_load_failed')
  }
}

onMounted(refresh)
defineExpose({ refresh })

function humanizeType(value: string): string { return value.replace(/_/g, ' ') }
function confidencePercent(value: string): string {
  const number = Number(value)
  return Number.isFinite(number) ? `${Math.round(number <= 1 ? number * 100 : number)}%` : value
}
function formatDate(value: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}
function formatStructuredValue(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '—')
}
function changePage(page: number): void {
  currentPage.value = Math.min(Math.max(page, 1), totalPages.value)
  selectedCandidateId.value = pageCandidates.value[0]?.candidate_id ?? null
  editingId.value = null
}
function applyFilters(): void {
  currentPage.value = 1
  selectedCandidateId.value = pageCandidates.value[0]?.candidate_id ?? null
  editingId.value = null
}
function selectCandidate(candidateId: string): void {
  selectedCandidateId.value = candidateId
  editingId.value = null
}
function errorFor(id: string): string { return errors.value[id] ?? '' }
function reviewActionError(error: unknown, fallback: string): string {
  if (error instanceof MemoryClientError && error.status === 409 && error.code === 'revision_conflict') {
    return t('memory.candidate_state_changed')
  }
  return error instanceof Error ? error.message : fallback
}
function toggleEdit(candidate: MemoryCandidate): void {
  if (editingId.value === candidate.candidate_id) {
    editingId.value = null
    return
  }
  editingId.value = candidate.candidate_id
  editedStatement.value = candidate.statement
}

async function accept(candidate: MemoryCandidate, edited: boolean): Promise<void> {
  errors.value[candidate.candidate_id] = ''
  try {
    const accepted = await acceptMemoryCandidate(candidate.candidate_id, Number(candidate.revision), edited ? editedStatement.value.trim() || candidate.statement : null, `web-accept-${candidate.candidate_id}-${Date.now()}`)
    emit('accepted', accepted.claim_id)
    editingId.value = null
    await refresh()
    emit('changed')
  } catch (err) {
    errors.value[candidate.candidate_id] = reviewActionError(err, t('memory.accept_failed'))
  }
}

async function reject(candidate: MemoryCandidate): Promise<void> {
  errors.value[candidate.candidate_id] = ''
  try {
    await rejectMemoryCandidate(candidate.candidate_id, Number(candidate.revision), null, `web-reject-${candidate.candidate_id}-${Date.now()}`)
    await refresh()
    emit('changed')
  } catch (err) {
    errors.value[candidate.candidate_id] = reviewActionError(err, t('memory.reject_failed'))
  }
}
</script>
