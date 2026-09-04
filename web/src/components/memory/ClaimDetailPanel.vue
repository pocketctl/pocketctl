<template>
  <section class="memory-claim-workspace" data-testid="memory-claim-detail">
    <div class="memory-claim-layout">
      <section class="memory-claims-column">
        <div class="memory-claim-filterbar">
          <label class="memory-claim-filter-query">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>
            <input v-model="claimQuery" type="search" :placeholder="t('memory.filter_claims')"
              data-testid="memory-claim-filter"/>
          </label>
          <button type="button" class="memory-claim-state-filter" aria-pressed="true" disabled>
            {{ t('memory.active_claims') }}
          </button>
        </div>
        <div class="memory-claim-table-head" data-testid="memory-claim-table-head">
          <span>{{ t('memory.claim_column_knowledge') }}</span><span>{{ t('memory.scope') }}</span><span>{{ t('memory.updated') }}</span>
        </div>
        <div class="memory-claim-rows">
          <button v-for="claim in pageClaims" :key="claim.claim_id" type="button"
            class="memory-claim-row" :class="{ selected: claim.claim_id === selectedClaimId }"
            :data-testid="`memory-claim-row-${claim.claim_id}`"
            :aria-current="claim.claim_id === selectedClaimId ? 'true' : undefined"
            @click="selectClaim(claim.claim_id, true)">
            <span class="memory-claim-row-main">
              <strong>{{ claim.statement }}</strong>
              <span>{{ humanizeType(claim.claim_type) }}</span>
            </span>
            <span class="memory-claim-row-scope">{{ claim.scope_key }}</span>
            <span class="memory-claim-row-updated">{{ summaryUpdatedAt(claim) }}</span>
          </button>
          <p v-if="listError" class="memory-notice is-error memory-claim-list-error"
            data-testid="memory-claim-list-error">{{ listError }}</p>
          <div v-else-if="listLoading && claims.length === 0" class="memory-claim-list-empty">
            <span class="memory-spinner" aria-hidden="true"></span>
            <strong>{{ t('memory.loading') }}</strong>
          </div>
          <div v-else-if="claims.length > 0 && filteredClaims.length === 0" class="memory-claim-filter-empty" data-testid="memory-claim-filter-empty">
            {{ t('memory.no_filtered_claims') }}
          </div>
          <div v-else-if="claims.length === 0" class="memory-claim-list-empty">
            <span class="memory-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></span>
            <strong>{{ t('memory.no_active_claims') }}</strong>
            <p>{{ t('memory.no_active_claims_copy') }}</p>
          </div>
        </div>
        <nav v-if="totalPages > 1" class="memory-pagination" :aria-label="t('memory.claim_pagination')">
          <button type="button" :aria-label="t('memory.previous_page')" data-testid="memory-claim-previous-page"
            :disabled="currentPage === 1 || listLoading" @click="changePage(currentPage - 1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <span data-testid="memory-claim-page-status"><strong>{{ currentPage }}</strong> / {{ totalPages }}</span>
          <button type="button" :aria-label="t('memory.next_page')" data-testid="memory-claim-next-page"
            :disabled="currentPage === totalPages || listLoading" @click="changePage(currentPage + 1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </nav>
      </section>

      <aside class="memory-claim-library-detail" :class="{ 'mobile-open': detailOpen }"
        data-testid="memory-claim-library-detail">
        <template v-if="detail">
          <div class="memory-claim-detail-toolbar">
            <span>{{ t('memory.knowledge_detail') }}</span>
            <button type="button" class="memory-claim-detail-close" :aria-label="t('memory.back_to_claims')"
              data-testid="memory-claim-detail-close" @click="closeDetail">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
            </button>
          </div>

          <div class="memory-claim-chips">
            <span class="memory-chip is-active" data-testid="memory-claim-state">{{ detail.claim.state }}</span>
            <span class="memory-chip">{{ humanizeType(detail.claim.claim_type) }}</span>
          </div>
          <h3 class="memory-claim-current" data-testid="memory-claim-current">{{ currentVersion?.statement }}</h3>
          <dl class="memory-claim-summary-facts">
            <div><dt>{{ t('memory.claim_id') }}</dt><dd>{{ detail.claim.claim_id }}</dd></div>
            <div><dt>{{ t('memory.current_version') }}</dt><dd>v{{ currentVersion?.version_number ?? '—' }}</dd></div>
            <div><dt>{{ t('memory.scope') }}</dt><dd data-testid="memory-claim-scope">{{ detail.claim.scope_kind }} · {{ detail.claim.scope_key }}</dd></div>
            <div><dt>{{ t('memory.freshness') }}</dt><dd>{{ claimUpdatedAt }}</dd></div>
          </dl>

          <div v-if="correcting" class="memory-edit-panel memory-correction-panel">
            <label for="memory-correct-statement">{{ t('memory.correct_claim_copy') }}</label>
            <textarea id="memory-correct-statement" v-model="correctedStatement" rows="4" data-testid="memory-correct-statement"/>
            <div><button type="button" class="memory-button" @click="correcting = false">{{ t('common.cancel') }}</button><button type="button" class="memory-button is-primary" data-testid="memory-correct-save" @click="correct">{{ t('common.save') }}</button></div>
          </div>

          <div class="memory-section-label"><span>{{ t('memory.version_history') }}</span></div>
          <ol class="memory-version-ledger" data-testid="memory-claim-versions">
            <li v-for="version in orderedVersions" :key="version.version_id" :class="{ current: version.version_id === detail.claim.current_version_id }">
              <span class="memory-version-node" aria-hidden="true"></span>
              <span class="memory-version-copy">
                <strong>v{{ version.version_number }}<template v-if="version.version_id === detail.claim.current_version_id"> · {{ t('memory.current') }}</template></strong>
                <span>{{ version.authority }} · {{ version.freshness_at ?? version.created_at ?? '—' }}</span>
              </span>
              <span v-if="version.version_id === detail.claim.current_version_id" class="memory-chip is-active">{{ t('memory.current') }}</span>
            </li>
          </ol>
          <button v-if="detail.next_version_cursor" type="button" class="memory-button memory-load-older" data-testid="memory-claim-load-older" @click="loadOlder">{{ t('memory.load_older_versions') }}</button>

          <EvidencePanel v-if="detail.claim.current_version_id"
            :version-id="detail.claim.current_version_id"
            :installation-id="props.installationId"/>
          <p v-if="error" class="memory-notice is-error" data-testid="memory-claim-error">{{ error }}</p>

          <div class="memory-claim-actions" data-testid="memory-claim-actions">
            <button type="button" class="memory-button is-primary" data-testid="memory-claim-propose"
              @click="prepareProposal">{{ t('memory.governance.promotion.title') }}</button>
            <button v-if="!isSharedDetail" type="button" class="memory-button" data-testid="memory-claim-correct" @click="correcting = !correcting">{{ t('memory.correct_create_version') }}</button>
            <button v-if="!isSharedDetail" type="button" class="memory-button" data-testid="memory-claim-revoke" @click="revoke">{{ t('memory.revoke') }}</button>
            <button v-if="!isSharedDetail" type="button" class="memory-button is-danger" data-testid="memory-claim-delete" @click="confirmDelete = true">{{ t('memory.permanent_delete') }}</button>
          </div>
        </template>

        <div v-else class="memory-claim-detail-empty">
          <span class="memory-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></span>
          <strong>{{ t('memory.select_claim') }}</strong>
          <p>{{ t('memory.select_claim_copy') }}</p>
          <p v-if="error" class="memory-notice is-error" data-testid="memory-claim-error">{{ error }}</p>
        </div>
      </aside>
    </div>

    <div v-if="confirmDelete" class="memory-modal-backdrop" data-testid="memory-delete-confirm" @click.self="confirmDelete = false">
      <section class="memory-modal" role="alertdialog" aria-modal="true" aria-labelledby="memory-delete-title">
        <header><span class="memory-modal-icon is-danger"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></svg></span><div><h3 id="memory-delete-title">{{ t('memory.delete') }}</h3><p>{{ t('memory.irreversible') }}</p></div></header>
        <div class="memory-modal-body"><p>{{ t('memory.delete_warning') }}</p></div>
        <footer><button type="button" class="memory-button" @click="confirmDelete = false">{{ t('common.cancel') }}</button><button type="button" class="memory-button is-danger" data-testid="memory-delete-confirm-yes" @click="erase">{{ t('common.confirm') }}</button></footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { correctMemoryClaim, deleteMemoryClaim, getMemoryClaim, listMemoryClaims, listVersionEvidence, revokeMemoryClaim } from '../../services/memoryClient'
