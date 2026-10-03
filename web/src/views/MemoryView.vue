<template>
  <div class="memory-workbench memory-layout-v2 design-surface content memory-page" :class="{ 'is-mobile': isMobile }">
    <header class="memory-page-head page-tools">
      <div class="memory-page-brand">
        <span class="memory-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5a3 3 0 1 0-6 .5A4 4 0 0 0 4 12a4 4 0 0 0 2 6.5A3 3 0 0 0 12 19zM12 5a3 3 0 1 1 6 .5A4 4 0 0 1 20 12a4 4 0 0 1-2 6.5A3 3 0 0 1 12 19zM12 7v10"/></svg></span>
        <div class="memory-page-copy"><p class="memory-subtitle">{{ t('memory.subtitle') }}</p></div>
      </div>
      <span v-if="installation && servicesEnabled" class="memory-page-status"><span class="memory-status-dot"></span>{{ t('memory.services_enabled') }}</span>
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
      <div v-if="isMobile" class="memory-scope"><WorkspaceIcon name="memory" class="icon" /><span class="grow">{{ t('replica.personal_memory') }}</span><span class="badge green">{{ t('memory.services_enabled') }}</span></div>
      <div class="memory-workspace-shell memory-grid" data-testid="memory-workbench-frame">
        <MemoryModuleNavigation v-model="active" :review-count="reviewCount" />
        <div class="memory-workspace-main memory-stage">
          <div class="memory-module-picker">
            <label for="memory-module-select">{{ t('memory.module') }}
              <ActionSelect><select id="memory-module-select" v-model="active" :aria-label="t('memory.choose_module')" data-testid="memory-module-select">
                <optgroup v-for="group in MEMORY_MODULE_GROUPS" :key="group.id" :label="t(`memory.group_${group.id}`)">
                  <option v-for="module in group.modules" :key="module" :value="module">{{ t(`memory.tab_${module}`) }}</option>
                </optgroup>
              </select></ActionSelect>
            </label>
          </div>
          <header class="memory-module-header" :aria-label="t('memory.workspace_label')" data-testid="memory-workspace-toolbar">
            <h2>{{ t(`memory.tab_${active}`) }}</h2><p :id="`memory-description-${active}`" data-testid="memory-workspace-description">{{ t(`memory.module_${active}_copy`) }}</p>
          </header>
          <div v-if="active === 'claims'" class="memory-knowledge-heading"><h3>{{ t('memory.knowledge_versions') }}</h3>
            <button type="button" class="memory-button" data-testid="memory-claim-create" :title="t('memory.new_claim_unavailable')" disabled>+ {{ t('memory.new_claim') }}</button>
          </div>

      <div class="memory-module-stage" data-testid="memory-module-stage">
        <div :id="`memory-panel-${active}`" class="memory-module-body" role="tabpanel" :aria-label="t(`memory.tab_${active}`)" :aria-describedby="`memory-description-${active}`">
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
            <section class="memory-personal-review"><h3>{{ t('memory.personal_review') }}</h3><p class="memory-notice">{{ t('memory.personal_review_copy') }}</p>
            <CandidateReviewList ref="reviewList" @accepted="rememberAcceptedClaim"
              @changed="refreshReview" @count="reviewCount = $event"/>
            </section>
          </template>
          <ClaimDetailPanel v-if="active === 'claims'" :claim-id="claimId"
            :installation-id="claimSourceInstallationId" @changed="refreshReview"
            @propose="openPromotion"/>
          <MemoryWikiPanel v-if="active === 'wiki'" v-model:repository-id="phase4RepositoryId"
            v-model:installation-id="wikiTarget" :scopes="wikiScopes"
            :legacy-grant="wikiUsesLegacyGrant"
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
          <template v-if="active === 'git'">
            <div v-if="governanceScopesError" class="memory-notice is-error" role="alert" data-testid="git-scope-error"><p>{{ governanceScopesError }}</p><button class="memory-button" :disabled="governanceScopesLoading" @click="loadGovernanceScopes">{{ t('memory.git.refresh') }}</button></div>
            <p v-else-if="governanceScopesLoading" role="status">{{ t('memory.git.loading') }}</p>
            <template v-else>
              <MemoryScopeSwitcher v-model="gitTarget" :scopes="gitScopes" />
              <MemoryGitPanel v-if="gitTarget" :scope-id="gitTarget" />
              <p v-else role="status">{{ t('memory.git.shared_scope_required') }}</p>
            </template>
          </template>
          <section v-if="active === 'context'" data-testid="memory-panel-context">
            <MemoryContextSettings />
            <ContextPackList @select="selectedContextPack = $event" />
            <ContextPackDetail :pack="selectedContextPack" />
          </section>
          <MemoryPersonaPanel v-if="active === 'persona'" data-testid="memory-panel-persona" />
          <MemoryPolicyEditor v-if="active === 'policies'" data-testid="memory-panel-policies" />
          <MemoryLoadoutEditor v-if="active === 'loadouts'" data-testid="memory-panel-loadouts" />
          <MemorySettingsCard v-if="active === 'settings'" :services="installation.enabled_services"
            :installation-status="installation.status" @changed="reload"/>
        </div>
      </div>
          <details class="memory-scope-help"><summary>{{ t('memory.scope_help_title') }}</summary><p>{{ t('memory.scope_help_copy') }}</p></details>
        </div>
      </div>
    </section>
  </div>
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
import ActionSelect from '../components/ActionSelect.vue'
import WorkspaceIcon from '../components/WorkspaceIcon.vue'
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
import MemoryGitPanel from '../components/memory/MemoryGitPanel.vue'
import MemoryModuleNavigation from '../components/memory/MemoryModuleNavigation.vue'
import { MEMORY_MODULE_GROUPS, type MemoryModule } from '../components/memory/memoryModules'

