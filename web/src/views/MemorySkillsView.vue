<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
import { memorySkills } from '../services/memorySkills'
import type { MemorySkillCandidate, MemorySkillDetail, MemorySkillDiff, MemorySkillDocument,
  MemorySkillModes, MemorySkillPolicy, MemorySkillPolicyState, MemorySkillReplayCase, MemorySkillReviewOutcome, MemorySkillSummary } from '../types/memorySkills'
import MemorySkillDocumentView from '../components/memory/MemorySkillDocument.vue'
import MemorySkillEditor from '../components/memory/MemorySkillEditor.vue'

const props = defineProps<{ scopeId: string }>()
const { t } = useLocale()
const skills = ref<MemorySkillSummary[]>([]), candidates = ref<MemorySkillCandidate[]>([])
const nextCursor = ref<string | null>(null), candidateCursor = ref<string | null>(null)
const modes = ref<MemorySkillModes | null>(null)
const detail = ref<MemorySkillDetail | null>(null), candidate = ref<MemorySkillCandidate | null>(null)
const selectedId = ref(''), loading = ref(false), candidateLoading = ref(false), detailLoading = ref(false), busy = ref(false)
const listError = ref(''), candidateError = ref(''), detailError = ref(''), actionError = ref(''), success = ref('')
const policyError = ref(''), casesError = ref(''), policyLoading = ref(false)
const editing = ref(false), fromVersion = ref(''), rollbackTarget = ref('')
const reviewOutcome = ref<MemorySkillReviewOutcome | ''>('')
const diff = ref<MemorySkillDiff | null>(null), cases = ref<MemorySkillReplayCase[]>([]), selectedCases = ref<string[]>([])
const policyState = ref<MemorySkillPolicyState | null>(null), policyDraft = ref<MemorySkillPolicy | null>(null)
const confirmation = ref<'publish' | 'rollback' | 'revoke' | null>(null)
const repositoryDraft = ref(''), repositoryFilter = ref(''), stateDraft = ref(''), stateFilter = ref('')
let epoch = 0, selectionEpoch = 0, diffEpoch = 0, controller = new AbortController(), detailController = new AbortController()
const reviewActions = ['approve', 'request_changes', 'reject'] as const
const reviewOutcomes: MemorySkillReviewOutcome[] = ['accepted_as_is', 'light_edit', 'major_edit']
const replayKinds = ['historical_session', 'golden_task'] as const
const permissions = computed(() => detail.value?.permissions)
const priorVersions = computed(() => detail.value?.versions.filter(v => v.version_id !== detail.value?.version_id) ?? [])
const blockedReasons = computed(() => detail.value?.eligibility?.reason_codes ?? [])
const publicationRevision = computed(() => Number(detail.value?.publication?.revision ?? 0))
const stringify = (value: unknown) => JSON.stringify(value, null, 2)
function message(error: unknown): string {
  const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0
  const key = status === 403 ? 'forbidden' : status === 409 ? 'conflict' : status === 503 ? 'off' : 'request_failed'
  return `${t(`memory.skills.${key}`)}${error instanceof Error ? ` · ${error.message}` : ''}`
}
function clearSelection() {
  detailController.abort(); detailController = new AbortController(); selectionEpoch++; diffEpoch++
  detail.value = null; candidate.value = null; selectedId.value = ''; editing.value = false
  reviewOutcome.value = ''
  fromVersion.value = ''; rollbackTarget.value = ''; diff.value = null; cases.value = []; selectedCases.value = []
  confirmation.value = null; detailError.value = ''; casesError.value = ''; actionError.value = ''; success.value = ''; detailLoading.value = false
}
async function loadSkills(append = false) {
  const own = epoch, scope = props.scopeId
  if (!scope) return
  loading.value = true; listError.value = ''
  try {
    const result = await memorySkills.list(scope, { repository_id: repositoryFilter.value, state: stateFilter.value,
      ...(append && nextCursor.value ? { cursor: nextCursor.value } : {}) }, controller.signal)
    if (own !== epoch) return
    skills.value = append ? [...skills.value, ...result.items] : result.items
    nextCursor.value = result.next_cursor; modes.value = result
  } catch (error) { if (own === epoch) listError.value = message(error) }
  finally { if (own === epoch) loading.value = false }
}
async function loadCandidates(append = false) {
  const own = epoch, scope = props.scopeId
  if (!scope) return
  candidateLoading.value = true; candidateError.value = ''
  try {
    const result = await memorySkills.candidates(scope, { repository_id: repositoryFilter.value,
      ...(append && candidateCursor.value ? { cursor: candidateCursor.value } : {}) }, controller.signal)
    if (own !== epoch) return
    candidates.value = append ? [...candidates.value, ...result.items] : result.items
    candidateCursor.value = result.next_cursor
  } catch (error) { if (own === epoch) candidateError.value = message(error) }
  finally { if (own === epoch) candidateLoading.value = false }
}
async function loadPolicy() {
  const own = epoch
  policyLoading.value = true; policyError.value = ''
  try {
    const result = await memorySkills.policy(props.scopeId, controller.signal)
    if (own !== epoch) return
    policyState.value = result; policyDraft.value = { ...result.policy }
  } catch (error) { if (own === epoch) policyError.value = message(error) }
  finally { if (own === epoch) policyLoading.value = false }
}
function refresh() {
  epoch++; controller.abort(); controller = new AbortController(); clearSelection()
  skills.value = []; candidates.value = []; modes.value = null; nextCursor.value = null; candidateCursor.value = null
  policyState.value = null; policyDraft.value = null; policyError.value = ''; busy.value = false
  listError.value = ''; candidateError.value = ''; loading.value = false; candidateLoading.value = false; policyLoading.value = false
  if (props.scopeId) { void loadSkills(); void loadCandidates(); void loadPolicy() }
}
watch(() => props.scopeId, () => { repositoryDraft.value = ''; repositoryFilter.value = ''; stateDraft.value = ''; stateFilter.value = ''; refresh() }, { immediate: true })
watch(fromVersion, () => { diffEpoch++; diff.value = null }, { flush: 'sync' })
onBeforeUnmount(() => { epoch++; selectionEpoch++; controller.abort(); detailController.abort() })
function filter() { repositoryFilter.value = repositoryDraft.value.trim(); stateFilter.value = stateDraft.value; refresh() }
async function selectSkill(skillId: string) {
  clearSelection(); selectedId.value = skillId; detailLoading.value = true
  const own = epoch, selected = selectionEpoch
  const signal = detailController.signal
  try {
    const result = await memorySkills.detail(props.scopeId, skillId, signal)
    if (own !== epoch || selected !== selectionEpoch) return
    detail.value = result; fromVersion.value = priorVersions.value[0]?.version_id ?? ''
    if (!result.permissions.can_replay) return
    // Replay inputs come only from the current trusted registry, never from user-authored result JSON.
    try {
      const registry = await memorySkills.replayCases(props.scopeId, skillId, signal)
      if (own === epoch && selected === selectionEpoch) cases.value = registry.items
    } catch (error) { if (own === epoch && selected === selectionEpoch) casesError.value = message(error) }
  } catch (error) { if (own === epoch && selected === selectionEpoch) detailError.value = message(error) }
  finally { if (own === epoch && selected === selectionEpoch) detailLoading.value = false }
}
function selectCandidate(value: MemorySkillCandidate) { clearSelection(); candidate.value = value }
async function mutate(work: (scope: string, signal: AbortSignal) => Promise<unknown>, skillId?: string) {
  if (busy.value) return
  const own = epoch
  busy.value = true; actionError.value = ''; success.value = ''; confirmation.value = null
  try {
    const result = await work(props.scopeId, controller.signal)
    if (own !== epoch) return
    const changedSkill = result && typeof result === 'object' && 'skill_id' in result ? String(result.skill_id) : skillId
    if (changedSkill) await selectSkill(changedSkill)
    if (own !== epoch) return
    await Promise.all([loadSkills(), loadCandidates()])
    if (own === epoch) success.value = t('memory.skills.saved')
  } catch (error) { if (own === epoch) actionError.value = message(error) }
  finally { if (own === epoch) busy.value = false }
}
function draftCandidate() {
  const value = candidate.value
  if (value?.can_draft) void mutate((scope, signal) => memorySkills.draft(scope, value.candidate_id, value.expected_revision, signal))
}
function saveDocument(document: MemorySkillDocument) {
  const value = detail.value
  if (value?.permissions.can_edit) void mutate((scope, signal) => memorySkills.edit(scope, value.skill_id, value.revision, document, signal))
}
function beginEdit() { confirmation.value = null; reviewOutcome.value = ''; editing.value = true }
function review(decision: typeof reviewActions[number]) {
  const value = detail.value
  if (editing.value || busy.value || !value?.permissions.can_review || (decision === 'approve' && !reviewOutcome.value)) return
  const outcome = decision === 'approve' ? reviewOutcome.value as MemorySkillReviewOutcome : undefined
  void mutate((scope, signal) => memorySkills.review(scope, value.skill_id, value.revision, decision, signal, outcome))
}
async function compare() {
  if (!detail.value || !fromVersion.value) return
  const own = epoch, selected = selectionEpoch, request = ++diffEpoch
  const from = fromVersion.value, to = detail.value.version_id, skillId = detail.value.skill_id
  const current = () => own === epoch && selected === selectionEpoch && request === diffEpoch
    && fromVersion.value === from && detail.value?.version_id === to
  actionError.value = ''; diff.value = null
  try {
    const result = await memorySkills.diff(props.scopeId, skillId, from, to, detailController.signal)
    if (!current()) return
    if (result.from_version_id !== from || result.to_version_id !== to) throw new Error(t('memory.skills.diff_version_mismatch'))
    diff.value = result
  } catch (error) { if (current()) actionError.value = message(error) }
}
function replay() {
  const value = detail.value
  if (editing.value || !value?.permissions.can_replay || !selectedCases.value.length) return
  const input = { version_id: value.version_id, expected_revision: value.revision,
    case_ids: selectedCases.value.filter(id => cases.value.some(c => c.case_id === id)), idempotency_key: crypto.randomUUID() }
  void mutate((scope, signal) => memorySkills.replay(scope, value.skill_id, input, signal), value.skill_id)
}
function requestConfirmation(action: 'publish' | 'rollback' | 'revoke') {
  if (!editing.value && !busy.value) confirmation.value = action
}
function confirmAction() {
  const value = detail.value, action = confirmation.value
  if (editing.value || !value) return
  if (action === 'revoke' && value.permissions.can_revoke) {
    void mutate((scope, signal) => memorySkills.revoke(scope, value.skill_id, value.revision, signal))
  } else if (action === 'publish' && value.permissions.can_publish && value.eligibility?.manual_eligible) {
    const input = { version_id: value.version_id, expected_revision: value.revision, expected_publication_revision: publicationRevision.value, mode: 'manual' as const }
    void mutate((scope, signal) => memorySkills.publish(scope, value.skill_id, input, signal), value.skill_id)
  } else if (action === 'rollback' && value.permissions.can_rollback && rollbackTarget.value) {
    const input = { target_version_id: rollbackTarget.value, expected_revision: value.revision, expected_publication_revision: publicationRevision.value }
    void mutate((scope, signal) => memorySkills.rollback(scope, value.skill_id, input, signal), value.skill_id)
  }
}
async function savePolicy() {
  const state = policyState.value, document = policyDraft.value
  if (editing.value || !state?.can_manage_policy || !document || busy.value) return
  const own = epoch
  busy.value = true; policyError.value = ''; success.value = ''
  try {
    const result = await memorySkills.updatePolicy(props.scopeId, state.revision, { ...document }, controller.signal)
    if (own !== epoch) return
    policyState.value = result; policyDraft.value = { ...result.policy }
    if (selectedId.value) await selectSkill(selectedId.value)
    if (own === epoch) success.value = t('memory.skills.saved')
  } catch (error) { if (own === epoch) policyError.value = message(error) }
  finally { if (own === epoch) busy.value = false }
}
</script>