import type { MemoryClaimDetail, MemoryClaimSummary, MemoryEvidence } from '../../types/memory'
import EvidencePanel from './EvidencePanel.vue'

const { t } = useLocale()
const props = withDefaults(defineProps<{
  claimId: string | null
  installationId?: string | null
}>(), { installationId: null })
const emit = defineEmits<{
  (e: 'changed'): void
  (e: 'propose', claim: MemoryClaimDetail, evidence: MemoryEvidence[], sourceInstallationId: string | null): void
}>()

const detail = ref<MemoryClaimDetail | null>(null)
const claims = ref<MemoryClaimSummary[]>([])
const selectedClaimId = ref<string | null>(null)
const nextCursor = ref<string | null>(null)
const totalCount = ref(0)
const listLoading = ref(false)
const listError = ref('')
const listInitialized = ref(false)
const correcting = ref(false)
const correctedStatement = ref('')
const confirmDelete = ref(false)
const error = ref('')
const claimQuery = ref('')
const detailOpen = ref(false)
const currentPage = ref(1)
const isSharedDetail = computed(() => props.installationId !== null)
const CLAIM_PAGE_SIZE = 5

const currentVersion = computed(() => detail.value?.versions.find(version => version.version_id === detail.value?.claim.current_version_id) ?? detail.value?.versions.at(-1) ?? null)
const orderedVersions = computed(() => [...(detail.value?.versions ?? [])].reverse())
const claimUpdatedAt = computed(() => currentVersion.value?.freshness_at ?? currentVersion.value?.created_at ?? '—')
const filteredClaims = computed(() => {
  const query = claimQuery.value.trim().toLocaleLowerCase()
  if (!query) return claims.value
  return claims.value.filter(claim => [
    claim.statement,
    humanizeType(claim.claim_type),
    claim.scope_kind,
    claim.scope_key,
  ].some(value => value.toLocaleLowerCase().includes(query)))
})
const totalPages = computed(() => {
  const count = claimQuery.value.trim() ? filteredClaims.value.length : totalCount.value
  return Math.max(1, Math.ceil(count / CLAIM_PAGE_SIZE))
})
const pageClaims = computed(() => {
  const start = (currentPage.value - 1) * CLAIM_PAGE_SIZE
  return filteredClaims.value.slice(start, start + CLAIM_PAGE_SIZE)
})

