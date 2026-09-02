<template>
  <div class="memory-workbench" :class="{ 'is-mobile': isMobile }">
    <header class="memory-page-head">
      <div class="memory-page-copy">
        <p class="memory-eyebrow">{{ t('memory.overline') }}</p>
        <h1>{{ t('memory.title') }}</h1>
        <p class="memory-subtitle">{{ t('memory.subtitle') }}</p>
      </div>

      <dl v-if="installation && servicesEnabled" class="memory-summary" aria-label="Memory status summary">
        <div>
          <dt>{{ t('memory.summary_status') }}</dt>
          <dd><span class="memory-status-dot"></span>{{ t('memory.status_online') }}</dd>
        </div>
        <div data-testid="memory-summary-services">
          <dt>{{ t('memory.summary_services') }}</dt>
          <dd>{{ installation.enabled_services.length }}</dd>
        </div>
        <div data-testid="memory-summary-review">
          <dt>{{ t('memory.summary_review') }}</dt>
          <dd>{{ reviewCount ?? '—' }}</dd>
        </div>
      </dl>
    </header>

    <section v-if="loading" class="memory-gate memory-loading-gate" data-testid="memory-loading">
      <div class="memory-gate-mark is-loading" aria-hidden="true"><span class="memory-spinner"></span></div>
      <h2>{{ t('memory.loading') }}</h2>
      <p>{{ t('memory.loading_copy') }}</p>
    </section>

    <section v-else-if="!installation" class="memory-gate" data-testid="memory-first-run">
      <div class="memory-gate-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 5a3 3 0 1 0-6 .5A4 4 0 0 0 4 12a4 4 0 0 0 2 6.5A3 3 0 0 0 12 19z"/><path d="M12 5a3 3 0 1 1 6 .5A4 4 0 0 1 20 12a4 4 0 0 1-2 6.5A3 3 0 0 1 12 19z"/><path d="M12 7v10"/></svg>
      </div>
      <h2>{{ t('memory.first_run_title') }}</h2>
      <p>{{ t('memory.first_run_copy') }}</p>
    </section>

    <section v-else-if="installation.status !== 'active' || !servicesEnabled"
      class="memory-gate" data-testid="memory-service-gate">
      <div class="memory-gate-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 1 0 7-7"/><path d="M12 2v10M9 5h6"/></svg>
      </div>
      <h2>{{ t('memory.enable_title') }}</h2>
      <p>{{ t('memory.enable_copy') }}</p>
      <p v-if="installation.status !== 'active'" class="memory-gate-status">
        <span></span>{{ t('memory.installation_inactive') }}（{{ installation.status }}）
      </p>
      <button v-else type="button" class="memory-button is-primary"
        data-testid="memory-enable-services" :disabled="busy" @click="enableServices">
        {{ t('memory.enable_action') }}
      </button>
      <p v-if="error" class="memory-error">{{ error }}</p>
    </section>

    <section v-else class="memory-workspace" data-testid="memory-workspace">
      <header class="memory-workspace-toolbar" :aria-label="t('memory.workspace_label')"
        data-testid="memory-workspace-toolbar">
        <nav class="memory-tabs" role="tablist" aria-orientation="horizontal" data-testid="memory-tabs">
          <button v-for="tab in tabs" :key="tab" :id="`memory-tab-${tab}`" type="button"
            class="memory-tab" :class="{ active: active === tab }" role="tab"
            :aria-selected="active === tab" :aria-controls="`memory-panel-${tab}`"
            :data-testid="`memory-tab-${tab}`" @click="active = tab">
            <span class="memory-tab-icon" aria-hidden="true">
              <svg v-if="tab === 'search'" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>
              <svg v-else-if="tab === 'review'" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/><path d="m8 12 2.5 2.5L16 9"/></svg>
              <svg v-else-if="tab === 'claims'" viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>
              <svg v-else-if="tab === 'wiki'" viewBox="0 0 24 24"><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z"/></svg>
              <svg v-else-if="tab === 'codegraph'" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 11 9.2-5M7 13l10 4"/></svg>
              <svg v-else viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>
            </span>
            <span class="memory-tab-copy"><strong>{{ t(`memory.tab_${tab}`) }}</strong><small>{{ t(`memory.tab_${tab}_desc`) }}</small></span>
            <span v-if="tab === 'review' && reviewCount !== null" class="memory-tab-badge">{{ reviewCount > 99 ? '99+' : reviewCount }}</span>
          </button>
        </nav>

        <span class="memory-workspace-separator" aria-hidden="true"></span>
        <p class="memory-workspace-description" data-testid="memory-workspace-description">
          {{ t(`memory.module_${active}_copy`) }}
        </p>

        <div class="memory-workspace-actions" data-testid="memory-workspace-actions">
          <button v-if="active === 'search'" type="button" class="memory-button"
            data-testid="memory-filter-scope" :title="t('memory.filter_scope_unavailable')" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M7 12h10M10 19h4"/></svg>{{ t('memory.filter_scope') }}
          </button>
          <template v-else-if="active === 'review'">
            <button type="button" class="memory-button" :title="t('memory.skip_low_confidence_unavailable')" disabled>
              {{ t('memory.skip_low_confidence') }}
            </button>
            <button type="button" class="memory-button memory-mobile-essential"
              :title="t('memory.review_history_unavailable')" disabled>
              {{ t('memory.review_history') }}
            </button>
          </template>
          <button v-else-if="active === 'claims'" type="button" class="memory-button memory-claim-create"
            data-testid="memory-claim-create" :title="t('memory.new_claim_unavailable')" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>{{ t('memory.new_claim') }}
          </button>
        </div>
        <span class="memory-workspace-health" data-testid="memory-workspace-health">
          <span class="memory-status-dot"></span>{{ t('memory.health_title') }}
        </span>
      </header>

      <div class="memory-module-stage" data-testid="memory-module-stage">
        <div :id="`memory-panel-${active}`" class="memory-module-body" role="tabpanel" :aria-labelledby="`memory-tab-${active}`">
          <MemorySearchPanel v-if="active === 'search'" :scopes="governanceScopes" @select-claim="selectClaim"/>
          <template v-if="active === 'review'">
            <MemoryScopeSwitcher v-if="governanceScopes.length > 0" v-model="governanceTarget"
              :scopes="governanceScopes" />
            <MemoryGovernanceQueue v-if="governanceTarget" :entries="governanceQueue"
              :loading="governanceLoading" :error="governanceError"
              @decide="decideGovernance" @publish="publishGovernance" />
            <MemoryConflictPanel v-if="conflictCandidates.length" :candidates="conflictCandidates"
              :claims="conflictClaims" @resolve="resolveGovernanceConflict" />
            <MemoryScopeMembers v-if="selectedGovernanceScope?.owner_scope_kind !== 'personal' && canManageScope"
              :members="governanceMembers" :can-manage="canManageScope"
              :loading="governanceMembersLoading" @change-role="changeMemberRole" @revoke="revokeMember" />
            <MemoryReviewPolicyEditor v-if="selectedGovernanceScope?.owner_scope_kind !== 'personal'"
              :document="reviewPolicyDocument" :revision="reviewPolicyRevision"
              :can-edit="canEditReviewPolicy" @save="saveGovernanceReviewPolicy" />
            <div v-if="canManageScope && selectedGovernanceScope?.owner_scope_kind !== 'personal'"
              class="memory-governance-actions">
              <button type="button" @click="pendingLifecycleState = 'suspended'">
                {{ t('memory.governance.lifecycle.suspend') }}
              </button>
              <button type="button" class="memory-button is-danger"
                @click="pendingLifecycleState = 'dissolving'">
                {{ t('memory.governance.lifecycle.dissolve') }}
              </button>
              <button v-if="selectedGovernanceScope?.state === 'dissolving' && transferTarget"
                type="button" @click="transferDissolvingScope">
                {{ t('memory.governance.lifecycle.transfer') }}
              </button>
            </div>
            <p v-else-if="governanceError" class="memory-error" role="alert">{{ governanceError }}</p>
            <CandidateReviewList ref="reviewList" @accepted="rememberAcceptedClaim"
              @changed="refreshReview" @count="reviewCount = $event"/>
          </template>
          <ClaimDetailPanel v-if="active === 'claims'" :claim-id="claimId"
            :installation-id="claimSourceInstallationId" @changed="refreshReview"
            @propose="openPromotion"/>
          <MemoryWikiPanel v-if="active === 'wiki'" v-model:repository-id="phase4RepositoryId"
            :can-contribute="canContributePhase4" :can-publish="canPublishPhase4" />
          <MemoryCodeGraphPanel v-if="active === 'codegraph'" v-model:repository-id="phase4RepositoryId" />
          <template v-if="active === 'skills'">
            <div v-if="governanceScopesError" class="memory-notice is-error" role="alert" data-testid="skill-scope-error">
              <strong>{{ t('memory.skills.scope_failed') }}</strong><p>{{ governanceScopesError }}</p>
              <button class="memory-button" :disabled="governanceScopesLoading" data-testid="skill-scope-retry" @click="loadGovernanceScopes">{{ t('memory.skills.retry') }}</button>
            </div>
            <p v-else-if="governanceScopesLoading" role="status">{{ t('memory.skills.loading') }}</p>
            <template v-else>
              <MemoryScopeSwitcher v-model="governanceTarget" :scopes="governanceScopes" />
              <MemorySkillsView :scope-id="governanceTarget" />
            </template>
          </template>
          <MemorySettingsCard v-if="active === 'settings'" :services="installation.enabled_services"
            :installation-status="installation.status" @changed="reload"/>
        </div>
      </div>
    </section>
  </div>

  <!-- Phase 2 tabs (plan section 13): context, persona, policies, loadouts -->
  <section id="memory-panel-context" role="tabpanel" aria-labelledby="memory-tab-context" :hidden="active !== 'context'" data-testid="memory-panel-context">
    <MemoryContextSettings />
		<ContextPackList @select="selectedContextPack = $event" />
		<ContextPackDetail :pack="selectedContextPack" />
  </section>
  <section id="memory-panel-persona" role="tabpanel" aria-labelledby="memory-tab-persona" :hidden="active !== 'persona'" data-testid="memory-panel-persona">
    <MemoryPersonaPanel />
  </section>
  <section id="memory-panel-policies" role="tabpanel" aria-labelledby="memory-tab-policies" :hidden="active !== 'policies'" data-testid="memory-panel-policies">
    <MemoryPolicyEditor />
  </section>
  <section id="memory-panel-loadouts" role="tabpanel" aria-labelledby="memory-tab-loadouts" :hidden="active !== 'loadouts'" data-testid="memory-panel-loadouts">
    <MemoryLoadoutEditor />
  </section>
  <MemoryPromotionDialog :claim="promotionClaim" :evidence="promotionEvidence"
    :targets="promotionTargets" @confirm="confirmPromotion" @cancel="closePromotion" />
  <div v-if="pendingLifecycleState && selectedGovernanceScope" class="memory-modal-backdrop"
    @click.self="pendingLifecycleState = null">
    <section class="memory-modal" role="alertdialog" aria-modal="true"
      aria-labelledby="memory-scope-lifecycle-title">
      <header><div><h3 id="memory-scope-lifecycle-title">{{ t('memory.governance.lifecycle.title') }}</h3></div></header>
      <div class="memory-modal-body">
        <p>{{ t('memory.governance.lifecycle.consequences') }}</p>
        <ul><li>{{ t('memory.governance.lifecycle.freeze') }}</li>
          <li>{{ t('memory.governance.lifecycle.revoke') }}</li></ul>
      </div>
      <footer>
        <button type="button" @click="pendingLifecycleState = null">{{ t('common.cancel') }}</button>
        <button type="button" class="memory-button is-danger" @click="confirmLifecycle">
          {{ t('common.confirm') }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import MemoryContextSettings from '../components/memory/MemoryContextSettings.vue'
import ContextPackList from '../components/memory/ContextPackList.vue'
import ContextPackDetail from '../components/memory/ContextPackDetail.vue'
import MemoryPersonaPanel from '../components/memory/MemoryPersonaPanel.vue'
import MemoryPolicyEditor from '../components/memory/MemoryPolicyEditor.vue'
import MemoryLoadoutEditor from '../components/memory/MemoryLoadoutEditor.vue'

import { computed, onMounted, ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
import { useResponsiveLayout } from '../composables/useResponsiveLayout'
import {
  currentMemoryInstallation, decideGovernanceCandidate, discoverMemoryInstallation,
  enableMemoryServices, getReviewPolicy, listGovernanceQueue, listGovernanceScopes,
  listScopeMembers, publishGovernanceCandidate, saveReviewPolicy, updateScopeMember,
  proposeGovernanceClaim, startScopeTransfer, updateScopeLifecycle,
} from '../services/memoryClient'
import type {
  ContextPackListEntry, MemoryClaimDetail, MemoryEvidence, MemoryGovernanceQueueEntry,
  MemoryGovernanceScope, MemoryInstallation, MemoryReviewPolicyDocument, MemoryScopeMember,
} from '../types/memory'
import { promotionTargetsForSource } from '../utils/memoryGovernance'
import MemorySearchPanel from '../components/memory/MemorySearchPanel.vue'
import CandidateReviewList from '../components/memory/CandidateReviewList.vue'
import ClaimDetailPanel from '../components/memory/ClaimDetailPanel.vue'
import MemorySettingsCard from '../components/memory/MemorySettingsCard.vue'
import MemoryScopeSwitcher from '../components/memory/MemoryScopeSwitcher.vue'
import MemoryGovernanceQueue from '../components/memory/MemoryGovernanceQueue.vue'
import MemoryConflictPanel from '../components/memory/MemoryConflictPanel.vue'
import MemoryScopeMembers from '../components/memory/MemoryScopeMembers.vue'
import MemoryReviewPolicyEditor from '../components/memory/MemoryReviewPolicyEditor.vue'
import MemoryPromotionDialog from '../components/memory/MemoryPromotionDialog.vue'
import MemoryWikiPanel from '../components/memory/MemoryWikiPanel.vue'
import MemoryCodeGraphPanel from '../components/memory/MemoryCodeGraphPanel.vue'
import MemorySkillsView from './MemorySkillsView.vue'

const { t } = useLocale()
const { isMobile } = useResponsiveLayout()
const selectedContextPack = ref<ContextPackListEntry | null>(null)

const installation = ref<MemoryInstallation | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const active = ref<'search' | 'review' | 'claims' | 'wiki' | 'codegraph' | 'skills' | 'context' | 'persona' | 'policies' | 'loadouts' | 'settings'>('search')
const phase4RepositoryId = ref('')
const claimId = ref<string | null>(null)
const claimSourceInstallationId = ref<string | null>(null)
const reviewCount = ref<number | null>(null)
const reviewList = ref<InstanceType<typeof CandidateReviewList> | null>(null)
const governanceScopes = ref<MemoryGovernanceScope[]>([])
const governanceScopesLoading = ref(false)
const governanceScopesError = ref('')
const governanceTarget = ref('')
const governanceQueue = ref<MemoryGovernanceQueueEntry[]>([])
const governanceLoading = ref(false)
const governanceError = ref<string | null>(null)
const governanceMembers = ref<MemoryScopeMember[]>([])
const governanceMembersLoading = ref(false)
const reviewPolicyDocument = ref<MemoryReviewPolicyDocument | null>(null)
const reviewPolicyRevision = ref(0)
const promotionClaim = ref<MemoryClaimDetail | null>(null)
const promotionEvidence = ref<MemoryEvidence[]>([])
const promotionSourceInstallationId = ref<string | null>(null)
const pendingLifecycleState = ref<'suspended' | 'dissolving' | null>(null)

const tabs = ['search', 'review', 'claims', 'wiki', 'codegraph', 'skills', 'context', 'persona', 'policies', 'loadouts', 'settings'] as const
const requiredServices = ['memory.search', 'memory.recall', 'memory.manage', 'memory.context']
const servicesEnabled = computed(() => requiredServices.every(service => installation.value?.enabled_services.includes(service)))
const selectedGovernanceScope = computed(() => governanceScopes.value.find(
  scope => scope.installation_id === governanceTarget.value) ?? null)
const canManageScope = computed(() => selectedGovernanceScope.value?.permissions.includes('scope_admin') === true)
const canEditReviewPolicy = computed(() => selectedGovernanceScope.value?.permissions.includes('policy_admin') === true)
const primaryGovernanceScope = computed(() => governanceScopes.value.find(
  scope => scope.installation_id === installation.value?.installation_id,
))
const canContributePhase4 = computed(() => primaryGovernanceScope.value?.permissions.includes('contribute') === true)
const canPublishPhase4 = computed(() => primaryGovernanceScope.value?.permissions.includes('publish') === true)
const conflictCandidates = computed(() => governanceQueue.value
  .filter(entry => entry.candidate.state === 'conflict')
  .map(entry => ({
    candidate_id: entry.candidate.candidate_id,
    normalized_key: entry.candidate.normalized_key,
  })))
const conflictClaims = computed(() => governanceQueue.value
  .filter(entry => entry.candidate.state === 'conflict')
  .flatMap(entry => (entry.conflict_claims ?? []).map(claim => ({
    candidate_id: entry.candidate.candidate_id,
    ...claim,
  }))))
const promotionTargets = computed(() => promotionTargetsForSource(
  governanceScopes.value,
  promotionSourceInstallationId.value,
))
const transferTarget = computed(() => {
  const source = selectedGovernanceScope.value
  if (source?.owner_scope_kind !== 'team' || !source.parent_organization_id) return null
  return governanceScopes.value.find(scope =>
    scope.owner_scope_kind === 'organization'
      && scope.owner_scope_id === source.parent_organization_id
      && scope.state === 'active'
      && scope.permissions.includes('scope_admin')) ?? null
})

onMounted(load)
watch(governanceTarget, () => { void loadGovernanceWorkspace() })

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    installation.value = await discoverMemoryInstallation()
    await loadGovernanceScopes()
  } catch (err) {
    installation.value = currentMemoryInstallation()
    error.value = err instanceof Error ? err.message : ''
  } finally {
    loading.value = false
  }
}

