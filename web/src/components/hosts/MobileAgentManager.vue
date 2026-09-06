<template>
  <section class="mobile-agent-manager" role="dialog" aria-modal="true" :aria-label="t('mobile.host_agent_manage')">
    <header class="mobile-agent-header">
      <button type="button" :aria-label="t('common.back')" @click="$emit('close')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <div>
        <h2>{{ t('mobile.host_agent_manage') }}</h2>
        <p>{{ displayName }}</p>
      </div>
    </header>

    <div class="mobile-agent-content">
      <div class="mobile-agent-summary">
        <span>{{ agents.length }}</span>
        <small>{{ t('mobile.host_agent_installed') }}</small>
      </div>

      <div v-if="agents.length" class="mobile-agent-list">
        <article v-for="agent in agents" :key="agent.raw" class="mobile-agent-card">
          <div class="mobile-agent-mark">{{ agent.short }}</div>
          <div class="mobile-agent-info">
            <strong>{{ agent.label }}</strong>
            <span>v{{ agent.version || '—' }}<template v-if="agent.canUpgrade"> → v{{ agent.latest }}</template></span>
          </div>
          <button
            v-if="agent.canUpgrade && agent.manageable"
            type="button"
            :disabled="!daemon.daemon_online || upgrading === agent.raw"
            @click="$emit('upgrade', agent.raw)"
          >
            <span v-if="upgrading === agent.raw" class="mobile-agent-spinner"></span>
            {{ upgrading === agent.raw ? t('common.processing') : t('settings.upgrade_btn') }}
          </button>
          <span v-else class="mobile-agent-current">✓ {{ t('settings.installed') }}</span>
        </article>
      </div>
      <div v-else class="mobile-agent-empty">{{ t('hosts.agent_none') }}</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { agentDisplayName, agentShortLabel } from '../../utils/agentDisplay'
import { isReadOnlyObserverAgent } from '../../utils/observerSession'

const props = defineProps<{
  daemon: any
  upgrading: string
}>()

defineEmits<{
  close: []
  upgrade: [agent: string]
}>()

const { t } = useLocale()
const displayName = computed(() => props.daemon.daemon_alias || props.daemon.hostname || String(props.daemon.daemon_id || '').slice(0, 8))
const agents = computed(() => (Array.isArray(props.daemon.agents) ? props.daemon.agents : []).map((agent: any) => {
  const raw = typeof agent === 'string' ? agent : agent.type || agent.name || 'agent'
  const version = typeof agent === 'object' ? agent.version || '' : ''
  const latest = typeof agent === 'object' ? agent.latest || '' : ''
  const isObserver = isReadOnlyObserverAgent(raw)
  return {
    raw,
    label: agentDisplayName(raw),
    short: agentShortLabel(raw),
    version,
    latest,
    canUpgrade: !isObserver && !!latest && latest !== version,
    manageable: !isObserver && (typeof agent !== 'object' || agent.manageable !== false),
  }
}))
</script>

<style scoped>
.mobile-agent-manager { display: none; }
@media (max-width: 768px) {
  .mobile-agent-manager {
    position: fixed;
    inset: var(--mobile-topbar-h, 0px) 0 0;
    z-index: 75;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
    animation: mobile-agent-in .18s ease-out;
  }
  .mobile-agent-header { min-height: 62px; display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--surface); }
  .mobile-agent-header > button { width: 42px; height: 42px; display: grid; place-items: center; border: 0; border-radius: var(--radius-md); color: var(--fg); background: transparent; }
  .mobile-agent-header > button:active { background: var(--surface-active); }
  .mobile-agent-header svg { width: 22px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
  .mobile-agent-header h2 { color: var(--fg); font: 600 17px var(--font-display); }
  .mobile-agent-header p { margin-top: 1px; color: var(--fg-tertiary); font-size: 11px; }
  .mobile-agent-content { flex: 1; overflow-y: auto; padding: 14px 12px 24px; }
  .mobile-agent-summary { display: flex; align-items: baseline; gap: 6px; padding: 14px 16px; border: 1px solid var(--border-light); border-radius: var(--radius-lg); background: var(--surface); }
  .mobile-agent-summary span { color: var(--accent); font-size: 22px; font-weight: 700; }
  .mobile-agent-summary small { color: var(--fg-tertiary); font-size: 12px; }
  .mobile-agent-list { display: grid; gap: 10px; margin-top: 12px; }
  .mobile-agent-card { min-height: 70px; display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 11px; padding: 12px 14px; border: 1px solid var(--border-light); border-radius: var(--radius-lg); background: var(--surface); }
  .mobile-agent-mark { width: 38px; height: 38px; display: grid; place-items: center; border-radius: var(--radius-md); color: var(--accent); background: var(--accent-muted); font-size: 12px; font-weight: 700; }
  .mobile-agent-info { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .mobile-agent-info strong { overflow: hidden; color: var(--fg); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
  .mobile-agent-info span { color: var(--fg-tertiary); font: 11px var(--font-mono); }
  .mobile-agent-card > button { min-height: 34px; padding: 0 11px; border: 1px solid var(--accent); border-radius: 999px; color: var(--accent); background: var(--accent-muted); font-size: 11px; font-weight: 600; }
  .mobile-agent-card > button:disabled { opacity: .5; }
  .mobile-agent-current { color: var(--success); font-size: 11px; font-weight: 600; }
  .mobile-agent-spinner { display: inline-block; width: 11px; height: 11px; margin-right: 4px; border: 1.5px solid transparent; border-top-color: currentColor; border-radius: 50%; animation: mobile-agent-spin .7s linear infinite; vertical-align: -1px; }
  .mobile-agent-empty { padding: 48px 20px; color: var(--fg-tertiary); font-size: 13px; text-align: center; }
}
@keyframes mobile-agent-in { from { opacity: .5; transform: translateX(18px); } }
@keyframes mobile-agent-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mobile-agent-manager, .mobile-agent-spinner { animation: none; } }
</style>
