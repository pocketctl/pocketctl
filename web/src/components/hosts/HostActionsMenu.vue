<template>
  <div class="host-actions-layer">
    <button class="host-actions-backdrop" type="button" :aria-label="t('common.cancel')" @click="$emit('close')"></button>
    <div
      class="host-actions-menu"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      :aria-label="`${displayName} ${t('session.actions.more')}`"
      @click.stop
    >
      <div class="host-actions-handle" aria-hidden="true"></div>

      <form v-if="isEditingAlias" class="host-alias-editor" @submit.prevent="confirmAlias">
        <div class="host-actions-heading"><span>{{ t('hosts.menu_edit_alias') }}</span></div>
        <input
          ref="aliasInput"
          v-model="aliasText"
          data-role="sheet-alias-input"
          type="text"
          :placeholder="t('dashboard.placeholder_alias')"
          :aria-label="t('hosts.alias_label')"
        />
        <button type="submit" class="host-alias-confirm" data-action="confirm-alias">{{ t('common.confirm') }}</button>
      </form>

      <template v-else>
        <div class="host-actions-heading">
          <span>{{ displayName }}</span>
          <small>{{ t('mobile.host_actions') }}</small>
        </div>
        <button type="button" role="menuitem" data-host-action="refresh" @click="$emit('action', 'refresh')">
          <svg viewBox="0 0 24 24"><path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6.1 6.1L4 11M5.5 15A7 7 0 0 0 17.9 17.9L20 13"/></svg>
          <span>{{ t('hosts.menu_refresh') }}</span><b>›</b>
        </button>
        <div class="host-actions-separator"></div>
        <button type="button" role="menuitem" data-host-action="restart" @click="$emit('action', 'restart')">
          <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/></svg>
          <span>{{ t('hosts.restart_daemon') }}</span><b>›</b>
        </button>
        <button type="button" role="menuitem" data-host-action="alias" @click="startAliasEdit">
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
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { HostActionId } from '../../utils/hostActions'

const props = defineProps<{
  daemon: any
  x: number
  y: number
}>()

const emit = defineEmits<{
  action: [action: HostActionId, alias?: string | null]
  close: []
}>()

const { t } = useLocale()
const isEditingAlias = ref(false)
const aliasText = ref('')
const aliasInput = ref<HTMLInputElement | null>(null)
const displayName = computed(() =>
  props.daemon.daemon_alias || props.daemon.hostname || props.daemon.daemon_id?.slice(0, 8) || 'Host',
)

function startAliasEdit() {
  aliasText.value = props.daemon.daemon_alias || ''
  isEditingAlias.value = true
  nextTick(() => aliasInput.value?.focus())
}

function confirmAlias() {
  const alias = aliasText.value.trim()
  emit('action', 'alias', alias || null)
}
</script>

<style scoped>
.host-actions-layer { position: fixed; inset: 0; z-index: 220; pointer-events: none; }
.host-actions-backdrop { display: none; }
.host-actions-menu {
  position: fixed;
  width: 224px;
  overflow: hidden;
  padding: 6px;
  border: 1px solid var(--border, #30363d);
  border-radius: 12px;
  background: var(--surface, #161b22);
  box-shadow: 0 18px 44px rgba(0, 0, 0, .35);
  pointer-events: auto;
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
.host-actions-menu .danger:hover { background: color-mix(in srgb, var(--error) 10%, transparent) !important; }
.host-actions-separator { height: 1px; margin: 4px 7px; background: var(--border, #30363d); }
.host-actions-cancel { display: none; }
.host-alias-editor { display: grid; gap: 16px; padding-bottom: 4px; }
.host-alias-editor input { width: 100%; height: 42px; padding: 0 11px; border: 1px solid var(--border); border-radius: var(--radius-md); outline: 0; color: var(--fg); background: var(--bg); font: 14px var(--font-body); }
.host-alias-editor input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }
.host-alias-confirm { width: 100%; min-height: 42px; border: 0; border-radius: var(--radius-md); color: var(--bg); background: var(--accent); font-size: 15px; font-weight: 650; }
@media (max-width: 768px) {
  .host-actions-layer { pointer-events: auto; }
  .host-actions-backdrop { position: absolute; inset: 0; display: block; width: 100%; border: 0; background: var(--overlay); backdrop-filter: blur(2px); pointer-events: auto; animation: host-actions-fade .2s ease-out; }
  .host-actions-menu {
    inset: auto 0 0 !important;
    width: auto;
    min-height: 240px;
    max-height: calc(100dvh - var(--mobile-topbar-h, 64px));
    overflow-y: auto;
    padding: 8px 32px max(18px, env(safe-area-inset-bottom));
    border: 0;
    border-top: 1px solid var(--border, #30363d);
    border-radius: 18px 18px 0 0;
    animation: host-actions-in .2s ease-out;
  }
  .host-actions-handle { display: block; width: 36px; height: 5px; margin: 2px auto 13px; border-radius: 999px; background: var(--fg-tertiary, #8b949e); opacity: .65; }
  .host-actions-heading { padding: 0 0 8px; }
  .host-actions-heading span { font: 600 20px var(--font-display); }
  .host-actions-menu > button:not(.host-actions-cancel) { min-height: 50px; grid-template-columns: 26px minmax(0, 1fr) auto; padding: 11px 2px; border-bottom: .5px solid var(--border, #30363d); border-radius: 0; font-size: 16px; }
  .host-actions-menu svg { width: 19px; }
  .host-actions-separator { display: none; }
  .host-actions-cancel { display: block; width: 100%; min-height: 48px; margin-top: 20px; border: 0; border-radius: var(--radius-md); background: var(--surface-hover, #21262d); color: var(--fg, #e6edf3); font: 600 17px var(--font-display); }
  .host-alias-editor { gap: 16px; }
  .host-alias-editor input { height: 46px; font-size: 16px; }
  .host-alias-confirm { min-height: 48px; color: var(--bg); font: 600 17px var(--font-display); }
}
@keyframes host-actions-in { from { transform: translateY(100%); } }
@keyframes host-actions-fade { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .host-actions-menu, .host-actions-backdrop { animation: none; } }
</style>
