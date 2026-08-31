<template>
  <section class="memory-search-panel" data-testid="memory-search-panel">
    <div class="memory-search-workspace" data-testid="memory-search-workspace">
      <div class="memory-search-column">
        <div class="memory-search-hero">
          <form class="memory-search-box" @submit.prevent="runSearch">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>
            <input v-model="query" type="search" :placeholder="t('memory.search_placeholder')"
              data-testid="memory-search-input" :disabled="loading"/>
            <span class="memory-search-shortcut" aria-hidden="true">⌘ K</span>
            <button type="submit" class="memory-button is-primary" :disabled="loading || query.trim().length === 0"
              data-testid="memory-search-submit">
              <span v-if="loading" class="memory-button-spinner" aria-hidden="true"></span>
              <span class="memory-search-submit-label" data-testid="memory-search-submit-label">{{ loading ? t('memory.searching') : t('memory.search') }}</span>
            </button>
          </form>
          <div class="memory-quick-queries" :aria-label="t('memory.suggested_searches')">
            <button v-for="suggestion in suggestions" :key="suggestion" type="button" @click="useSuggestion(suggestion)">
              {{ suggestion }}
            </button>
          </div>
          <fieldset v-if="scopes.length" class="memory-federated-scopes">
            <legend>{{ t('memory.governance.scope.switcher') }}</legend>
            <label v-for="scope in scopes" :key="scope.installation_id">
              <input type="checkbox" :value="scope.installation_id" v-model="selectedScopeIds">
              <span>{{ scope.owner_scope_kind }} · {{ (scope.name || scope.owner_scope_id).slice(0, 20) }}</span>
            </label>
          </fieldset>
        </div>

        <div v-if="degraded" class="memory-notice is-warning" data-testid="memory-search-degraded">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19z"/><path d="M12 9v4M12 16h.01"/></svg>
          <span>{{ t('memory.degraded_embedding') }}</span>
        </div>
        <div v-else-if="error" class="memory-notice is-error" data-testid="memory-search-error">{{ error }}</div>
        <div v-else-if="!loading && searched && hits.length === 0" class="memory-empty-state" data-testid="memory-search-empty">
          <span class="memory-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4M8.5 11h5"/></svg></span>
          <strong>{{ t('memory.no_results') }}</strong>
          <p>{{ t('memory.no_results_copy') }}</p>
        </div>

        <template v-if="hits.length">
          <div class="memory-results-head">
            <span>{{ hits.length }} {{ t('memory.results') }}</span>
            <span>{{ t('memory.sorted_by_relevance') }}</span>
          </div>
          <ul class="memory-result-list" data-testid="memory-search-hits">
            <li v-for="hit in hits" :key="hit.versionId">
              <button type="button" class="memory-result-item" :class="{ selected: selectedHit?.claimId === hit.claimId }"
                :aria-current="selectedHit?.claimId === hit.claimId ? 'true' : undefined"
                :data-testid="`memory-hit-${hit.claimId}`" @click="selectPreview(hit, true)">
                <span class="memory-result-marker" aria-hidden="true"></span>
                <span class="memory-result-content">
                  <span class="memory-result-type">{{ humanizeType(hit.claimType) }}</span>
                  <span class="memory-result-statement">{{ hit.statement }}</span>
                  <span class="memory-result-meta" :data-testid="`memory-hit-scope-${hit.claimId}`">
                    <span>{{ hit.scopeKind }} · {{ hit.scopeKey }}<template v-if="hit.branch"> · {{ hit.branch }}</template></span>
                    <span v-if="hit.freshnessAt">{{ formatDate(hit.freshnessAt) }}</span>
                    <span>{{ hit.authority }}</span>
                    <span v-if="hit.ownerScopeKind">{{ hit.ownerScopeKind }} · {{ hit.ownerScopeId?.slice(0, 8) }}</span>
                    <span v-if="hit.conflictGroupId">conflict #{{ hit.conflictVariant ?? '—' }}</span>
                  </span>
                </span>
                <span v-if="Number.isFinite(hit.score)" class="memory-result-score">{{ hit.score.toFixed(2) }}</span>
              </button>
            </li>
          </ul>
        </template>
      </div>

      <aside class="memory-search-detail" :class="{ 'mobile-open': previewOpen }" data-testid="memory-search-detail">
        <div class="memory-search-detail-toolbar">
          <span>{{ t('memory.knowledge_detail') }}</span>
          <button type="button" class="memory-search-detail-close" :aria-label="t('memory.close_detail')" @click="previewOpen = false">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        </div>

        <div v-if="previewLoading" class="memory-search-preview-state">
          <span class="memory-spinner" aria-hidden="true"></span><strong>{{ t('memory.preview_loading') }}</strong>
        </div>
        <div v-else-if="previewError" class="memory-search-preview-state is-error" data-testid="memory-search-preview-error">
          <strong>{{ t('memory.preview_failed') }}</strong><p>{{ previewError }}</p>
        </div>
        <div v-else-if="selectedHit" class="memory-search-preview-body">
          <div class="memory-search-preview-chips">
            <span class="memory-chip is-active">{{ previewDetail?.claim.state || t('memory.active') }}</span>
            <span class="memory-chip">{{ humanizeType(selectedHit.claimType) }}</span>
            <span class="memory-chip is-violet">{{ selectedHit.authority }}</span>
          </div>
          <h3>{{ currentPreviewVersion?.statement || selectedHit.statement }}</h3>
          <dl class="memory-search-preview-facts">
            <div><dt>{{ t('memory.scope') }}</dt><dd>{{ selectedHit.scopeKind }} · {{ selectedHit.scopeKey }}</dd></div>
            <div><dt>{{ t('memory.current_version') }}</dt><dd>{{ currentPreviewVersion ? `v${currentPreviewVersion.version_number}` : '—' }}</dd></div>
            <div><dt>{{ t('memory.branch') }}</dt><dd>{{ selectedHit.branch || '—' }}</dd></div>
            <div><dt>{{ t('memory.authority') }}</dt><dd>{{ currentPreviewVersion?.authority || selectedHit.authority }}</dd></div>
          </dl>

          <div class="memory-section-label"><span>{{ t('memory.evidence_chain') }}</span></div>
          <ul v-if="previewEvidence.length" class="memory-evidence-thread memory-search-preview-evidence">
            <li v-for="item in previewEvidence" :key="item.evidence_id">
              <blockquote>{{ item.excerpt }}</blockquote>
              <footer><span>{{ item.evidence_kind }}</span><span>{{ formatDate(item.occurred_at) }}</span></footer>
            </li>
          </ul>
          <p v-else class="memory-search-preview-empty">{{ t('memory.evidence_empty') }}</p>

          <div class="memory-section-label"><span>{{ t('memory.version_history') }}</span></div>
          <ol class="memory-search-version-list">
            <li v-for="version in previewDetail?.versions || []" :key="version.version_id"
              :class="{ current: version.version_id === previewDetail?.claim.current_version_id }">
              <span></span><div><strong>v{{ version.version_number }} · {{ version.statement }}</strong><small>{{ formatDate(version.created_at) }} · {{ version.authority }}</small></div>
            </li>
          </ol>

          <div class="memory-search-preview-actions">
            <button type="button" class="memory-button is-primary" :data-testid="`memory-open-claim-${selectedHit.claimId}`" @click="openSelectedClaim">
              {{ t('memory.open_full_claim') }}
            </button>
          </div>
        </div>
        <div v-else class="memory-search-preview-state">
          <span class="memory-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></span>
          <strong>{{ t('memory.preview_empty_title') }}</strong>
          <p>{{ t('memory.preview_empty_copy') }}</p>
        </div>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { getMemoryClaim, listVersionEvidence, MemoryClientError, searchMemory } from '../../services/memoryClient'
