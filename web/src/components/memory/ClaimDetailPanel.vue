<template>
  <section class="memory-claim-workspace" data-testid="memory-claim-detail">
    <div class="memory-claim-layout" :class="{ 'has-preview': detailOpen }">
      <section class="memory-claims-column">
        <div class="memory-claim-filterbar">
          <label class="memory-claim-filter-query">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>
            <input v-model="claimQuery" type="search" :placeholder="t('memory.filter_claims')"
              data-testid="memory-claim-filter" :disabled="operationBusy || operationUncertain"/>
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
            :data-testid="`memory-claim-row-${claim.claim_id}`" :disabled="operationBusy || operationUncertain"
            :aria-current="claim.claim_id === selectedClaimId ? 'true' : undefined"
            :aria-controls="detailPanelId" :aria-expanded="detailOpen && claim.claim_id === selectedClaimId"
            @click="selectClaim(claim.claim_id, true, $event)">
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
            :disabled="currentPage === 1 || listLoading || operationBusy || operationUncertain" @click="changePage(currentPage - 1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <span data-testid="memory-claim-page-status"><strong>{{ currentPage }}</strong> / {{ totalPages }}</span>
          <button type="button" :aria-label="t('memory.next_page')" data-testid="memory-claim-next-page"
            :disabled="currentPage === totalPages || listLoading || operationBusy || operationUncertain" @click="changePage(currentPage + 1)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </nav>
      </section>

      <aside ref="detailPanel" tabindex="-1" :id="detailPanelId" class="memory-claim-library-detail" :class="{ 'mobile-open': detailOpen }" :aria-hidden="!detailOpen"
        :aria-label="t('memory.knowledge_detail')" :aria-busy="detailLoading"
        data-testid="memory-claim-library-detail">
          <div v-if="detailOpen || detail" class="memory-claim-detail-toolbar">
            <span>{{ t('memory.knowledge_detail') }}</span>
            <button type="button" class="memory-claim-detail-close" :aria-label="t('memory.back_to_claims')"
              data-testid="memory-claim-detail-close" :disabled="operationBusy || operationUncertain" @click="closeDetail">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
            </button>
          </div>
        <div v-if="detailLoading" class="memory-claim-detail-empty" role="status">
          <span class="memory-spinner" aria-hidden="true"></span><strong>{{ t('memory.loading') }}</strong>
        </div>
        <template v-else-if="detail">
          <div class="memory-claim-chips">
            <span class="memory-chip is-active" data-testid="memory-claim-state">{{ detail.claim.state }}</span>
            <span class="memory-chip">{{ humanizeType(detail.claim.claim_type) }}</span>
          </div>
          <p v-if="isManualEntry" class="memory-muted" data-testid="memory-manual-source">{{ t('memory.manual.source') }}</p>
          <h3 class="memory-claim-current" data-testid="memory-claim-current">{{ currentVersion?.statement }}</h3>
          <dl class="memory-claim-summary-facts">
            <div><dt>{{ t('memory.claim_id') }}</dt><dd>{{ detail.claim.claim_id }}</dd></div>
            <div><dt>{{ t('memory.current_version') }}</dt><dd>v{{ currentVersion?.version_number ?? '—' }}</dd></div>
            <div><dt>{{ t('memory.scope') }}</dt><dd data-testid="memory-claim-scope">{{ detail.claim.scope_kind }} · {{ detail.claim.scope_key }}</dd></div>
            <div><dt>{{ t('memory.freshness') }}</dt><dd>{{ claimUpdatedAt }}</dd></div>
          </dl>

          <div v-if="correcting" class="memory-edit-panel memory-correction-panel">
            <label for="memory-correct-statement">{{ t(isManualEntry ? 'memory.manual.revision_hint' : 'memory.correct_claim_copy') }}</label>
            <textarea id="memory-correct-statement" v-model="correctedStatement" rows="4" maxlength="4000" :disabled="operationBusy || operationUncertain" data-testid="memory-correct-statement"/>
            <div><button type="button" class="memory-button" :disabled="operationBusy || operationUncertain" @click="correcting = false">{{ t('common.cancel') }}</button><button type="button" class="memory-button is-primary" data-testid="memory-correct-save" :disabled="operationBusy || refreshRequired || !correctedStatement.trim() || correctedStatement.trim().length > 4000 || (!operationUncertain && correctedStatement.trim() === currentVersion?.statement.trim())" @click="correct">{{ t('common.save') }}</button></div>
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
          <button v-if="detail.next_version_cursor" type="button" class="memory-button memory-load-older" data-testid="memory-claim-load-older" :disabled="olderLoading" @click="loadOlder">{{ t(olderLoading ? 'memory.loading' : 'memory.load_older_versions') }}</button><p v-if="olderError" class="memory-notice is-error" role="alert">{{ olderError }}</p>

          <EvidencePanel v-if="detail.claim.current_version_id"
            :version-id="detail.claim.current_version_id"
            :installation-id="props.installationId"/>
          <p v-if="error" class="memory-notice is-error" role="alert" data-testid="memory-claim-error">{{ error }}</p>

          <p v-if="operationUncertain" class="memory-notice">{{ t('memory.claim_operation_uncertain') }}</p>
          <button v-if="refreshRequired" type="button" class="memory-button" data-testid="memory-claim-refresh" :disabled="operationBusy" @click="refreshAfterMutation">{{ t('common.retry') }}</button>
          <div class="memory-claim-actions" data-testid="memory-claim-actions">
            <button type="button" class="memory-button is-primary" data-testid="memory-claim-propose"
              :disabled="operationBusy || operationUncertain || refreshRequired || proposalLoading || detail.claim.state !== 'active'" @click="prepareProposal">{{ t('memory.governance.promotion.title') }}</button>
            <button v-if="!isSharedDetail" type="button" class="memory-button" data-testid="memory-claim-correct" :disabled="operationBusy || operationUncertain || refreshRequired || detail.claim.state !== 'active'" @click="correcting = !correcting">{{ t('memory.correct_create_version') }}</button>
            <button v-if="!isSharedDetail" type="button" class="memory-button" data-testid="memory-claim-revoke" :disabled="operationBusy || refreshRequired || (operationUncertain && operationRequest?.kind !== 'revoke') || detail.claim.state !== 'active'" @click="revoke">{{ t('memory.revoke') }}</button>
            <button v-if="!isSharedDetail" type="button" class="memory-button is-danger" data-testid="memory-claim-delete" :disabled="operationBusy || refreshRequired || (operationUncertain && operationRequest?.kind !== 'delete') || detail.claim.state !== 'active'" @click="confirmDelete = true">{{ t('memory.permanent_delete') }}</button>
          </div>
        </template>

        <div v-else class="memory-claim-detail-empty">
          <span class="memory-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></span>
          <strong>{{ t('memory.select_claim') }}</strong>
          <p>{{ t('memory.select_claim_copy') }}</p>
          <p v-if="error" class="memory-notice is-error" data-testid="memory-claim-error">{{ error }}</p>
          <button v-if="error && selectedClaimId" type="button" class="memory-button" data-testid="memory-claim-detail-retry" @click="refreshRequired ? refreshAfterMutation() : selectClaim(selectedClaimId, true)">{{ t('common.retry') }}</button>
        </div>
      </aside>
    </div>

    <div v-if="confirmDelete" class="memory-modal-backdrop" data-testid="memory-delete-confirm" @click.self="!operationBusy && !operationUncertain && (confirmDelete = false)">
      <section class="memory-modal" role="alertdialog" aria-modal="true" aria-labelledby="memory-delete-title">
        <header><span class="memory-modal-icon is-danger"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></svg></span><div><h3 id="memory-delete-title">{{ t('memory.delete') }}</h3><p>{{ t('memory.irreversible') }}</p></div></header>
        <div class="memory-modal-body"><p>{{ t('memory.delete_warning') }}</p><p v-if="error" class="memory-notice is-error" role="alert">{{ error }}</p><p v-if="operationUncertain">{{ t('memory.claim_operation_uncertain') }}</p></div>
        <footer><button type="button" class="memory-button" :disabled="operationBusy || operationUncertain" @click="confirmDelete = false">{{ t('common.cancel') }}</button><button type="button" class="memory-button is-danger" data-testid="memory-delete-confirm-yes" :disabled="operationBusy" @click="erase">{{ t('common.confirm') }}</button></footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, computed, onUnmounted, ref, useId, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { MemoryClientError, reviseAcceptedMemoryClaim, reviseManualMemoryClaim, deleteMemoryClaim, getMemoryClaim, listMemoryClaims, listVersionEvidence, revokeMemoryClaim } from '../../services/memoryClient'
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
const detailLoading = ref(false)
const detailPanel=ref<HTMLElement>()
const olderLoading=ref(false),olderError=ref(''),proposalLoading=ref(false)
const operationBusy=ref(false),operationUncertain=ref(false),refreshRequired=ref(false)
type ClaimOperation={kind:'correct'|'revoke'|'delete';claimId:string;revision:number;statement:string;manual:boolean;key:string}
const operationRequest=ref<ClaimOperation>()
let operationEpoch=0,listRequest=0,refreshTarget:string|null=null,writeCommitted=false
const detailPanelId = useId()
let detailRequest = 0
onUnmounted(() => { detailRequest++; operationEpoch++; listRequest++ })
const currentPage = ref(1)
const isSharedDetail = computed(() => props.installationId !== null)
const CLAIM_PAGE_SIZE = 5

