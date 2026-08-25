<template>
  <section class="memory-panel" data-testid="memory-claim-detail">
    <p v-if="!detail" class="empty">{{ t('memory.select_claim') }}</p>
    <template v-else>
      <header>
        <strong data-testid="memory-claim-state">{{ detail.claim.state }}</strong>
        <span class="type">{{ detail.claim.claim_type }}</span>
        <span class="meta" data-testid="memory-claim-scope">
          {{ detail.claim.scope_kind }} · {{ detail.claim.scope_key }}
        </span>
      </header>
      <ol class="versions" data-testid="memory-claim-versions">
        <li v-for="version in detail.versions" :key="version.version_id"
          :class="{ current: version.version_id === detail.claim.current_version_id }">
          <p class="statement" :data-testid="`memory-version-${version.version_id}`">{{ version.statement }}</p>
          <pre v-if="Object.keys(version.structured_content || {}).length" class="structured"
            :data-testid="`memory-version-structured-${version.version_id}`">{{ JSON.stringify(version.structured_content, null, 2) }}</pre>
          <p class="meta">v{{ version.version_number }} · {{ version.authority }} · {{ version.freshness_at ?? '' }}<template v-if="version.branch"> · {{ version.branch }}</template></p>
        </li>
      </ol>
      <button v-if="detail.next_version_cursor" type="button" data-testid="memory-claim-load-older" @click="loadOlder">
        {{ t('memory.load_older_versions') }}
      </button>
      <EvidencePanel v-if="detail.claim.current_version_id" :version-id="detail.claim.current_version_id" />
      <div class="actions">
        <button type="button" data-testid="memory-claim-correct" @click="correcting = !correcting">{{ t('memory.correct') }}</button>
        <button type="button" data-testid="memory-claim-revoke" @click="revoke">{{ t('memory.revoke') }}</button>
        <button type="button" class="danger" data-testid="memory-claim-delete" @click="confirmDelete = true">{{ t('memory.delete') }}</button>
      </div>
      <div v-if="correcting" class="edit-row">
        <textarea v-model="correctedStatement" rows="3" data-testid="memory-correct-statement" />
        <button type="button" data-testid="memory-correct-save" @click="correct">{{ t('common.save') }}</button>
      </div>
      <div v-if="confirmDelete" class="confirm-box" data-testid="memory-delete-confirm">
        <p>{{ t('memory.delete_warning') }}</p>
        <button type="button" class="danger" data-testid="memory-delete-confirm-yes" @click="erase">{{ t('common.confirm') }}</button>
        <button type="button" @click="confirmDelete = false">{{ t('common.cancel') }}</button>
      </div>
      <p v-if="error" class="error" data-testid="memory-claim-error">{{ error }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  correctMemoryClaim,
  deleteMemoryClaim,
  getMemoryClaim,
  listVersionEvidence,
  revokeMemoryClaim,
} from '../../services/memoryClient'
import type { MemoryClaimDetail } from '../../types/memory'
import EvidencePanel from './EvidencePanel.vue'

const { t } = useLocale()
const props = defineProps<{ claimId: string | null }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const detail = ref<MemoryClaimDetail | null>(null)
const correcting = ref(false)
const correctedStatement = ref('')
const confirmDelete = ref(false)
const error = ref('')

watch(() => props.claimId, load, { immediate: true })

async function load(): Promise<void> {
  error.value = ''
  confirmDelete.value = false
  correcting.value = false
  if (!props.claimId) {
    detail.value = null
    return
  }
  try {
    detail.value = await getMemoryClaim(props.claimId)
    correctedStatement.value = detail.value.versions.at(-1)?.statement ?? ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'load failed'
  }
}

async function loadOlder(): Promise<void> {
  if (!detail.value?.next_version_cursor) return
  try {
    const older = await getMemoryClaim(detail.value.claim.claim_id, detail.value.next_version_cursor)
    detail.value = {
      ...detail.value,
      versions: [...older.versions, ...detail.value.versions],
      next_version_cursor: older.next_version_cursor,
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'load failed'
  }
}

async function correct(): Promise<void> {
  if (!detail.value) return
  try {
    // Corrections keep the claim's evidence: carry the current version's
    // rows forward instead of submitting an empty set.
    const currentEvidence = detail.value.claim.current_version_id
      ? await listVersionEvidence(detail.value.claim.current_version_id)
      : []
    await correctMemoryClaim(
      detail.value.claim.claim_id,
      Number(detail.value.claim.revision),
      correctedStatement.value.trim(),
      currentEvidence.map(item => ({
        evidence_kind: item.evidence_kind as 'event' | 'artifact' | 'episode',
        episode_id: item.episode_id,
        source_event_id: item.source_event_id,
        artifact_id: item.artifact_id,
        locator: item.locator,
        excerpt: item.excerpt,
        occurred_at: item.occurred_at,
      })),
      `web-correct-${detail.value.claim.claim_id}-${Date.now()}`,
    )
    await load()
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'correct failed'
  }
}

async function revoke(): Promise<void> {
  if (!detail.value) return
  try {
    await revokeMemoryClaim(
      detail.value.claim.claim_id,
      Number(detail.value.claim.revision),
      `web-revoke-${detail.value.claim.claim_id}-${Date.now()}`,
    )
    await load()
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'revoke failed'
  }
}

async function erase(): Promise<void> {
  if (!detail.value) return
  try {
    await deleteMemoryClaim(
      detail.value.claim.claim_id,
      Number(detail.value.claim.revision),
      `web-delete-${detail.value.claim.claim_id}-${Date.now()}`,
    )
    confirmDelete.value = false
    detail.value = null
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'delete failed'
  }
}
</script>