const { t } = useLocale()
const { isMobile } = useResponsiveLayout()
const selectedContextPack = ref<ContextPackListEntry | null>(null)

const installation = ref<MemoryInstallation | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const active = ref<MemoryModule>('search')
const phase4RepositoryId = ref('')
const claimId = ref<string | null>(null)
const claimSourceInstallationId = ref<string | null>(null)
const reviewCount = ref<number | null>(null)
const reviewList = ref<InstanceType<typeof CandidateReviewList> | null>(null)
const governanceScopes = ref<MemoryGovernanceScope[]>([])
const governanceScopesLoading = ref(false)
const governanceScopesError = ref('')
const governanceTarget = ref('')
const wikiTarget = ref('')
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

const gitScopes=computed(()=>governanceScopes.value.filter(scope=>scope.owner_scope_kind!=='personal'&&scope.state==='active'&&scope.permissions.includes('read')))
const gitTarget=computed({get:()=>gitScopes.value.some(scope=>scope.installation_id===governanceTarget.value)?governanceTarget.value:gitScopes.value[0]?.installation_id??'',set:(value:string)=>{governanceTarget.value=value}})
const requiredServices = ['memory.search', 'memory.recall', 'memory.manage', 'memory.context']
const servicesEnabled = computed(() => requiredServices.every(service => installation.value?.enabled_services.includes(service)))
const selectedGovernanceScope = computed(() => governanceScopes.value.find(
  scope => scope.installation_id === governanceTarget.value) ?? null)
const canManageScope = computed(() => selectedGovernanceScope.value?.permissions.includes('scope_admin') === true)
const canEditReviewPolicy = computed(() => selectedGovernanceScope.value?.permissions.includes('policy_admin') === true)
const wikiScopes = computed<MemoryGovernanceScope[]>(() => {
  const readable = governanceScopes.value.filter(scope =>
    (scope.state ?? 'active') === 'active' && scope.permissions.includes('read'))
  if (readable.length > 0) return readable
  const personal = installation.value
  return personal ? [{
    installation_id: personal.installation_id,
    owner_scope_kind: 'personal',
    owner_scope_id: personal.installation_id,
    authorization_epoch: String(personal.config_version),
    permissions: ['read', 'contribute', 'publish'],
    state: 'active',
    name: 'Personal',
  }] : []
})
const selectedWikiScope = computed(() => wikiScopes.value.find(
  scope => scope.installation_id === wikiTarget.value) ?? null)
const wikiUsesLegacyGrant = computed(() => !governanceScopes.value.some(
  scope => scope.installation_id === wikiTarget.value))
const canContributePhase4 = computed(() => selectedWikiScope.value?.permissions.includes('contribute') === true)
const canPublishPhase4 = computed(() => selectedWikiScope.value?.permissions.includes('publish') === true)
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
    const previousWiki = wikiTarget.value
    const wikiPreferred = wikiScopes.value.find(scope => scope.installation_id === previousWiki)
      ?? wikiScopes.value.find(scope => scope.owner_scope_kind === 'personal')
      ?? wikiScopes.value[0]
    wikiTarget.value = wikiPreferred?.installation_id ?? ''
  } catch (err) {
    governanceError.value = err instanceof Error ? err.message : 'governance unavailable'
    const status = err && typeof err === 'object' && 'status' in err ? Number(err.status) : 0
    const kind = status === 403 ? 'forbidden' : status === 503 ? 'off' : 'request_failed'
    governanceScopesError.value = `${t(`memory.skills.${kind}`)} · ${governanceError.value}`
    wikiTarget.value = installation.value?.installation_id ?? ''
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
