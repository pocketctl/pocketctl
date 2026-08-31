<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{
  candidates: Array<{ candidate_id: string; normalized_key: string }>
  claims: Array<{ candidate_id: string; claim_id: string; statement: string; conflict_variant: number }>
}>()
const emit = defineEmits<{
  (e: 'resolve', input: { candidateId: string; resolution: 'parallel' | 'supersede'; claimIds: string[] }): void
}>()
const { t } = useLocale()
const selectedCandidateId = ref(props.candidates[0]?.candidate_id ?? '')
const resolution = ref<'parallel' | 'supersede' | ''>('')
const namedClaims = ref<string[]>([])
const selectedCandidate = computed(() => props.candidates.find(
  candidate => candidate.candidate_id === selectedCandidateId.value) ?? null)
const visibleClaims = computed(() => props.claims.filter(
  claim => claim.candidate_id === selectedCandidateId.value))

watch(() => props.candidates, candidates => {
  if (!candidates.some(candidate => candidate.candidate_id === selectedCandidateId.value)) {
    selectedCandidateId.value = candidates[0]?.candidate_id ?? ''
  }
}, { deep: true })
watch(selectedCandidateId, () => {
  resolution.value = ''
  namedClaims.value = []
})
</script>

<template>
  <section class="memory-conflict-panel">
    <h3>{{ t('memory.governance.conflict.title') }}</h3>
    <p class="memory-governance-muted">{{ t('memory.governance.conflict.copyBoundary') }}</p>
    <label v-if="candidates.length > 1" class="memory-conflict-candidate">
      <span>{{ t('memory.governance.conflict.title') }}</span>
      <select v-model="selectedCandidateId">
        <option v-for="candidate in candidates" :key="candidate.candidate_id"
          :value="candidate.candidate_id">{{ candidate.normalized_key }}</option>
      </select>
    </label>
    <div class="memory-conflict-options">
      <label>
        <input type="radio" value="parallel" v-model="resolution">
        {{ t('memory.governance.conflict.parallel') }}
      </label>
      <label>
        <input type="radio" value="supersede" v-model="resolution">
        {{ t('memory.governance.conflict.supersede') }}
      </label>
    </div>
    <fieldset v-if="resolution === 'supersede'" class="memory-conflict-claims">
      <legend>{{ t('memory.governance.conflict.nameClaims') }}</legend>
      <label v-for="claim in visibleClaims" :key="claim.claim_id">
        <input type="checkbox" :value="claim.claim_id" v-model="namedClaims">
        <span>#{{ claim.conflict_variant }} {{ claim.statement.slice(0, 60) }}</span>
      </label>
    </fieldset>
    <footer class="memory-governance-actions">
      <button type="button"
              :disabled="resolution === '' || (resolution === 'supersede' && namedClaims.length === 0)"
              @click="emit('resolve', {
                candidateId: selectedCandidate!.candidate_id,
                resolution: resolution as 'parallel' | 'supersede',
                claimIds: [...namedClaims],
              })">
        {{ t('memory.governance.conflict.resolve') }}
      </button>
    </footer>
  </section>
</template>
