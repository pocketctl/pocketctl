<template>
  <div class="maintenance-summary" data-testid="maintenance-summary">
    <strong>{{ t(`attention.maintenance.${summary.state}`) }}</strong>
    <p>{{ t('attention.maintenance.duration', { seconds: summary.duration_seconds }) }}</p>
    <p v-for="[key, value] in entries" :key="key">{{ t(`attention.maintenance.count.${key}`, { count: value }) }}</p>
    <p v-if="summary.pending_installations">{{ t('attention.maintenance.pending', { count: summary.pending_installations }) }}</p>
    <p v-if="summary.failed_installations">{{ t('attention.maintenance.failed', { count: summary.failed_installations }) }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MaintenanceSummary } from '../../types/attentionInbox'
const props=defineProps<{summary:MaintenanceSummary}>()
const {t}=useLocale()
const keys=['session_archive','session_cool','session_purge','session_resume','candidates_expired','inbox_body','inbox_metadata','source_events','source_artifacts','source_snapshots','source_candidates','source_episodes','inbox_metadata_blocked','source_migration_protected','source_skipped','inbox_skipped_snapshot','inbox_skipped_inactive','inbox_skipped_unacknowledged']
const entries=computed(()=>keys.filter(k=>props.summary.counts[k]>0).map(k=>[k,props.summary.counts[k]] as const))
</script>
<style scoped>
.maintenance-summary { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); }
.maintenance-summary p { margin: 6px 0; font-size: 13px; color: var(--fg-secondary); }
</style>
