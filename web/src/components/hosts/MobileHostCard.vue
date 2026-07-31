<template>
  <article class="mobile-host-card">
    <header class="mobile-host-header">
      <span :class="['mobile-host-dot', { online: daemon.daemon_online }]"></span>
      <div class="mobile-host-identity">
        <div class="mobile-host-name">
          {{ daemon.daemon_alias || daemon.hostname || daemon.daemon_id.slice(0, 8) }}
          <span v-if="daemon.daemon_alias" class="mobile-alias-badge">{{ t('dashboard.alias_badge') }}</span>
        </div>
        <div class="mobile-host-machine">
          {{ daemon.hostname || daemon.daemon_id.slice(0, 8) }}
          <template v-if="daemon.os"> · {{ daemon.os }}</template>
        </div>
      </div>
      <span :class="['mobile-host-status', { online: daemon.daemon_online }]">
        {{ daemon.daemon_online ? t('dashboard.online') : t('dashboard.offline') }}
      </span>
      <button type="button" class="mobile-host-more" :aria-label="t('session.actions.more')" @click.stop="$emit('more', $event)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
      </button>
    </header>

    <div v-if="agents.length" class="mobile-host-agents">
      <span v-for="agent in agents" :key="agent.raw" :class="['mobile-agent-tag', agent.kind]">
        <i></i>{{ agent.label }}<small v-if="agent.version">v{{ agent.version }}</small>
      </span>
    </div>

    <div class="mobile-host-actions">
      <button type="button" data-action="sessions" @click="$emit('sessions')">
        <span class="mobile-action-icon sessions">◎</span>
        <span>
          <strong>{{ t('nav.sessions') }}</strong>
          <small>{{ activeSessions }} {{ t('dashboard.active_sessions') }} · {{ totalSessions }} {{ t('dashboard.total_sessions') }}</small>
        </span>
        <b>›</b>
      </button>
      <button type="button" data-action="new-session" :disabled="!daemon.daemon_online" @click="$emit('new-session')">
        <span class="mobile-action-icon create">＋</span>
        <span>
          <strong>{{ t('session.new_session') }}</strong>
          <small v-if="!daemon.daemon_online">{{ t('dashboard.offline') }}</small>
        </span>
        <b>›</b>
      </button>
    </div>

    <footer v-if="lastActivityLabel" class="mobile-host-footer">
      {{ t('mobile.host_last_active') }}: {{ lastActivityLabel }}
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'

const props = defineProps<{
  daemon: any
  activeSessions: number
  totalSessions: number
  lastActivityLabel?: string
}>()

defineEmits<{
  (event: 'sessions'): void
  (event: 'new-session'): void
  (event: 'more', mouseEvent: MouseEvent): void
}>()

const { t } = useLocale()
const names: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}
const agents = computed(() => (Array.isArray(props.daemon.agents) ? props.daemon.agents : []).map((agent: any) => {
  const raw = typeof agent === 'string' ? agent : agent.type || agent.name || 'agent'
  return {
    raw,
    label: names[raw] || raw,
    version: typeof agent === 'object' ? agent.version || '' : '',
    kind: raw === 'codex' ? 'codex' : raw === 'opencode' ? 'opencode' : 'claude',
  }
}))
</script>

<style scoped>
.mobile-host-card {
  display: none;
}
@media (max-width: 768px) {
  .mobile-host-card {
    display: block;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
  }
  .mobile-host-header {
    display: grid;
    grid-template-columns: 9px minmax(0, 1fr) auto 36px;
    align-items: center;
    gap: 9px;
    padding: 15px 14px 10px;
  }
  .mobile-host-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--fg-tertiary); }
  .mobile-host-dot.online { background: var(--success); box-shadow: 0 0 0 4px color-mix(in srgb, var(--success) 14%, transparent); }
  .mobile-host-identity { min-width: 0; }
  .mobile-host-name { overflow: hidden; color: var(--fg); font-size: 16px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-host-machine { margin-top: 2px; overflow: hidden; color: var(--fg-tertiary); font: 11px var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
  .mobile-alias-badge { margin-left: 4px; padding: 1px 5px; border-radius: 4px; color: var(--accent); background: var(--accent-muted); font-size: 10px; font-weight: 600; }
  .mobile-host-status { padding: 3px 8px; border-radius: 999px; color: var(--fg-tertiary); background: var(--surface-hover); font-size: 11px; font-weight: 650; }
  .mobile-host-status.online { color: var(--success); background: var(--success-bg); }
  .mobile-host-more { width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 9px; color: var(--fg-tertiary); background: transparent; }
  .mobile-host-more svg { width: 18px; fill: currentColor; }
  .mobile-host-agents { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 12px 32px; }
  .mobile-agent-tag { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: 999px; color: #d97757; background: rgba(217,119,87,.12); font-size: 11px; font-weight: 600; }
  .mobile-agent-tag.codex { color: #3fb950; background: rgba(63,185,80,.12); }
  .mobile-agent-tag.opencode { color: #a78bfa; background: rgba(167,139,250,.12); }
  .mobile-agent-tag i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .mobile-agent-tag small { opacity: .75; font-size: 9px; }
  .mobile-host-actions { border-top: 1px solid var(--border); }
  .mobile-host-actions button {
    width: 100%;
    min-height: 54px;
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border: 0;
    border-bottom: 1px solid var(--border);
    color: var(--fg);
    background: transparent;
    text-align: left;
  }
  .mobile-host-actions button:disabled { opacity: .45; }
  .mobile-host-actions button > span:nth-child(2) { display: flex; flex-direction: column; gap: 2px; }
  .mobile-host-actions strong { font-size: 13px; }
  .mobile-host-actions small { color: var(--fg-tertiary); font-size: 11px; }
  .mobile-host-actions b { color: var(--fg-tertiary); font-size: 20px; font-weight: 400; }
  .mobile-action-icon { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 7px; font-size: 17px; }
  .mobile-action-icon.sessions { color: var(--accent); background: var(--accent-muted); }
  .mobile-action-icon.create { color: var(--success); background: var(--success-bg); }
  .mobile-host-footer { padding: 9px 14px; color: var(--fg-tertiary); font-size: 11px; }
}
</style>
