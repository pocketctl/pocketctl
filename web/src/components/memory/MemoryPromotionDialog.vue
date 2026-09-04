<script setup lang="ts">
import { ref, computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MemoryClaimDetail } from '../../types/memory'

const props = defineProps<{
  claim: MemoryClaimDetail | null
  evidence: Array<{ evidence_id: string; excerpt: string }>
  targets: Array<{ installation_id: string; owner_scope_kind: string }>
}>()
const emit = defineEmits<{
  (e: 'confirm', input: { targetInstallationId: string; evidenceIds: string[] }): void
  (e: 'cancel'): void
}>()
const { t } = useLocale()
const selectedTarget = ref('')
const selectedEvidence = ref<string[]>([])
const confirmed = ref(false)
const evidenceItems = computed(() => props.evidence.slice(0, 8))
function toggleEvidence(id: string) {
  const index = selectedEvidence.value.indexOf(id)
  if (index >= 0) selectedEvidence.value.splice(index, 1)
  else if (selectedEvidence.value.length < 8) selectedEvidence.value.push(id)
}
const canConfirm = computed(() => selectedTarget.value !== '' && selectedEvidence.value.length >= 1)
</script>

<template>
  <div v-if="claim" class="memory-promotion-dialog" role="dialog" aria-modal="true"
       :aria-label="t('memory.governance.promotion.title')">
    <h3>{{ t('memory.governance.promotion.title') }}</h3>
    <p class="memory-governance-muted">{{ t('memory.governance.promotion.copyBoundary') }}</p>
    <label class="memory-promotion-target">
      {{ t('memory.governance.promotion.target') }}
      <select v-model="selectedTarget">
        <option value="" disabled>{{ t('memory.governance.promotion.selectTarget') }}</option>
        <option v-for="target in targets" :key="target.installation_id" :value="target.installation_id">
          {{ target.owner_scope_kind }} · {{ target.installation_id.slice(0, 8) }}
        </option>
      </select>
    </label>
    <fieldset class="memory-promotion-evidence">
      <legend>{{ t('memory.governance.promotion.evidence') }}</legend>
      <label v-for="item in evidenceItems" :key="item.evidence_id">
        <input type="checkbox" :value="item.evidence_id" :checked="selectedEvidence.includes(item.evidence_id)"
               @change="toggleEvidence(item.evidence_id)">
        <span>{{ item.excerpt.slice(0, 80) }}</span>
      </label>
    </fieldset>
    <label class="memory-promotion-confirm">
      <input type="checkbox" v-model="confirmed">
      {{ t('memory.governance.promotion.confirmCopy') }}
    </label>
    <footer class="memory-governance-actions">
      <button type="button" @click="emit('cancel')">{{ t('common.cancel') }}</button>
      <button type="button" :disabled="!canConfirm || !confirmed"
              @click="emit('confirm', { targetInstallationId: selectedTarget, evidenceIds: [...selectedEvidence] })">
        {{ t('memory.governance.promotion.confirm') }}
      </button>
    </footer>
  </div>
</template>
