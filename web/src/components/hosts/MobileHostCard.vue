<template>
  <article class="mobile-host-card">
    <header class="mobile-host-header">
      <span :class="['mobile-host-dot', { online: daemon.daemon_online }]" aria-hidden="true"></span>
      <span class="mobile-host-computer" aria-hidden="true">
        <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M12 18v3"/></svg>
      </span>
      <div class="mobile-host-identity">
        <div class="mobile-host-name-row">
          <button type="button" class="mobile-host-name" data-action="sessions" @click="$emit('sessions')">
            {{ displayName }}
          </button>
          <span v-if="daemon.daemon_alias" class="mobile-alias-badge">{{ t('dashboard.alias_badge') }}</span>
          <button type="button" class="mobile-host-edit" data-action="edit-alias" :aria-label="t('hosts.menu_edit_alias')" @click="startEdit">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
          </button>
        </div>
        <div class="mobile-host-machine">{{ contextText }}</div>
      </div>
      <div class="mobile-host-trailing">
        <span :class="['mobile-host-status', { online: daemon.daemon_online }]">
          {{ daemon.daemon_online ? t('dashboard.online') : t('dashboard.offline') }}
        </span>
        <button type="button" class="mobile-host-more" :aria-label="t('session.actions.more')" @click.stop="$emit('more', $event)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>
        </button>
      </div>
    </header>

    <form v-if="isEditing" class="mobile-host-rename" @submit.prevent="confirmEdit">
      <input
        ref="aliasInput"
        v-model="editText"
        data-role="alias-input"
        type="text"
        :placeholder="t('dashboard.placeholder_alias')"
        :aria-label="t('hosts.alias_label')"
      />
      <button type="submit" data-action="save-alias" :aria-label="t('common.save')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>
      </button>
      <button type="button" data-action="cancel-alias" :aria-label="t('common.cancel')" @click="cancelEdit">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </form>

    <div v-if="agents.length" class="mobile-host-agents">
      <span v-for="agent in agents" :key="agent.raw" class="mobile-agent-tag">
        {{ agent.label }}<small v-if="agent.version">v{{ agent.version }}</small><small v-if="agent.canUpgrade" class="upgrade">{{ t('settings.upgrade_available') }}</small>
      </span>
    </div>

    <div class="mobile-host-actions">
      <button type="button" data-action="sessions" @click="$emit('sessions')">
        <svg class="mobile-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 8h8M8 12h5"/></svg>
        <span>
          <strong>{{ t('mobile.host_sessions') }}</strong>
        </span>
        <small>{{ activeSessions }} {{ t('dashboard.active_sessions') }} · {{ totalSessions }} {{ t('mobile.host_history') }}</small>
        <b>›</b>
      </button>
      <button type="button" data-action="new-session" :disabled="!daemon.daemon_online" @click="$emit('new-session')">
        <svg class="mobile-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        <span><strong>{{ t('session.new_session') }}</strong></span>
        <small v-if="!daemon.daemon_online">{{ t('mobile.host_offline') }}</small>
        <b>›</b>
      </button>
      <button type="button" data-action="token" @click="$emit('token')">
        <svg class="mobile-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></svg>
        <span><strong>{{ t('mobile.host_token_usage') }}</strong></span>
        <b>›</b>
      </button>
      <button type="button" data-action="agent" :disabled="!daemon.daemon_online" @click="$emit('agent')">
        <svg class="mobile-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.7 6.3 3-3a2.1 2.1 0 0 1 3 3l-3 3"/><path d="m9.3 17.7-3 3a2.1 2.1 0 0 1-3-3l3-3M8 16l8-8M5 5l14 14"/></svg>
        <span><strong>{{ t('mobile.host_agent_manage') }}</strong></span>
        <small v-if="agents.length" :class="{ warn: upgradableCount > 0 }">{{ agentSummary }}</small>
        <b>›</b>
      </button>
    </div>

    <footer v-if="lastActivityLabel" class="mobile-host-footer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
      <span>{{ t('mobile.host_last_active') }} · {{ lastActivityLabel }}</span>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { agentDisplayName } from '../../utils/agentDisplay'

const props = defineProps<{
  daemon: any
  activeSessions: number
  totalSessions: number
  lastActivityLabel?: string
}>()

const emit = defineEmits<{
  (event: 'sessions'): void
  (event: 'new-session'): void
  (event: 'token'): void
  (event: 'agent'): void
  (event: 'set-alias', alias: string | null): void
  (event: 'more', mouseEvent: MouseEvent): void
}>()

const { t } = useLocale()
const isEditing = ref(false)
const editText = ref('')
const aliasInput = ref<HTMLInputElement | null>(null)
const fallbackId = computed(() => String(props.daemon.daemon_id || '').slice(0, 8))
const displayName = computed(() => props.daemon.daemon_alias || props.daemon.hostname || fallbackId.value)
const contextText = computed(() => [props.daemon.hostname || fallbackId.value, props.daemon.os].filter(Boolean).join(' · '))
const agents = computed(() => (Array.isArray(props.daemon.agents) ? props.daemon.agents : []).map((agent: any) => {
  const raw = typeof agent === 'string' ? agent : agent.type || agent.name || 'agent'
  return {
    raw,
    label: agentDisplayName(raw),
    version: typeof agent === 'object' ? agent.version || '' : '',
    canUpgrade: typeof agent === 'object' && !!agent.latest && agent.latest !== agent.version,
  }
}))
const upgradableCount = computed(() => agents.value.filter((agent: { canUpgrade: boolean }) => agent.canUpgrade).length)
const agentSummary = computed(() => upgradableCount.value > 0
  ? t('mobile.host_agent_upgrade_summary', { count: agents.value.length, upgrade: upgradableCount.value })
  : t('mobile.host_agent_count', { count: agents.value.length }))