function reload(): void { void load() }
function refreshReview(): void { reviewList.value?.refresh?.() }
function rememberAcceptedClaim(id: string): void {
  claimSourceInstallationId.value = null
  claimId.value = id
}
function selectClaim(id: string, hit?: { installationId?: string; ownerScopeKind?: string }): void {
  const selectedInstallation = hit?.installationId
  claimSourceInstallationId.value = selectedInstallation
    && selectedInstallation !== installation.value?.installation_id
    && hit?.ownerScopeKind !== 'personal'
    ? selectedInstallation
    : null
  claimId.value = id
  active.value = 'claims'
}

async function loadGovernanceScopes(): Promise<void> {
  governanceScopesLoading.value = true
  governanceScopesError.value = ''
  try {
    const previous = governanceTarget.value
    governanceScopes.value = (await listGovernanceScopes()).scopes
    const preferred = governanceScopes.value.find(scope => scope.installation_id === previous)
      ?? governanceScopes.value.find(scope => scope.owner_scope_kind === 'personal')
      ?? governanceScopes.value[0]
    governanceTarget.value = preferred?.installation_id ?? ''
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'governance unavailable'
    const status = err && typeof err === 'object' && 'status' in err ? Number(err.status) : 0
    const kind = status === 403 ? 'forbidden' : status === 503 ? 'off' : 'request_failed'
    governanceScopesError.value = `${t(`memory.skills.${kind}`)} · ${governanceError.value}`
  } finally {
    governanceScopesLoading.value = false
  }
}

