<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MemoryReviewPolicyDocument } from '../../types/memory'

const props = defineProps<{
  document: MemoryReviewPolicyDocument | null
  revision: number
  canEdit: boolean
}>()
const emit = defineEmits<{
  (e: 'save', input: { document: MemoryReviewPolicyDocument; expectedRevision: number }): void
  (e: 'rollback', targetVersionId: string): void
}>()
const { t } = useLocale()
const draft = ref<MemoryReviewPolicyDocument | null>(props.document)
watch(() => props.document, value => { draft.value = value ? { ...value } : null })
const floor = props.document?.minimum_approvals ?? 1
</script>

<template>
  <section class="memory-review-policy-editor">
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
        <button type="button" :disabled="!canEdit"
                @click="emit('save', { document: { ...draft! }, expectedRevision: revision })">
          {{ t('common.save') }}
        </button>
      </footer>
    </template>
  </section>
</template>