<template>
  <section class="memory-skills-workspace" data-testid="memory-skills-panel" :aria-label="t('memory.tab_skills')">
    <p v-if="!scopeId" class="memory-skill-muted">{{ t('memory.skills.choose_scope') }}</p>
    <template v-else>
      <form class="memory-skill-toolbar" @submit.prevent="filter">
        <label>{{ t('memory.phase4.repository_id') }}<input v-model="repositoryDraft" :placeholder="t('memory.skills.all_repositories')" data-testid="skill-repository-filter" /></label>
        <label>{{ t('memory.skills.state') }}<select v-model="stateDraft"><option value="">{{ t('memory.skills.all_states') }}</option>
          <option v-for="state in ['draft', 'reviewed', 'rejected', 'revoked']" :key="state">{{ state }}</option>
        </select></label>
        <button class="memory-button" type="submit" :disabled="busy || loading" data-testid="skill-refresh">{{ t('memory.skills.refresh') }}</button>
      </form>
      <div v-if="modes" class="memory-skill-modes" data-testid="skill-modes">
        <span>{{ t('memory.skills.mode') }} <strong>{{ modes.mode }}</strong></span>
        <span>{{ t('memory.skills.auto_publish') }} <strong>{{ modes.auto_publish_mode }}</strong></span>
        <span>Canary <strong>{{ modes.canary_mode }}</strong></span>
      </div>
      <p v-if="actionError" class="memory-error" role="alert" data-testid="skill-action-error">{{ actionError }}</p>
      <p v-if="success" role="status" class="memory-skill-success">{{ success }}</p>
      <div class="memory-skill-layout">
        <aside class="memory-skill-index" :aria-label="t('memory.skills.library')">
          <section><h2>{{ t('memory.skills.library') }}</h2>
            <p v-if="loading" role="status" data-testid="skill-loading">{{ t('memory.skills.loading') }}</p>
            <div v-else-if="listError" role="alert" data-testid="skill-list-error"><p class="memory-error">{{ listError }}</p><button class="memory-button" @click="loadSkills()">{{ t('memory.skills.retry') }}</button></div>
            <p v-else-if="!skills.length" class="memory-skill-muted" data-testid="skill-empty">{{ t('memory.skills.empty') }}</p>
            <button v-for="skill in skills" :key="skill.skill_id" type="button" class="memory-skill-row" :class="{ selected: selectedId === skill.skill_id }"
              :disabled="busy" :aria-pressed="selectedId === skill.skill_id" :data-testid="`skill-select-${skill.skill_id}`" @click="selectSkill(skill.skill_id)">
              <strong>{{ skill.title }}</strong><span>{{ skill.state }} · v{{ skill.version_number }} · {{ skill.risk }}</span>
            </button>
            <button v-if="nextCursor" class="memory-button" :disabled="loading || busy" data-testid="skill-more" @click="loadSkills(true)">{{ t('memory.skills.load_more') }}</button>
          </section>
          <section><h2>{{ t('memory.skills.candidates') }}</h2>
            <p v-if="candidateLoading" role="status">{{ t('memory.skills.loading') }}</p>
            <div v-else-if="candidateError" role="alert"><p class="memory-error">{{ candidateError }}</p><button class="memory-button" @click="loadCandidates()">{{ t('memory.skills.retry') }}</button></div>
            <p v-else-if="!candidates.length" class="memory-skill-muted">{{ t('memory.skills.no_candidates') }}</p>
            <button v-for="item in candidates" :key="item.candidate_id" type="button" class="memory-skill-row" :disabled="busy"
              :aria-pressed="candidate?.candidate_id === item.candidate_id" :data-testid="`skill-candidate-${item.candidate_id}`" @click="selectCandidate(item)">
              <strong>{{ item.document.title }}</strong><span>candidate · g{{ item.generation }} · {{ item.risk }}</span>
            </button>
            <button v-if="candidateCursor" class="memory-button" :disabled="candidateLoading || busy" @click="loadCandidates(true)">{{ t('memory.skills.load_more') }}</button>
          </section>
        </aside>
        <div class="memory-skill-main" aria-live="polite">
          <p v-if="detailLoading" role="status">{{ t('memory.skills.loading') }}</p>
          <div v-if="detailError" role="alert" data-testid="skill-detail-error"><p class="memory-error">{{ detailError }}</p><button class="memory-button" @click="selectSkill(selectedId)">{{ t('memory.skills.retry') }}</button></div>
          <p v-if="!detail && !candidate && !detailLoading && !detailError" class="memory-skill-placeholder">{{ t('memory.skills.select') }}</p>
          <article v-if="candidate" data-testid="skill-candidate-detail">
            <header><p class="memory-eyebrow">candidate · g{{ candidate.generation }}</p><h2>{{ candidate.document.title }}</h2></header>
            <p v-if="candidate.risk !== 'low'" class="memory-skill-warning">{{ t('memory.skills.manual_review') }}</p>
            <p>{{ candidate.risk_reasons.join(' · ') }}</p>
            <MemorySkillDocumentView :document="candidate.document" />
            <p class="memory-skill-muted">{{ t('memory.skills.evidence') }} <code>{{ candidate.document.source_tokens.join(', ') }}</code></p>
            <button v-if="candidate.can_draft" class="memory-button is-primary" :disabled="busy" data-testid="skill-draft" @click="draftCandidate">{{ t('memory.skills.create_draft') }}</button>
            <p v-else class="memory-skill-muted">{{ t('memory.skills.read_only') }}</p>
          </article>
          <article v-if="detail" data-testid="skill-detail">
            <header class="memory-skill-detail-head"><div><p class="memory-eyebrow">{{ detail.state }} · v{{ detail.version_number }} · r{{ detail.revision }}</p><h2>{{ detail.title }}</h2></div><span class="memory-skill-risk" :data-risk="detail.risk">{{ detail.risk }}</span></header>
            <p v-if="detail.risk !== 'low'" class="memory-skill-warning" data-testid="skill-manual-review">{{ t('memory.skills.manual_review') }}</p>
            <p v-if="detail.risk_reasons.length">{{ detail.risk_reasons.join(' · ') }}</p>
            <dl class="memory-skill-provenance"><dt>{{ t('memory.skills.version') }}</dt><dd>{{ detail.version_id }}</dd><dt>{{ t('memory.skills.document_hash') }}</dt><dd>{{ detail.document_hash }}</dd><dt>{{ t('memory.skills.source_digest') }}</dt><dd>{{ detail.source_digest }}</dd><dt>{{ t('memory.skills.policy_hash') }}</dt><dd>{{ detail.policy_hash }}</dd></dl>
            <div class="memory-skill-actions">
              <button v-if="permissions?.can_edit && !editing" class="memory-button" :disabled="busy" data-testid="skill-edit" @click="beginEdit">{{ t('memory.skills.edit') }}</button>
              <template v-if="permissions?.can_review"><label>{{ t('memory.skills.review_outcome') }}<select v-model="reviewOutcome" :disabled="busy || editing" data-testid="skill-review-outcome"><option value="">{{ t('memory.skills.choose_review_outcome') }}</option><option v-for="outcome in reviewOutcomes" :key="outcome" :value="outcome">{{ t(`memory.skills.${outcome}`) }}</option></select></label><button v-for="action in reviewActions" :key="action" class="memory-button" :disabled="busy || editing || (action === 'approve' && !reviewOutcome)" :data-testid="`skill-${action}`" @click="review(action)">{{ t(`memory.skills.${action}`) }}</button></template>
              <button v-if="permissions?.can_revoke" class="memory-button is-danger" :disabled="busy || editing" data-testid="skill-revoke" @click="requestConfirmation('revoke')">{{ t('memory.skills.revoke') }}</button>
            </div>
            <p v-if="editing" class="memory-skill-warning" data-testid="skill-edit-pending">{{ t('memory.skills.edit_pending') }}</p>
            <MemorySkillEditor v-if="editing && permissions?.can_edit" :document="detail.document" :busy="busy" @save="saveDocument" @cancel="editing = false" />
            <MemorySkillDocumentView v-else :document="detail.document" />
            <section class="memory-skill-section"><h3>{{ t('memory.skills.evidence') }}</h3>
              <dl v-for="source in detail.sources" :key="source.token" class="memory-skill-provenance" data-testid="skill-evidence"><dt>{{ source.token }}</dt><dd>{{ source.handle }}</dd><dt>SHA</dt><dd>{{ source.excerpt_hash }}</dd><dt>{{ t('memory.skills.evidence_id') }}</dt><dd>{{ source.evidence_id ?? source.event_id ?? source.artifact_id ?? '—' }}</dd></dl>
            </section>
            <section class="memory-skill-section"><h3>{{ t('memory.skills.versions') }}</h3>
              <ol class="memory-skill-version-list"><li v-for="version in detail.versions" :key="version.version_id">v{{ version.version_number }} · {{ version.risk }} <code>{{ version.version_id }}</code></li></ol>
              <div v-if="priorVersions.length" class="memory-skill-actions"><label>{{ t('memory.skills.compare_from') }}<select v-model="fromVersion" data-testid="skill-diff-from"><option v-for="version in priorVersions" :key="version.version_id" :value="version.version_id">v{{ version.version_number }}</option></select></label>
                <button class="memory-button" :disabled="busy" data-testid="skill-diff" @click="compare">{{ t('memory.skills.compare') }}</button></div>
              <div v-if="diff" data-testid="skill-diff-result"><p class="memory-skill-muted"><code>{{ diff.from_version_id }}</code> → <code>{{ diff.to_version_id }}</code></p><p v-if="!diff.changes.length">{{ t('memory.skills.no_changes') }}</p><div v-for="change in diff.changes" :key="change.field" class="memory-skill-diff"><h4>{{ t(`memory.skills.${change.field}`) }}</h4><div><pre>{{ stringify(change.before) }}</pre><pre>{{ stringify(change.after) }}</pre></div></div></div>
            </section>
            <section class="memory-skill-section" data-testid="skill-replay-summary"><h3>Replay <span class="memory-skill-muted">{{ detail.replay.state }}</span></h3>
              <table><thead><tr><th>{{ t('memory.skills.case_kind') }}</th><th>{{ t('memory.skills.total') }}</th><th>{{ t('memory.skills.passed') }}</th><th>{{ t('memory.skills.failed') }}</th><th>{{ t('memory.skills.pending') }}</th><th>{{ t('memory.skills.cancelled') }}</th></tr></thead>
                <tbody><tr v-for="kind in replayKinds" :key="kind"><th>{{ t(`memory.skills.${kind}`) }}</th><td>{{ detail.replay.kinds[kind].total }}</td><td>{{ detail.replay.kinds[kind].passed }}</td><td>{{ detail.replay.kinds[kind].failed }}</td><td>{{ detail.replay.kinds[kind].pending }}</td><td>{{ detail.replay.kinds[kind].cancelled }}</td></tr></tbody></table>
              <p class="memory-skill-muted">{{ t('memory.skills.fixture') }} {{ detail.replay.provenance.fixture }} · {{ t('memory.skills.recorded') }} {{ detail.replay.provenance.recorded }} · {{ t('memory.skills.natural_executions') }} {{ detail.replay.natural_execution_count }}</p>
              <p class="memory-skill-muted">{{ t('memory.skills.fixture_notice') }}</p><p v-if="detail.replay.error_code" class="memory-error">{{ detail.replay.error_code }}</p>
              <p v-if="casesError" role="alert" class="memory-error">{{ casesError }}</p>
              <fieldset v-if="permissions?.can_replay" :disabled="busy || editing"><legend>{{ t('memory.skills.select_cases') }}</legend>
                <label v-for="item in cases" :key="item.case_id" class="memory-skill-case"><input v-model="selectedCases" type="checkbox" :value="item.case_id" :data-testid="`skill-case-${item.case_id}`" /><span>{{ item.case_id }} · {{ t(`memory.skills.${item.kind}`) }} · {{ item.provenance }}</span></label>
                <p v-if="!cases.length && !casesError" class="memory-skill-muted">{{ t('memory.skills.no_cases') }}</p>
                <button class="memory-button" :disabled="busy || editing || !selectedCases.length" data-testid="skill-replay" @click="replay">{{ t('memory.skills.run_replay') }}</button>
              </fieldset>
            </section>
            <section class="memory-skill-section" data-testid="skill-publication"><h3>{{ t('memory.skills.publication') }}</h3>
              <p>{{ t('memory.skills.independent_successes') }} {{ detail.eligibility?.independent_successes ?? '—' }} / {{ detail.eligibility?.required_independent_successes ?? '—' }}</p>
              <p v-if="detail.eligibility?.product_gate !== 'open'" class="memory-skill-warning">{{ t('memory.skills.product_gate_closed') }}</p>
              <ul v-if="blockedReasons.length"><li v-for="reason in blockedReasons" :key="reason">{{ reason }}</li></ul>
              <p v-if="!permissions?.can_publish" class="memory-skill-muted">{{ t('memory.skills.publish_unavailable') }}</p>
              <button v-if="permissions?.can_publish" class="memory-button is-primary" :disabled="busy || editing || !detail.eligibility?.manual_eligible" data-testid="skill-publish" @click="requestConfirmation('publish')">{{ t('memory.skills.publish_manual') }}</button>
              <pre v-if="detail.publication">{{ stringify(detail.publication) }}</pre>
              <label>{{ t('memory.skills.rollback_target') }}<select v-model="rollbackTarget" :disabled="busy || editing || !permissions?.can_rollback" data-testid="skill-rollback-target"><option value="">{{ t('memory.skills.choose_version') }}</option><option v-for="version in priorVersions" :key="version.version_id" :value="version.version_id">v{{ version.version_number }} · {{ version.version_id }}</option></select></label>
              <button v-if="permissions?.can_rollback" class="memory-button" :disabled="busy || editing || !rollbackTarget" data-testid="skill-rollback" @click="requestConfirmation('rollback')">{{ t('memory.skills.rollback_action') }}</button>
              <p v-else class="memory-skill-muted">{{ t('memory.skills.rollback_unavailable') }}</p>
            </section>
            <section class="memory-skill-section"><h3>{{ t('memory.skills.executions') }}</h3><p v-if="!detail.executions.length" class="memory-skill-muted">{{ t('memory.skills.no_executions') }}</p><pre v-for="(execution, index) in detail.executions" :key="index" data-testid="skill-execution">{{ stringify(execution) }}</pre></section>
            <div v-if="confirmation" class="memory-skill-confirm" role="alertdialog" aria-modal="false" :aria-label="t('memory.skills.confirm_title')" data-testid="skill-confirmation">
              <h3>{{ t('memory.skills.confirm_title') }}</h3><p>{{ t(`memory.skills.${confirmation}_confirm`) }}</p><code>{{ detail.version_id }} · r{{ detail.revision }}</code>
              <div class="memory-skill-actions"><button class="memory-button is-primary" :disabled="busy || editing" data-testid="skill-confirm" @click="confirmAction">{{ t('memory.skills.confirm') }}</button><button class="memory-button" @click="confirmation = null">{{ t('memory.skills.cancel') }}</button></div>
            </div>
          </article>
        </div>
      </div>
      <details class="memory-skill-policy"><summary>{{ t('memory.skills.policy') }}</summary>
        <p v-if="policyLoading">{{ t('memory.skills.loading') }}</p><div v-if="policyError" role="alert"><p class="memory-error" data-testid="skill-policy-error">{{ policyError }}</p><button class="memory-button" @click="loadPolicy">{{ t('memory.skills.retry') }}</button></div>
        <form v-if="policyState && policyDraft" @submit.prevent="savePolicy"><p>r{{ policyState.revision }} · <code>{{ policyState.hash }}</code></p>
          <fieldset :disabled="!policyState.can_manage_policy || busy"><legend>{{ t('memory.skills.policy_limits') }}</legend>
            <label>{{ t('memory.skills.minimum_successes') }}<input v-model.number="policyDraft.minimum_independent_successes" type="number" min="2" max="100" required data-testid="skill-policy-minimum" /></label>
            <label>{{ t('memory.skills.auto_publish') }}<select v-model="policyDraft.auto_mode"><option>off</option><option>shadow</option></select></label>
            <label>Canary<select v-model="policyDraft.canary_mode"><option>off</option><option>shadow</option></select></label>
          </fieldset><button v-if="policyState.can_manage_policy" class="memory-button" :disabled="busy || editing" data-testid="skill-policy-save">{{ t('memory.skills.save_policy') }}</button>
          <p v-else class="memory-skill-muted">{{ t('memory.skills.read_only') }}</p>
        </form>
      </details>
    </template>
  </section>