import type {
  MemoryClaimDetail, MemoryEvidence, MemoryGovernanceScope, MemorySearchHit,
} from '../../types/memory'

const { t } = useLocale()
const props = withDefaults(defineProps<{ scopes?: MemoryGovernanceScope[] }>(), { scopes: () => [] })
const emit = defineEmits<{ (e: 'select-claim', claimId: string, hit: MemorySearchHit): void }>()

const query = ref('')
const hits = ref<MemorySearchHit[]>([])
const loading = ref(false)
const searched = ref(false)
const error = ref('')
const degraded = ref(false)
const selectedHit = ref<MemorySearchHit | null>(null)
const previewDetail = ref<MemoryClaimDetail | null>(null)
const previewEvidence = ref<MemoryEvidence[]>([])
const previewLoading = ref(false)
const previewError = ref('')
const previewOpen = ref(false)
const suggestions = ['Phase 2 Gate', 'Relay Extension', 'Local deployment']
const selectedScopeIds = ref<string[]>([])
let controller: AbortController | undefined
let previewRequestId = 0

const currentPreviewVersion = computed(() => {
  if (!previewDetail.value) return null
  return previewDetail.value.versions.find(version => version.version_id === previewDetail.value?.claim.current_version_id)
    ?? previewDetail.value.versions[0]
    ?? null
})

