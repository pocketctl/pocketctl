<template>
  <button
    type="button"
    class="attention-item-row"
    :class="[{ selected }, `risk-${item.risk.level}`]"
    data-testid="attention-row"
    :data-item-id="item.item_id"
    @click="$emit('select')"
  >
    <span class="risk-rail" aria-hidden="true"></span>
    <span class="item-copy">
      <span class="item-kicker">
        <strong>{{ providerLabel }}</strong>
        <span>{{ kindLabel }}</span>
        <span v-if="item.risk.classification_incomplete" class="incomplete-dot" :title="t('attention.risk_incomplete')">◇</span>
      </span>
      <span class="item-title">{{ item.title }}</span>
      <span class="item-meta">{{ item.daemon.display_name }} · {{ item.session.title }}</span>
    </span>
    <span class="item-side">
      <time :datetime="item.updated_at">{{ relativeTime }}</time>
      <span class="state-pill">{{ stateLabel }}</span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { AttentionInboxItem } from '../../types/attentionInbox'

const props = defineProps<{ item: AttentionInboxItem; selected?: boolean }>()
defineEmits<{ (event: 'select'): void }>()
const { t } = useLocale()

const providerLabel = computed(() => props.item.provider === 'opencode' ? 'OpenCode' : 'Codex')
const kindLabel = computed(() => props.item.kind === 'approval' ? t('attention.kind_approval') : t('attention.kind_question'))
const stateLabel = computed(() => ({
  open: t('attention.state_open'),
  snoozed: t('attention.state_snoozed'),
  submitting: t('attention.state_submitting'),
  result_unknown: t('attention.state_unknown'),
  resolved: t('attention.state_resolved'),
  expired: t('attention.state_expired'),
})[props.item.state])
const relativeTime = computed(() => {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(props.item.updated_at)) / 1000))
  if (seconds < 60) return t('attention.time_now')
  if (seconds < 3600) return t('attention.time_minutes', { count: Math.floor(seconds / 60) })
  if (seconds < 86400) return t('attention.time_hours', { count: Math.floor(seconds / 3600) })
  return t('attention.time_days', { count: Math.floor(seconds / 86400) })
})
</script>

<style scoped>
.attention-item-row {
  --risk: var(--accent);
  position: relative;
  width: 100%; min-height: 104px; display: grid;
  grid-template-columns: 4px minmax(0, 1fr) auto; gap: 13px;
  padding: 15px 14px; overflow: hidden; border: 1px solid transparent;
  border-radius: var(--radius-md); color: var(--fg); background: transparent;
  text-align: left; cursor: pointer; transition: border-color .18s, background .18s, transform .18s;
}
.attention-item-row:hover { transform: translateX(2px); background: var(--surface-hover); }
.attention-item-row.selected { border-color: color-mix(in srgb, var(--accent) 36%, var(--border)); background: var(--accent-muted); }
.attention-item-row.risk-critical { --risk: var(--error); }
.attention-item-row.risk-high { --risk: var(--warning); }
.attention-item-row.risk-medium { --risk: var(--accent); }
.attention-item-row.risk-low { --risk: var(--success); }
.risk-rail { align-self: stretch; border-radius: 99px; background: var(--risk); box-shadow: 0 0 16px color-mix(in srgb, var(--risk) 38%, transparent); }
.item-copy { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.item-kicker { display: flex; align-items: center; gap: 7px; color: var(--fg-tertiary); font-size: 10px; letter-spacing: .055em; text-transform: uppercase; }
.item-kicker strong { color: var(--risk); font-weight: 760; }
.incomplete-dot { color: var(--warning); }
.item-title { overflow: hidden; color: var(--fg); font-size: 14px; font-weight: 670; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.item-meta { overflow: hidden; color: var(--fg-tertiary); font: 11px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.item-side { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 12px; }
.item-side time { color: var(--fg-tertiary); font-size: 10px; white-space: nowrap; }
.state-pill { padding: 3px 7px; border: 1px solid var(--border); border-radius: var(--radius-full); color: var(--fg-secondary); background: var(--surface); font-size: 9px; white-space: nowrap; }
</style>