watch([() => props.claimId, () => props.installationId], ([requestedClaimId, installationId], previous) => {
  if (!previous || installationId !== previous[1]) {
    listInitialized.value = false
    claims.value = []
    nextCursor.value = null
    totalCount.value = 0
  }
  void synchronize(requestedClaimId)
}, { immediate: true })
watch(claimQuery, () => {
  currentPage.value = 1
  const first = pageClaims.value[0]
  if (first && !pageClaims.value.some(claim => claim.claim_id === selectedClaimId.value)) {
    void selectClaim(first.claim_id, false)
  }
})

function humanizeType(value: string): string { return value.replace(/_/g, ' ') }
function closeDetail(): void { detailOpen.value = false }
function summaryUpdatedAt(claim: MemoryClaimSummary): string {
  return claim.freshness_at ?? claim.version_created_at ?? claim.updated_at ?? '—'
}

async function synchronize(requestedClaimId: string | null): Promise<void> {
  if (!listInitialized.value) await loadInitialClaims()
  const target = requestedClaimId ?? claims.value[0]?.claim_id ?? null
  if (target) {
    const targetIndex = filteredClaims.value.findIndex(claim => claim.claim_id === target)
    if (targetIndex >= 0) currentPage.value = Math.floor(targetIndex / CLAIM_PAGE_SIZE) + 1
    await selectClaim(target, Boolean(requestedClaimId))
  }
}