</template>

<style scoped>
.memory-skills-workspace{padding:20px;color:var(--fg);font-size:13px;line-height:1.6}
.memory-skill-toolbar,.memory-skill-actions,.memory-skill-fields,.memory-skill-detail-head{display:flex;align-items:end;gap:12px;flex-wrap:wrap}
.memory-skill-toolbar{padding-bottom:16px}.memory-skill-toolbar label:first-child{flex:1;min-width:180px}
.memory-skills-workspace :deep(label){display:flex;flex-direction:column;gap:6px;color:var(--fg-secondary)}
.memory-skills-workspace :deep(input:not([type=checkbox])),.memory-skills-workspace :deep(select),.memory-skills-workspace :deep(textarea){box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
.memory-skills-workspace :deep(textarea){resize:vertical}.memory-skills-workspace :deep(button:disabled){opacity:.5;cursor:not-allowed}
.memory-skill-modes{display:flex;gap:24px;padding:10px 0 20px;color:var(--fg-secondary);border-bottom:1px solid var(--border)}
.memory-skill-modes strong{font-weight:500;color:var(--fg);margin-left:6px}
.memory-skill-layout{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);min-height:380px}
.memory-skill-index{border-right:1px solid var(--border);padding:20px 16px 20px 0}.memory-skill-index section+section{margin-top:28px}
.memory-skills-workspace h2{font-size:17px;margin:0 0 12px}.memory-skills-workspace h3{font-size:14px;margin:0 0 10px}
.memory-skill-index h2{font-size:12px;color:var(--fg-secondary);font-weight:500}
.memory-skill-row{display:block;width:100%;padding:12px 10px;margin-bottom:6px;text-align:left;background:transparent;border:1px solid transparent;border-radius:6px;color:var(--fg);cursor:pointer}
.memory-skill-row strong,.memory-skill-row span{display:block}.memory-skill-row strong{font-size:13px;font-weight:500}.memory-skill-row span{font-size:11px;color:var(--fg-secondary);margin-top:5px}
.memory-skill-row:hover,.memory-skill-row.selected{background:var(--bg-secondary);border-color:var(--border)}
.memory-skill-main{padding:24px;min-width:0}.memory-skill-placeholder{padding:80px 20px;text-align:center;color:var(--fg-secondary)}
.memory-skill-muted,.memory-skills-workspace :deep(small){color:var(--fg-secondary)}.memory-skill-success{color:var(--success)}
.memory-skill-detail-head{align-items:center;justify-content:space-between}.memory-skill-risk{padding:3px 10px;border:1px solid var(--border);border-radius:4px}.memory-skill-risk[data-risk=high],.memory-skill-warning{color:var(--warning)}
.memory-skill-provenance{display:grid;grid-template-columns:100px minmax(0,1fr);gap:4px 12px;font-size:11px}.memory-skill-provenance dt{color:var(--fg-secondary)}.memory-skill-provenance dd{margin:0;overflow-wrap:anywhere;font-family:monospace}
.memory-skills-workspace :deep(.memory-skill-document){display:grid;gap:18px;margin-top:24px}.memory-skills-workspace :deep(.memory-skill-document p){white-space:pre-wrap;margin:4px 0}.memory-skills-workspace :deep(.memory-skill-document ul),.memory-skills-workspace :deep(.memory-skill-document ol){padding-left:20px;margin:0}
.memory-skill-section{border-top:1px solid var(--border);margin-top:24px;padding-top:20px}.memory-skill-actions{margin:14px 0}
.memory-skills-workspace pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;background:var(--bg-secondary);padding:12px;border-radius:6px}.memory-skills-workspace code{font-size:11px;overflow-wrap:anywhere}
.memory-skill-diff>div{display:grid;grid-template-columns:1fr 1fr;gap:10px}.memory-skill-diff pre:first-child{border-left:2px solid #a85f58}.memory-skill-diff pre:last-child{border-left:2px solid #5d9172}
.memory-skill-version-list{padding-left:18px}.memory-skill-version-list code{display:block;color:var(--fg-secondary)}
.memory-skills-workspace table{border-collapse:collapse;width:100%;font-size:11px}.memory-skills-workspace th,.memory-skills-workspace td{text-align:left;padding:8px 4px;border-bottom:1px solid var(--border)}
.memory-skills-workspace :deep(fieldset){border:1px solid var(--border);border-radius:6px;padding:12px;margin:12px 0}.memory-skills-workspace :deep(legend){color:var(--fg-secondary);padding:0 6px}
.memory-skills-workspace label.memory-skill-case{flex-direction:row;align-items:center;margin:8px 0}.memory-skill-case input{accent-color:var(--accent)}
.memory-skill-confirm{border:1px solid var(--border);padding:20px;background:var(--bg-secondary);margin-top:20px;border-radius:8px}
.memory-skill-policy{border-top:1px solid var(--border);padding-top:20px}.memory-skill-policy summary{cursor:pointer}.memory-skill-policy form{max-width:640px}.memory-skill-policy fieldset{display:grid;grid-template-columns:2fr 1fr 1fr;gap:16px}
.memory-skills-workspace :deep(.memory-skill-editor){margin-top:20px;display:grid;gap:12px}.memory-skills-workspace :deep(.memory-skill-fields)>*{flex:1}
@media(max-width:760px){.memory-skills-workspace{padding:12px}.memory-skill-layout{grid-template-columns:1fr}.memory-skill-index{border-right:0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr;gap:12px;padding-right:0}.memory-skill-index section+section{margin-top:0}.memory-skill-main{padding:20px 0}.memory-skill-modes{gap:12px;flex-wrap:wrap}.memory-skill-diff>div{grid-template-columns:1fr}.memory-skill-policy fieldset{grid-template-columns:1fr}.memory-skill-provenance{grid-template-columns:80px minmax(0,1fr)}}
</style>