async function loadGovernanceWorkspace(): Promise<void> {
  await loadGovernanceQueue()
  const scope = selectedGovernanceScope.value
  governanceMembers.value = []
  reviewPolicyDocument.value = null
  reviewPolicyRevision.value = 0
  if (!scope || scope.owner_scope_kind === 'personal') return
  if (scope.permissions.includes('scope_admin')) {
    governanceMembersLoading.value = true
    try {
      governanceMembers.value = (await listScopeMembers(scope)).members
    } catch (err) {
      governanceError.value = err instanceof Error ? err.message : 'members unavailable'
    } finally {
      governanceMembersLoading.value = false
    }
  }
  try {
    const policy = await getReviewPolicy(scope.installation_id)
    reviewPolicyRevision.value = policy.head?.revision ?? 0
    reviewPolicyDocument.value = policy.versions.find(
      version => version.policyVersionId === policy.head?.activeVersionId)?.document ?? null
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'review policy unavailable'
  }
}

async function loadGovernanceQueue(): Promise<void> {
  if (!governanceTarget.value) return
  governanceLoading.value = true
  governanceError.value = null
  try {
    governanceQueue.value = (await listGovernanceQueue(governanceTarget.value)).queue
  } catch (err) {
    governanceQueue.value = []
    governanceError.value = err instanceof Error ? err.message : 'governance queue unavailable'
  } finally {
    governanceLoading.value = false
  }
}