async function loadInitialClaims(): Promise<void> {
  if (props.installationId) {
    claims.value = []
    nextCursor.value = null
    totalCount.value = 0
    listInitialized.value = true
    return
  }
  listLoading.value = true
  listError.value = ''
  try {
    const page = await listMemoryClaims()
    claims.value = page.claims
    nextCursor.value = page.next_cursor
    totalCount.value = page.total_count
    currentPage.value = 1
  } catch (err) {
    claims.value = []
    nextCursor.value = null
    totalCount.value = 0
    listError.value = err instanceof Error ? err.message : 'load failed'
  } finally {
    listLoading.value = false
    listInitialized.value = true
  }
}

async function loadMoreClaims(): Promise<boolean> {
  if (!nextCursor.value || listLoading.value) return false
  listLoading.value = true
  listError.value = ''
  try {
    const page = await listMemoryClaims(nextCursor.value)
    const known = new Set(claims.value.map(claim => claim.claim_id))
    claims.value = [...claims.value, ...page.claims.filter(claim => !known.has(claim.claim_id))]
    nextCursor.value = page.next_cursor
    totalCount.value = page.total_count
    return true
  } catch (err) {
    listError.value = err instanceof Error ? err.message : 'load failed'
    return false
  } finally {
    listLoading.value = false
  }
}

async function changePage(nextPage: number): Promise<void> {
  if (nextPage < 1 || nextPage > totalPages.value || nextPage === currentPage.value) return
  const targetStart = (nextPage - 1) * CLAIM_PAGE_SIZE
  if (!claimQuery.value.trim() && targetStart >= claims.value.length) {
    const loaded = await loadMoreClaims()
    if (!loaded || targetStart >= claims.value.length) return
  }
  currentPage.value = nextPage
  const first = pageClaims.value[0]
  if (first) await selectClaim(first.claim_id, false)
}

async function selectClaim(claimId: string, openOnMobile: boolean): Promise<void> {
  if (selectedClaimId.value === claimId && detail.value?.claim.claim_id === claimId) {
    if (openOnMobile) detailOpen.value = true
    return
  }
  selectedClaimId.value = claimId
  await loadDetail(claimId, openOnMobile)
}

async function loadDetail(claimId: string, openOnMobile: boolean): Promise<void> {
  error.value = ''
  confirmDelete.value = false
  correcting.value = false
  try {
    detail.value = props.installationId
      ? await getMemoryClaim(claimId, null, props.installationId)
      : await getMemoryClaim(claimId)
    ensureSelectedSummary()
    correctedStatement.value = currentVersion.value?.statement ?? ''
    detailOpen.value = openOnMobile
  } catch (err) {
    detail.value = null
    detailOpen.value = false
    error.value = err instanceof Error ? err.message : 'load failed'
  }
}

