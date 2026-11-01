<template>
  <button type="button" class="notification-row" :class="{ selected, unread: !item.read_at }" :data-notification-id="item.notification_id" @click="$emit('select')">
    <span class="notification-mark" aria-hidden="true">i</span>
    <span class="notification-copy"><small>{{ t('attention.notification.system') }} · {{ t('attention.notification.no_action') }}</small>
      <strong>{{ t(item.maintenance ? 'attention.maintenance.title' : 'attention.notification.title') }}</strong>
      <span v-if="item.maintenance">{{ t(`attention.maintenance.${item.maintenance.state}`) }}</span>
      <span v-else>{{ item.subject_preview.map(subject => subject.title).join(' · ') || t('attention.notification.title') }}</span>
      <small>{{ t('attention.notification.subject_count', { count: item.subject_count }) }} · {{ new Date(item.created_at).toLocaleString() }}</small>
    </span>
    <span class="read-state">{{ t(item.read_at ? 'attention.notification.read' : 'attention.notification.unread') }}</span>
  </button>
</template>
<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import type { SystemNotification } from '../../types/attentionInbox'
defineProps<{ item: SystemNotification; selected?: boolean }>()
defineEmits<{ (event: 'select'): void }>()
const { t } = useLocale()
</script>
<style scoped>
.notification-row { display: flex; width: 100%; gap: 12px; padding: 15px 14px; border: 1px solid transparent; border-radius: var(--radius-md); text-align: left; color: var(--fg); background: transparent; cursor: pointer; }
.notification-row:hover { background: var(--surface-hover); }.notification-row.selected { border-color: var(--accent-muted); background: var(--accent-subtle); }
.notification-mark { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 10px; color: var(--accent); background: var(--accent-muted); font-weight: 700; }
.notification-copy { min-width: 0; display: grid; gap: 8px; flex: 1; }.notification-copy strong { font-size: 14px; }.notification-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--fg-secondary); }.notification-copy small { color: var(--fg-tertiary); font-size: 10px; }
.read-state { flex: none; font-size: 10px; color: var(--fg-tertiary); }.unread .read-state { color: var(--accent); }
</style>