async function decideGovernance(candidateId: string, decision: 'approve' | 'request_changes' | 'reject') {
  const entry = governanceQueue.value.find(item => item.candidate.candidate_id === candidateId)
  if (!entry) return
  try {
    await decideGovernanceCandidate({
      installationIds: [governanceTarget.value], candidateId,
      targetInstallationId: governanceTarget.value,
      expectedRevision: entry.candidate.revision,
      decision,
    })
    await loadGovernanceQueue()
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'decision failed'
  }
}

async function publishGovernance(
  candidateId: string,
  resolution: 'new' | 'parallel' | 'supersede',
  supersedeClaimIds?: string[],
) {
  const entry = governanceQueue.value.find(item => item.candidate.candidate_id === candidateId)
  if (!entry) return
  try {
    await publishGovernanceCandidate({
      installationIds: [governanceTarget.value], candidateId,
      targetInstallationId: governanceTarget.value,
      expectedRevision: entry.candidate.revision, resolution, supersedeClaimIds,
    })
    await loadGovernanceQueue()
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'publish failed'
  }
}

function resolveGovernanceConflict(input: {
  candidateId: string
  resolution: 'parallel' | 'supersede'
  claimIds: string[]
}): void {
  void publishGovernance(input.candidateId, input.resolution, input.claimIds)
}

