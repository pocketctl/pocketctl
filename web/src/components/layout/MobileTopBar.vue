<template>
  <header class="mobile-topbar">
    <button
      v-if="isSession"
      type="button"
      class="mobile-topbar-back"
      :aria-label="t('mobile.back_to_sessions')"
      @click="router.push(sessionHostId ? hostSessionsLocation(sessionHostId) : '/sessions')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
    </button>
    <div v-else class="mobile-brand" aria-label="PocketCtl">P</div>

    <div class="mobile-topbar-title">
      <span class="mobile-topbar-title-text">{{ title }}</span>
      <span v-if="isSession && sessionHost" class="mobile-topbar-host" :title="sessionHost">{{ sessionHost }}</span>
    </div>

    <div :class="['mobile-connection', { 'is-session-status': isSession && sessionStatus }]" role="status" aria-live="polite">
      <span :class="['mobile-connection-dot', displayStatusClass]"></span>
      <span>{{ displayStatusLabel }}</span>
    </div>

    <button
      v-if="showPlan"
      type="button"
      :class="['mobile-topbar-action', 'mobile-plan-action', { active: planOpen, complete: planComplete }]"
      :aria-label="planLabel"
      :aria-expanded="planOpen"
      @click="$emit('open-plan')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m4 6 2 2 4-4M12 6h8M4 13l2 2 4-4M12 13h8M4 20l2 2 4-4M12 20h8" />
      </svg>
    </button>
    <button
      v-else-if="showNewSession"
      type="button"
      class="mobile-topbar-action"
      :aria-label="t('session.new_session')"
      @click="$emit('new-session')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import { hostSessionsLocation } from '../../utils/hostNavigation'

const props = defineProps<{
  title: string
  connected: boolean
  reconnecting: boolean
  isSession: boolean
  showNewSession: boolean
  showPlan?: boolean
  planLabel?: string
  planOpen?: boolean
  planComplete?: boolean
  sessionHost?: string
  sessionHostId?: string
  sessionStatus?: string
  sessionStatusLabel?: string
}>()

defineEmits<{ (event: 'new-session'): void; (event: 'open-plan'): void }>()

const router = useRouter()
const { t } = useLocale()
const connectionClass = computed(() => props.connected ? 'online' : props.reconnecting ? 'connecting' : 'offline')
const connectionLabel = computed(() => props.connected
  ? t('mobile.connection_online')
  : props.reconnecting
    ? t('mobile.connection_connecting')
    : t('mobile.connection_offline'))
const displayStatusClass = computed(() => props.isSession && props.sessionStatus
  ? `session-${props.sessionStatus}`
  : connectionClass.value)
const displayStatusLabel = computed(() => props.isSession && props.sessionStatusLabel
  ? props.sessionStatusLabel
  : connectionLabel.value)
</script>

<style scoped>
.mobile-topbar {
  position: fixed;
  inset: 0 0 auto;
  z-index: 70;
  min-height: var(--mobile-topbar-h);
  padding: max(6px, env(safe-area-inset-top)) 12px 6px;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto 44px;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(14px);
}
.mobile-brand {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: var(--bg);
  background: var(--accent);
  font-weight: 800;
}
.mobile-topbar-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.mobile-topbar-title-text,
.mobile-topbar-host {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mobile-topbar-title-text {
  font-size: 15px;
  font-weight: 650;
}
.mobile-topbar-host { color: var(--fg-tertiary); font-size: 11px; font-weight: 500; }
.mobile-topbar-back,
.mobile-topbar-action {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--radius-md);
  color: var(--fg);
  background: transparent;
}
.mobile-topbar-back svg,
.mobile-topbar-action svg {
  width: 22px;
  height: 22px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
}
.mobile-plan-action.active { color: var(--accent); background: var(--accent-muted); }
.mobile-plan-action.complete { color: var(--success); }
.mobile-connection {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--fg-tertiary);
  font-size: 11px;
  white-space: nowrap;
}
.mobile-connection-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--fg-tertiary);
}
.mobile-connection-dot.online { background: var(--success); }
.mobile-connection-dot.connecting { background: var(--warning); }
.mobile-connection-dot.session-running,
.mobile-connection-dot.session-busy,
.mobile-connection-dot.session-retry,
.mobile-connection-dot.session-idle { background: var(--success); }
.mobile-connection-dot.session-waiting,
.mobile-connection-dot.session-waiting_approval,
.mobile-connection-dot.session-exited { background: var(--warning); }
.mobile-connection-dot.session-completed { background: var(--accent); }
.mobile-connection-dot.session-error,
.mobile-connection-dot.session-killed { background: var(--error); }
.mobile-connection-dot.session-disconnected { background: var(--fg-tertiary); }
@media (max-width: 390px) { .mobile-connection span:last-child { display: none; } }
</style>
