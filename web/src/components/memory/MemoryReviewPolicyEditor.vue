<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MemoryReviewPolicyDocument } from '../../types/memory'

const props = defineProps<{
  document: MemoryReviewPolicyDocument | null
  revision: number
  canEdit: boolean
  automationPolicy?:import('../../types/memory').MemoryAutomationPolicyState|null
}>()
const emit = defineEmits<{
  (e: 'save-automation',document:NonNullable<import('../../types/memory').MemoryAutomationPolicyState['document']>):void
  (e: 'save', input: { document: MemoryReviewPolicyDocument; expectedRevision: number }): void
  (e: 'rollback', targetVersionId: string): void
}>()
const { t } = useLocale()
const draft = ref<MemoryReviewPolicyDocument | null>(props.document)
watch(() => props.document, value => { draft.value = value ? { ...value } : null })
const automationMode=ref<'off'|'shadow'|'assist'>(props.automationPolicy?.document?.mode??'off')
watch(()=>props.automationPolicy,p=>{automationMode.value=p?.document?.mode??'off'})
const automationModel=ref(props.automationPolicy?.document?.model??'')
watch(()=>props.automationPolicy,p=>{automationModel.value=p?.document?.model??''})
const floor = props.document?.minimum_approvals ?? 1
</script>

<template>
  <section class="memory-review-policy-editor">
    <template v-if="automationPolicy">
      <p class="memory-governance-muted">{{ t('memory.governance.automation.mode') }}: {{ automationPolicy.effective_mode }} · {{ t('memory.governance.automation.adviceOnly') }}</p>
      <label class="memory-policy-field">{{ t('memory.governance.automation.policyMode') }}<select v-model="automationMode" :disabled="!canEdit"><option value="off">off</option><option value="shadow">shadow</option><option value="assist">assist</option></select></label>
      <label class="memory-policy-field">{{ t('memory.governance.automation.model') }}<input v-model="automationModel" maxlength="200" :disabled="!canEdit"/></label>
      <button class="memory-button" type="button" :disabled="!canEdit||!automationModel.trim()" @click="emit('save-automation',{...(automationPolicy.document??{promptVersion:'review-v1'}),mode:automationMode,model:automationModel})">{{ t('common.save') }}</button>
    </template>
    <p v-if="!draft" class="memory-governance-muted">{{ t('memory.governance.policy.empty') }}</p>
    <template v-else>
      <label class="memory-policy-field">
        {{ t('memory.governance.policy.minimumApprovals') }}
        <input type="number" v-model.number="draft.minimum_approvals" :min="floor" max="10"
               :disabled="!canEdit">
      </label>
      <label class="memory-policy-field">
        {{ t('memory.governance.policy.ttlDays') }}
        <input type="number" v-model.number="draft.candidate_ttl_days" min="1" max="365" :disabled="!canEdit">
      </label>
      <label class="memory-policy-field">
        {{ t('memory.governance.policy.maxEvidence') }}
        <input type="number" v-model.number="draft.max_shared_evidence" min="1" max="8" :disabled="!canEdit">
      </label>
      <p class="memory-governance-muted">{{ t('memory.governance.policy.floor') }}</p>
      <footer class="memory-governance-actions">
        <button class="memory-button" type="button" :disabled="!canEdit"
                @click="emit('save', { document: { ...draft! }, expectedRevision: revision })">
          {{ t('common.save') }}
        </button>
      </footer>
    </template>
  </section>
</template>