async function changeMemberRole(membershipId: string, roles: string[]): Promise<void> {
  const scope = selectedGovernanceScope.value
  const member = governanceMembers.value.find(entry => entry.membership_id === membershipId)
  if (!scope || !member) return
  try {
    await updateScopeMember({ scope, membershipId, expectedRevision: member.membership_revision, roles })
    governanceMembers.value = (await listScopeMembers(scope)).members
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'member update failed'
  }
}

async function revokeMember(membershipId: string): Promise<void> {
  const scope = selectedGovernanceScope.value
  const member = governanceMembers.value.find(entry => entry.membership_id === membershipId)
  if (!scope || !member) return
  try {
    await updateScopeMember({
      scope, membershipId, expectedRevision: member.membership_revision, state: 'revoked',
    })
    governanceMembers.value = (await listScopeMembers(scope)).members
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'member revoke failed'
  }
}

async function saveGovernanceReviewPolicy(input: {
  document: MemoryReviewPolicyDocument
  expectedRevision: number
}): Promise<void> {
  if (!selectedGovernanceScope.value) return
  try {
    await saveReviewPolicy({
      targetInstallationId: selectedGovernanceScope.value.installation_id,
      expectedRevision: input.expectedRevision,
      document: input.document,
    })
    await loadGovernanceWorkspace()
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'review policy update failed'
  }
}