const currentVersion = computed(() => detail.value?.versions.find(version => version.version_id === detail.value?.claim.current_version_id) ?? detail.value?.versions.at(-1) ?? null)
const orderedVersions = computed(() => [...(detail.value?.versions ?? [])].sort((a,b)=>Number(b.version_number)-Number(a.version_number)))
const isManualEntry=computed(()=>{const source=currentVersion.value?.structured_content?.manual_entry;return !!source&&typeof source==='object'&&'source_kind' in source&&source.source_kind==='manual_entry'})
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
  detailRequest++; operationEpoch++; listRequest++
  operationBusy.value=false;operationUncertain.value=false;operationRequest.value=undefined;refreshRequired.value=false
  olderLoading.value=false;olderError.value='';proposalLoading.value=false
  detailLoading.value = false
  if (!previous || installationId !== previous[1]) {
    detail.value = null
    detailOpen.value = false
    selectedClaimId.value = null
    listInitialized.value = false
    listLoading.value = false
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
let detailTrigger: HTMLElement | null = null
function closeDetail(): void {
  if(operationBusy.value||operationUncertain.value)return
  detailOpen.value=false
  void nextTick(()=>{const target=detailTrigger?.isConnected?detailTrigger:detailPanel.value?.parentElement?.querySelector<HTMLElement>(`[data-testid="memory-claim-row-${selectedClaimId.value}"]`);target?.focus()})
}
async function revealDetail(){
  await nextTick();if(!detailOpen.value)return
  if(detailPanel.value?.parentElement && detailPanel.value.parentElement.clientWidth>0 && detailPanel.value.parentElement.clientWidth<=700)detailPanel.value.scrollIntoView?.({block:'start'})
  detailPanel.value?.focus({preventScroll:true})
}
function summaryUpdatedAt(claim: MemoryClaimSummary): string {
  const value = claim.freshness_at ?? claim.version_created_at ?? claim.updated_at
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

async function synchronize(requestedClaimId: string | null): Promise<void> {
  const epoch=operationEpoch
  if (!listInitialized.value) await loadInitialClaims()
  if(epoch!==operationEpoch)return
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
  const request=++listRequest
  listLoading.value = true
  listError.value = ''
  try {
    const page = await listMemoryClaims()
    if(request!==listRequest)return
    claims.value = page.claims
    nextCursor.value = page.next_cursor
    totalCount.value = page.total_count
    currentPage.value = 1
  } catch (err) {
    if(request!==listRequest)return
    claims.value = []
    nextCursor.value = null
    totalCount.value = 0
    listError.value = err instanceof Error ? err.message : 'load failed'
  } finally {
    if(request===listRequest){listLoading.value = false; listInitialized.value = true}
  }
}

async function loadMoreClaims(): Promise<boolean> {
  if (!nextCursor.value || listLoading.value) return false
  const request=++listRequest,installationId=props.installationId
  listLoading.value = true
  listError.value = ''
  try {
    const page = await listMemoryClaims(nextCursor.value)
    if(request!==listRequest||installationId!==props.installationId)return false
    const known = new Set(claims.value.map(claim => claim.claim_id))
    claims.value = [...claims.value, ...page.claims.filter(claim => !known.has(claim.claim_id))]
    nextCursor.value = page.next_cursor
    totalCount.value = page.total_count
    return true
  } catch (err) {
    if(request!==listRequest)return false
    listError.value = err instanceof Error ? err.message : 'load failed'
    return false
  } finally {
    if(request===listRequest)listLoading.value = false
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

async function selectClaim(claimId: string, openDetails: boolean, event?: MouseEvent): Promise<void> {
  if(operationBusy.value||operationUncertain.value)return
  if (event?.currentTarget instanceof HTMLElement) detailTrigger = event.currentTarget
  if (selectedClaimId.value === claimId && detail.value?.claim.claim_id === claimId) {
    if (openDetails) {detailOpen.value = true;void revealDetail()}
    return
  }
  selectedClaimId.value = claimId
  await loadDetail(claimId, openDetails)
}

async function loadDetail(claimId: string, openDetails: boolean): Promise<void> {
  const request = ++detailRequest
  const installationId = props.installationId
  detailOpen.value = openDetails
  if(openDetails)void revealDetail()
  olderLoading.value=false;olderError.value='';proposalLoading.value=false
  detailLoading.value = true
  detail.value = null
  error.value = ''
  confirmDelete.value = false
  correcting.value = false
  try {
    const loaded = installationId
      ? await getMemoryClaim(claimId, null, installationId)
      : await getMemoryClaim(claimId)
    if (request !== detailRequest || installationId !== props.installationId) return
    detail.value = loaded
    ensureSelectedSummary()
    correctedStatement.value = currentVersion.value?.statement ?? ''
  } catch (err) {
    if (request !== detailRequest || installationId !== props.installationId) return
    detail.value = null
    error.value = err instanceof Error ? err.message : 'load failed'
  } finally {
    if (request === detailRequest) detailLoading.value = false
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
  const epoch=operationEpoch
  const open=detailOpen.value
  listInitialized.value = false
  await loadInitialClaims()
  if(epoch!==operationEpoch)return
  if(listError.value)throw Error(listError.value)
  const target = preferredClaimId && claims.value.some(claim => claim.claim_id === preferredClaimId)
    ? preferredClaimId
    : claims.value[0]?.claim_id ?? null
  if (target) {
    const targetIndex = claims.value.findIndex(claim => claim.claim_id === target)
    currentPage.value = Math.floor(Math.max(0, targetIndex) / CLAIM_PAGE_SIZE) + 1
    selectedClaimId.value = target
    await loadDetail(target, open)
    if(!detail.value)throw Error(error.value)
  }
  else {
    selectedClaimId.value = null
    detail.value = null
    detailOpen.value = false
  }
}

async function loadOlder():Promise<void>{
  const snapshot=detail.value,request=detailRequest,installationId=props.installationId
  if(!snapshot?.next_version_cursor||olderLoading.value)return
  olderLoading.value=true;olderError.value=''
  try{
    const older=await getMemoryClaim(snapshot.claim.claim_id,snapshot.next_version_cursor,installationId??undefined)
    if(request!==detailRequest||installationId!==props.installationId||detail.value?.claim.current_version_id!==snapshot.claim.current_version_id)return
    const known=new Set(detail.value.versions.map(v=>v.version_id))
    detail.value={...detail.value,versions:[...detail.value.versions,...older.versions.filter(v=>!known.has(v.version_id))],next_version_cursor:older.next_version_cursor}
  }catch(err){if(request===detailRequest)olderError.value=err instanceof Error?err.message:t('memory.claim_load_failed')}
  finally{if(request===detailRequest)olderLoading.value=false}
}
async function runOperation(kind:ClaimOperation['kind']):Promise<void>{
  if(!detail.value||isSharedDetail.value||operationBusy.value||refreshRequired.value||detail.value.claim.state!=='active')return
  if(operationUncertain.value&&operationRequest.value?.kind!==kind)return
  const claim=detail.value.claim,statement=correctedStatement.value.trim()
  if(kind==='correct'&&(!statement||statement.length>4000||(!operationUncertain.value&&statement===currentVersion.value?.statement.trim())))return
  const canonical=JSON.stringify([kind,claim.claim_id,claim.revision,kind==='correct'?statement:''])
  const previous=operationRequest.value
  if(!previous||JSON.stringify([previous.kind,previous.claimId,String(previous.revision),previous.kind==='correct'?previous.statement:''])!==canonical){
    operationRequest.value={kind,claimId:claim.claim_id,revision:Number(claim.revision),statement,manual:isManualEntry.value,key:`web-${kind}-${crypto.randomUUID()}`}
  }
  const input=operationRequest.value!,epoch=++operationEpoch
  operationBusy.value=true;writeCommitted=false;error.value=''
  try{
    if(kind==='correct')await(input.manual?reviseManualMemoryClaim:reviseAcceptedMemoryClaim)(input.claimId,input.statement,input.revision,input.key)
    else if(kind==='revoke')await revokeMemoryClaim(input.claimId,input.revision,input.key)
    else await deleteMemoryClaim(input.claimId,input.revision,input.key)
    if(epoch!==operationEpoch)return
    writeCommitted=true;operationUncertain.value=false;operationRequest.value=undefined;correcting.value=false;confirmDelete.value=false
    refreshTarget=kind==='correct'?input.claimId:null
    await refreshAfterMutation()
    if(epoch===operationEpoch)emit('changed')
  }catch(err){
    if(epoch!==operationEpoch)return
    operationUncertain.value=!(err instanceof MemoryClientError)||err.status===0||err.status>=500
    if(err instanceof MemoryClientError&&err.status===409){refreshRequired.value=true;refreshTarget=input.claimId}
    error.value=err instanceof MemoryClientError&&err.status===409?t('memory.claim_operation_conflict'):err instanceof Error?err.message:t('memory.claim_operation_failed')
  }finally{if(epoch===operationEpoch)operationBusy.value=false}
}
async function refreshAfterMutation(){
  const epoch=operationEpoch,wasBusy=operationBusy.value;operationBusy.value=true
  try{await refreshClaims(refreshTarget);if(epoch!==operationEpoch)return;refreshRequired.value=false;operationRequest.value=undefined;error.value=''}
  catch{if(epoch===operationEpoch){refreshRequired.value=true;error.value=t(writeCommitted?'memory.claim_saved_refresh_failed':'memory.claim_load_failed')}}
  finally{if(epoch===operationEpoch)operationBusy.value=wasBusy}
}
async function correct(){await runOperation('correct')}
async function revoke(){await runOperation('revoke')}
async function erase(){await runOperation('delete')}
async function prepareProposal():Promise<void>{
  const snapshot=detail.value,request=detailRequest,installationId=props.installationId
  if(!snapshot?.claim.current_version_id||proposalLoading.value||operationBusy.value||operationUncertain.value)return
  proposalLoading.value=true;error.value=''
  try{
    const evidence=await listVersionEvidence(snapshot.claim.current_version_id,installationId??undefined)
    if(request!==detailRequest||installationId!==props.installationId)return
    if(!evidence.length)throw Error(t('memory.claim_evidence_required'))
    emit('propose',snapshot,evidence,installationId)
  }catch(err){if(request===detailRequest)error.value=err instanceof Error?err.message:t('memory.claim_operation_failed')}
  finally{if(request===detailRequest)proposalLoading.value=false}
}
</script>
