<template>
  <button
    v-if="store.isAvailable.value"
    type="button"
    :class="[
      'attention-entry-button',
      { 'attention-entry-button--nav': variant === 'nav', 'has-attention': count > 0 },
    ]"
    data-testid="attention-inbox-entry"
    :aria-label="ariaLabel"
    @click="openInbox"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h16v14H4z" />
      <path d="M4 13h5l2 2h2l2-2h5" />
    </svg>
    <span v-if="showLabel">{{ t('attention.title') }}</span>
    <b v-if="count > 0">{{ badge }}</b>
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAttentionInbox, type AttentionInboxStore } from '../../composables/useAttentionInbox'
import { useLocale } from '../../composables/useLocale'
import type { AttentionInboxScope } from '../../types/attentionInbox'

const props = withDefaults(defineProps<{
  scope: AttentionInboxScope
  store?: AttentionInboxStore
  showLabel?: boolean
  variant?: 'default' | 'nav'
}>(), { showLabel: false, variant: 'default' })
const store = props.store ?? useAttentionInbox()
const router = useRouter()
const { t } = useLocale()
const count = computed(() => store.attentionCount(props.scope))
const badge = computed(() => count.value > 99 ? '99+' : String(count.value))
const ariaLabel = computed(() => count.value > 0
  ? t('attention.entry_count', { count: count.value })
  : t('attention.entry'))

function refreshDaemonScope(): void {
  if (store.isAvailable.value && props.scope.type === 'daemon') void store.refresh(props.scope)
}

function openInbox(): void {
  void router.push(props.scope.type === 'global'
    ? { path: '/inbox' }
    : {
        path: '/inbox',
        query: {
          daemon_id: props.scope.daemonId,
          ...(props.scope.daemonName ? { daemon_name: props.scope.daemonName } : {}),
        },
      })
}

onMounted(refreshDaemonScope)
watch([
  () => store.isAvailable.value,
  () => props.scope.type === 'daemon' ? props.scope.daemonId : '',
], refreshDaemonScope)
</script>

<style scoped>
.attention-entry-button { position: relative; min-width: 36px; min-height: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 0 10px; border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border)); border-radius: var(--radius-full); color: var(--accent); background: var(--accent-muted); cursor: pointer; }
.attention-entry-button svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.attention-entry-button > span { font-size: 11px; font-weight: 680; }
.attention-entry-button b { display: grid; min-width: 18px; height: 18px; place-items: center; padding: 0 5px; border-radius: 99px; color: #1d1404; background: var(--warning); font-size: 9px; font-weight: 800; }
.attention-entry-button--nav { width: 32px; height: 32px; min-width: 32px; min-height: 32px; overflow: visible; padding: 0; }
.attention-entry-button--nav b {
  position: absolute;
  top: -5px;
  right: -6px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border: 2px solid var(--bg);
  font-size: 8px;
  line-height: 13px;
  pointer-events: none;
}
</style>