function openPromotion(
  claim: MemoryClaimDetail,
  evidence: MemoryEvidence[],
  sourceInstallationId: string | null,
): void {
  promotionClaim.value = claim
  promotionEvidence.value = evidence
  promotionSourceInstallationId.value = sourceInstallationId
    ?? installation.value?.installation_id
    ?? null
}

function closePromotion(): void {
  promotionClaim.value = null
  promotionEvidence.value = []
  promotionSourceInstallationId.value = null
}

async function confirmPromotion(input: {
  targetInstallationId: string
  evidenceIds: string[]
}): Promise<void> {
  if (!promotionClaim.value || !promotionSourceInstallationId.value) return
  const target = governanceScopes.value.find(scope =>
    scope.installation_id === input.targetInstallationId)
  if (!target) return
  try {
    await proposeGovernanceClaim({
      installationIds: [target.installation_id, promotionSourceInstallationId.value],
      targetInstallationId: target.installation_id,
      expectedRevision: Number(target.authorization_epoch),
      sourceInstallationId: promotionSourceInstallationId.value,
      sourceClaimId: promotionClaim.value.claim.claim_id,
      evidenceIds: input.evidenceIds,
    })
    closePromotion()
    governanceTarget.value = target.installation_id
    active.value = 'review'
    await loadGovernanceWorkspace()
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'proposal failed'
  }
}

async function confirmLifecycle(): Promise<void> {
  const scope = selectedGovernanceScope.value
  const state = pendingLifecycleState.value
  if (!scope || !state) return
  try {
    await updateScopeLifecycle({ scope, state })
    pendingLifecycleState.value = null
    await loadGovernanceScopes()
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'scope lifecycle update failed'
  }
}

async function transferDissolvingScope(): Promise<void> {
  const source = selectedGovernanceScope.value
  const target = transferTarget.value
  if (!source || !target) return
  try {
    await startScopeTransfer({
      sourceInstallationId: source.installation_id,
      targetInstallationId: target.installation_id,
      expectedRevision: Number(source.authorization_epoch),
    })
    await loadGovernanceWorkspace()
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'scope transfer failed'
  }
}

async function enableServices(): Promise<void> {
  if (!installation.value) return
  busy.value = true
  error.value = ''
  try {
    installation.value = await enableMemoryServices(
      installation.value.installation_id,
      Number(installation.value.config_version),
      [...new Set([...installation.value.enabled_services, ...requiredServices])],
    )
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'enable failed'
  } finally {
    busy.value = false
  }
}
</script>

<style src="../components/memory/memory-workbench.css"></style>