function ensureSelectedSummary(): void {
  if (!detail.value || claims.value.some(claim => claim.claim_id === detail.value?.claim.claim_id)) return
  const version = currentVersion.value
  if (!version || detail.value.claim.state !== 'active' || !detail.value.claim.current_version_id) return
  claims.value = [{
    claim_id: detail.value.claim.claim_id,
    claim_type: detail.value.claim.claim_type,
    scope_kind: detail.value.claim.scope_kind,
    scope_key: detail.value.claim.scope_key,
    state: 'active',
    revision: detail.value.claim.revision,
    current_version_id: detail.value.claim.current_version_id,
    statement: version.statement,
    authority: version.authority,
    repository_id: version.repository_id,
    repo_snapshot_id: version.repo_snapshot_id,
    branch: version.branch,
    freshness_at: version.freshness_at,
    created_at: version.created_at,
    updated_at: version.freshness_at ?? version.created_at,
    version_created_at: version.created_at,
  }, ...claims.value]
}

async function refreshClaims(preferredClaimId: string | null): Promise<void> {
  listInitialized.value = false
  await loadInitialClaims()
  const target = preferredClaimId && claims.value.some(claim => claim.claim_id === preferredClaimId)
    ? preferredClaimId
    : claims.value[0]?.claim_id ?? null
  if (target) {
    const targetIndex = claims.value.findIndex(claim => claim.claim_id === target)
    currentPage.value = Math.floor(Math.max(0, targetIndex) / CLAIM_PAGE_SIZE) + 1
    selectedClaimId.value = target
    await loadDetail(target, false)
  }
  else {
    selectedClaimId.value = null
    detail.value = null
    detailOpen.value = false
  }
}

async function loadOlder(): Promise<void> {
  if (!detail.value?.next_version_cursor) return
  try {
    const older = await getMemoryClaim(
      detail.value.claim.claim_id,
      detail.value.next_version_cursor,
      props.installationId ?? undefined,
    )
    detail.value = { ...detail.value, versions: [...older.versions, ...detail.value.versions], next_version_cursor: older.next_version_cursor }
  } catch (err) { error.value = err instanceof Error ? err.message : 'load failed' }
}

async function correct(): Promise<void> {
  if (!detail.value) return
  try {
    const claimId = detail.value.claim.claim_id
    const currentEvidence = detail.value.claim.current_version_id ? await listVersionEvidence(detail.value.claim.current_version_id) : []
    await correctMemoryClaim(
      detail.value.claim.claim_id,
      Number(detail.value.claim.revision),
      correctedStatement.value.trim(),
      currentEvidence.map(item => ({ evidence_kind: item.evidence_kind as 'event' | 'artifact' | 'episode', episode_id: item.episode_id, source_event_id: item.source_event_id, artifact_id: item.artifact_id, locator: item.locator, excerpt: item.excerpt, occurred_at: item.occurred_at })),
      `web-correct-${claimId}-${Date.now()}`,
    )
    await refreshClaims(claimId)
    emit('changed')
  } catch (err) { error.value = err instanceof Error ? err.message : 'correct failed' }
}

async function prepareProposal(): Promise<void> {
  if (!detail.value?.claim.current_version_id) return
  try {
    const evidence = await listVersionEvidence(
      detail.value.claim.current_version_id,
      props.installationId ?? undefined,
    )
    emit('propose', detail.value, evidence, props.installationId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'proposal evidence unavailable'
  }
}

async function revoke(): Promise<void> {
  if (!detail.value) return
  try {
    await revokeMemoryClaim(detail.value.claim.claim_id, Number(detail.value.claim.revision), `web-revoke-${detail.value.claim.claim_id}-${Date.now()}`)
    await refreshClaims(null)
    emit('changed')
  } catch (err) { error.value = err instanceof Error ? err.message : 'revoke failed' }
}

async function erase(): Promise<void> {
  if (!detail.value) return
  try {
    await deleteMemoryClaim(detail.value.claim.claim_id, Number(detail.value.claim.revision), `web-delete-${detail.value.claim.claim_id}-${Date.now()}`)
    confirmDelete.value = false
    await refreshClaims(null)
    emit('changed')
  } catch (err) { error.value = err instanceof Error ? err.message : 'delete failed' }
}
</script>