watch(() => props.scopes, scopes => {
  const allowed = new Set(scopes.map(scope => scope.installation_id))
  selectedScopeIds.value = selectedScopeIds.value.filter(id => allowed.has(id))
  if (selectedScopeIds.value.length === 0) {
    const personal = scopes.find(scope => scope.owner_scope_kind === 'personal')
    if (personal) selectedScopeIds.value = [personal.installation_id]
  }
}, { immediate: true, deep: true })

function humanizeType(value: string): string {
  return value.replace(/_/g, ' ')
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

function openSelectedClaim(): void {
  if (selectedHit.value) emit('select-claim', selectedHit.value.claimId, selectedHit.value)
}

function selectPreview(hit: MemorySearchHit, open: boolean): void {
  selectedHit.value = hit
  if (open) previewOpen.value = true
  void loadPreview(hit)
}

async function loadPreview(hit: MemorySearchHit): Promise<void> {
  const requestId = ++previewRequestId
  previewLoading.value = true
  previewError.value = ''
  previewDetail.value = null
  previewEvidence.value = []
  try {
    const detail = await getMemoryClaim(hit.claimId, null, hit.installationId)
    if (requestId !== previewRequestId) return
    previewDetail.value = detail
    const versionId = detail.claim.current_version_id ?? detail.versions[0]?.version_id
    if (versionId) {
      const evidence = await listVersionEvidence(versionId, hit.installationId)
      if (requestId !== previewRequestId) return
      previewEvidence.value = evidence
    }
  } catch (err) {
    if (requestId !== previewRequestId) return
    previewError.value = err instanceof Error ? err.message : t('memory.preview_failed')
  } finally {
    if (requestId === previewRequestId) previewLoading.value = false
  }
}

function useSuggestion(value: string): void {
  query.value = value
  void runSearch()
}

async function runSearch(): Promise<void> {
  const text = query.value.trim()
  if (!text) return
  controller?.abort()
  const requestController = new AbortController()
  controller = requestController
  loading.value = true
  error.value = ''
  degraded.value = false
  try {
    if (props.scopes.length > 0 && selectedScopeIds.value.length === 0) {
      throw new MemoryClientError(400, 'scope_required', 'select at least one scope')
    }
    const result = await searchMemory(text, {
      ...(props.scopes.length > 0
        ? { scopeInstallationIds: [...selectedScopeIds.value] }
        : {}),
    }, requestController.signal)
    if (controller !== requestController) return
    hits.value = result.hits
    degraded.value = result.degradedComponents.includes('embedding')
    previewOpen.value = false
    if (result.hits[0]) selectPreview(result.hits[0], false)
    else {
      previewRequestId += 1
      selectedHit.value = null
      previewDetail.value = null
      previewEvidence.value = []
      previewError.value = ''
      previewLoading.value = false
    }
  } catch (err) {
    if (controller !== requestController) return
    if (err instanceof MemoryClientError && err.code === 'superseded') return
    error.value = err instanceof Error ? err.message : t('memory.search_failed')
    hits.value = []
    previewRequestId += 1
    selectedHit.value = null
    previewDetail.value = null
    previewEvidence.value = []
    previewOpen.value = false
  } finally {
    if (controller !== requestController) return
    loading.value = false
    searched.value = true
  }
}
</script>
