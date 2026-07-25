<template>
  <div
    class="host-actions-menu"
    :style="{ left: `${x}px`, top: `${y}px` }"
    role="menu"
    :aria-label="`${displayName} 更多操作`"
    @click.stop
  >
    <div class="host-actions-handle" aria-hidden="true"></div>
    <div class="host-actions-heading">
      <span>{{ displayName }}</span>
      <small>主机操作</small>
    </div>

    <button type="button" role="menuitem" data-host-action="refresh" @click="$emit('action', 'refresh')">
      <svg viewBox="0 0 24 24"><path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6.1 6.1L4 11M5.5 15A7 7 0 0 0 17.9 17.9L20 13"/></svg>
      <span>{{ t('hosts.menu_refresh') }}</span><b>›</b>
    </button>
    <button type="button" role="menuitem" data-host-action="restart" @click="$emit('action', 'restart')">
      <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/></svg>
      <span>{{ t('hosts.restart_daemon') }}</span><b>›</b>
    </button>
    <button type="button" role="menuitem" data-host-action="alias" @click="$emit('action', 'alias')">
      <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
      <span>{{ t('hosts.menu_edit_alias') }}</span><b>›</b>
    </button>
    <div class="host-actions-separator"></div>
    <button type="button" role="menuitem" class="danger" data-host-action="kick" @click="$emit('action', 'kick')">
      <svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/></svg>
      <span>{{ t('hosts.force_kick_label') }}</span><b>›</b>
    </button>
    <button type="button" role="menuitem" class="danger" data-host-action="unregister" @click="$emit('action', 'unregister')">
      <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
      <span>{{ t('hosts.menu_unregister') }}</span><b>›</b>
    </button>
    <button type="button" class="host-actions-cancel" @click="$emit('close')">{{ t('common.cancel') }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { HostActionId } from '../../utils/hostActions'

const props = defineProps<{
  daemon: any
  x: number
  y: number
}>()

defineEmits<{
  action: [action: HostActionId]
  close: []
}>()

const { t } = useLocale()
const displayName = computed(() =>
  props.daemon.daemon_alias || props.daemon.hostname || props.daemon.daemon_id?.slice(0, 8) || 'Host',
)
</script>

<style scoped>
.host-actions-menu {
  position: fixed;
  z-index: 220;
  width: 224px;
  overflow: hidden;
  padding: 6px;
  border: 1px solid var(--border, #30363d);
  border-radius: 12px;
  background: var(--surface, #161b22);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .35);
}
.host-actions-handle { display: none; }
.host-actions-heading { display: flex; flex-direction: column; gap: 2px; padding: 9px 10px 10px; border-bottom: 1px solid var(--border, #30363d); }
.host-actions-heading span { overflow: hidden; color: var(--fg, #e6edf3); font-size: 13px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.host-actions-heading small { color: var(--fg-tertiary, #8b949e); font-size: 10px; }
.host-actions-menu > button:not(.host-actions-cancel) {
  display: grid;
  width: 100%;
  min-height: 40px;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 8px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--fg-secondary, #c9d1d9);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.host-actions-menu > button:not(.host-actions-cancel):hover { background: var(--surface-hover, #21262d); color: var(--fg, #e6edf3); }
.host-actions-menu svg { width: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.host-actions-menu b { color: var(--fg-tertiary, #8b949e); font-size: 17px; font-weight: 400; }
.host-actions-menu .danger { color: var(--error, #f85149) !important; }
.host-actions-menu .danger:hover { background: rgba(248, 81, 73, .1) !important; }
.host-actions-separator { height: 1px; margin: 4px 7px; background: var(--border, #30363d); }
.host-actions-cancel { display: none; }
@media (max-width: 768px) {
  .host-actions-menu {
    inset: auto 0 0 !important;
    width: auto;
    padding: 8px 18px max(18px, env(safe-area-inset-bottom));
    border: 0;
    border-top: 1px solid var(--border, #30363d);
    border-radius: 18px 18px 0 0;
    animation: host-actions-in .2s ease-out;
  }
  .host-actions-handle { display: block; width: 36px; height: 4px; margin: 2px auto 13px; border-radius: 999px; background: var(--fg-tertiary, #8b949e); opacity: .5; }
  .host-actions-heading { padding: 0 4px 12px; }
  .host-actions-heading span { font-size: 18px; }
  .host-actions-menu > button:not(.host-actions-cancel) { min-height: 50px; grid-template-columns: 26px minmax(0, 1fr) auto; padding: 11px 6px; border-bottom: 1px solid var(--border, #30363d); border-radius: 0; font-size: 15px; }
  .host-actions-menu svg { width: 19px; }
  .host-actions-separator { display: none; }
  .host-actions-cancel { display: block; width: 100%; min-height: 48px; margin-top: 14px; border: 0; border-radius: 10px; background: var(--surface-hover, #21262d); color: var(--fg, #e6edf3); font-size: 15px; font-weight: 650; }
}
@keyframes host-actions-in { from { transform: translateY(100%); } }
@media (prefers-reduced-motion: reduce) { .host-actions-menu { animation: none; } }
</style>