function startEdit() {
  editText.value = props.daemon.daemon_alias || ''
  isEditing.value = true
  nextTick(() => aliasInput.value?.focus())
}

function confirmEdit() {
  const alias = editText.value.trim()
  emit('set-alias', alias || null)
  isEditing.value = false
}

function cancelEdit() {
  isEditing.value = false
}
</script>

<style scoped>
.mobile-host-card { display: none; }
@media (max-width: 768px) {
  .mobile-host-card {
    display: block;
    overflow: hidden;
    border: 1px solid var(--border-light);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }
  .mobile-host-header {
    display: grid;
    grid-template-columns: 9px 28px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    padding: 12px 14px 8px;
  }
  .mobile-host-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-tertiary); }
  .mobile-host-dot.online { background: var(--success); }
  .mobile-host-computer { width: 28px; height: 28px; display: grid; place-items: center; border-radius: var(--radius-sm); color: var(--fg-secondary); background: var(--surface-active); }
  .mobile-host-computer svg { width: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  .mobile-host-identity { min-width: 0; }
  .mobile-host-name-row { min-width: 0; display: flex; align-items: center; gap: 5px; }
  .mobile-host-name { min-width: 0; overflow: hidden; padding: 0; border: 0; color: var(--fg); background: transparent; font: 600 15px var(--font-body); text-align: left; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-host-machine { margin-top: 2px; overflow: hidden; color: var(--fg-secondary); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-alias-badge { flex: 0 0 auto; color: var(--fg-tertiary); font-size: 10px; font-weight: 500; }
  .mobile-host-edit { flex: 0 0 26px; width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 6px; color: var(--fg-tertiary); background: transparent; }
  .mobile-host-edit svg { width: 13px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
  .mobile-host-trailing { align-self: stretch; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 2px; }
  .mobile-host-status { padding: 2px 7px; border-radius: 999px; color: var(--fg-tertiary); background: var(--surface-hover); font-size: 10px; font-weight: 600; }
  .mobile-host-status.online { color: var(--success); background: var(--success-bg); }
  .mobile-host-more { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 7px; color: var(--fg-tertiary); background: transparent; }
  .mobile-host-more svg { width: 17px; fill: currentColor; }
  .mobile-host-name:focus-visible,
  .mobile-host-edit:focus-visible,
  .mobile-host-more:focus-visible,
  .mobile-host-actions button:focus-visible,
  .mobile-host-rename button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .mobile-host-rename { display: grid; grid-template-columns: minmax(0, 1fr) 34px 34px; gap: 6px; padding: 0 14px 11px 60px; }
  .mobile-host-rename input { width: 100%; height: 34px; padding: 0 9px; border: 1px solid var(--border); border-radius: 7px; outline: 0; color: var(--fg); background: var(--bg); font: 13px var(--font-body); }
  .mobile-host-rename input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-muted); }
  .mobile-host-rename button { height: 34px; display: grid; place-items: center; border: 0; border-radius: 7px; color: var(--fg-secondary); background: var(--surface-active); }
  .mobile-host-rename button[type="submit"]:active { color: var(--success); }
  .mobile-host-rename button:last-child:active { color: var(--error); }
  .mobile-host-rename svg { width: 15px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 2; }
  .mobile-host-agents { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 11px; }
  .mobile-agent-tag { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border: .5px solid var(--border-light); border-radius: 999px; color: var(--fg-secondary); background: var(--surface-active); font-size: 10px; font-weight: 500; }
  .mobile-agent-tag small { color: var(--fg-tertiary); font-size: 9px; }
  .mobile-agent-tag small.upgrade { color: var(--warning); font-weight: 600; }
  .mobile-host-actions { border-top: 1px solid var(--border); }
  .mobile-host-actions button {
    width: 100%; min-height: 45px; display: grid; grid-template-columns: 19px minmax(82px, auto) minmax(0, 1fr) auto; align-items: center; gap: 9px;
    padding: 0 14px; border: 0; border-bottom: 1px solid var(--border); color: var(--fg); background: transparent; text-align: left;
  }
  .mobile-host-actions button:last-child { border-bottom: 0; }
  .mobile-host-actions button:active:not(:disabled) { background: var(--surface-hover); }
  .mobile-host-actions button:disabled { opacity: .48; }
  .mobile-host-actions strong { font-size: 13px; font-weight: 500; }
  .mobile-host-actions small { overflow: hidden; color: var(--fg-tertiary); font-size: 11px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-host-actions small.warn { color: var(--warning); }
  .mobile-host-actions b { grid-column: 4; color: var(--fg-tertiary); font-size: 18px; font-weight: 400; }
  .mobile-action-icon { width: 18px; fill: none; stroke: var(--fg-secondary); stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
  .mobile-host-footer { display: flex; align-items: center; gap: 6px; padding: 9px 14px; border-top: 1px solid var(--border); color: var(--fg-tertiary); font-size: 11px; }
  .mobile-host-footer svg { width: 12px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
}
</style>
