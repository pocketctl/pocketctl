<template>
  <button
    type="button"
    class="recovery-row"
    :class="{ selected }"
    data-testid="attention-recovery-row"
    :data-recovery-id="item.recovery_id"
    @click="$emit('select')"
  >
    <span class="signal" aria-hidden="true"><i></i></span>
    <span class="copy">
      <span class="kicker"><strong>{{ t('attention.kind_recovery') }}</strong><span>{{ stateLabel }}</span></span>
      <span class="title">{{ t('attention.recovery_title', { name: item.daemon.display_name }) }}</span>
      <span class="meta">{{ t('attention.recovery_last_seen') }} · {{ lastSeen }}</span>
    </span>
    <span class="side"><time :datetime="item.updated_at">{{ relativeTime }}</time><b>HOST</b></span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { AttentionRecoveryItem } from '../../types/attentionInbox'

const props = defineProps<{ item: AttentionRecoveryItem; selected?: boolean }>()
defineEmits<{ (event: 'select'): void }>()
const { t } = useLocale()
const stateLabel = computed(() => ({
  open: t('attention.state_open'), snoozed: t('attention.state_snoozed'), resolved: t('attention.state_resolved'),
})[props.item.state])
const lastSeen = computed(() => new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
}).format(new Date(props.item.last_seen_at)))
const relativeTime = computed(() => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(props.item.updated_at)) / 1000))
  if (seconds < 60) return t('attention.time_now')
  if (seconds < 3600) return t('attention.time_minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('attention.time_hours', { count: Math.floor(seconds / 3600) })
  return t('attention.time_days', { count: Math.floor(seconds / 86400) })
})
</script>

<style scoped>
.recovery-row { position: relative; width: 100%; min-height: 104px; display: grid; grid-template-columns: 32px minmax(0,1fr) auto; gap: 12px; align-items: center; padding: 15px 14px; border: 1px solid transparent; border-radius: var(--radius-md); color: var(--fg); background: transparent; text-align: left; cursor: pointer; transition: transform .18s, border-color .18s, background .18s; }
.recovery-row:hover { transform: translateX(2px); background: var(--surface-hover); }.recovery-row.selected { border-color: color-mix(in srgb, var(--warning) 36%, var(--border)); background: color-mix(in srgb, var(--warning) 7%, var(--surface)); }
.signal { position: relative; display: grid; width: 30px; height: 30px; place-items: center; border: 1px solid color-mix(in srgb, var(--warning) 42%, var(--border)); border-radius: 50%; background: color-mix(in srgb, var(--warning) 8%, transparent); }.signal::before,.signal::after { position: absolute; border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); border-radius: 50%; content: ''; }.signal::before { width: 13px; height: 13px; }.signal::after { width: 21px; height: 21px; }.signal i { width: 4px; height: 4px; border-radius: 50%; background: var(--warning); box-shadow: 0 0 10px var(--warning); }
.copy { min-width: 0; display: flex; flex-direction: column; gap: 8px; }.kicker { display: flex; gap: 7px; color: var(--fg-tertiary); font-size: 10px; letter-spacing: .055em; text-transform: uppercase; }.kicker strong { color: var(--warning); }.title { overflow: hidden; font-size: 14px; font-weight: 670; text-overflow: ellipsis; white-space: nowrap; }.meta { overflow: hidden; color: var(--fg-tertiary); font: 10px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }.side { align-self: stretch; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; }.side time { color: var(--fg-tertiary); font-size: 10px; }.side b { padding: 3px 7px; border: 1px solid var(--border); border-radius: var(--radius-full); color: var(--warning); font: 700 9px var(--font-mono); }
</style>
