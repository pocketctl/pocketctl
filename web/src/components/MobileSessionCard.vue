<template>
  <div class="mobile-card-stack">
    <article
      class="mobile-session-card"
      :class="{ 'pending-delete': session.__pendingDelete }"
      role="button"
      tabindex="0"
      @click="openSession"
      @keydown.enter.prevent="openSession"
      @keydown.space.prevent="openSession"
    >
      <span class="mobile-status-dot" :class="effectiveStatus" aria-hidden="true">
        <span v-if="isActive" class="pulse-ring"></span>
        <span v-if="effectiveStatus === 'completed'" class="status-icon">✓</span>
        <span v-else-if="effectiveStatus === 'killed'" class="status-icon">✕</span>
      </span>

      <div class="mobile-card-content">
        <div class="mobile-card-title-row">
          <svg v-if="session.pinned" class="mobile-pin" viewBox="0 0 16 16" aria-label="已置顶">
            <path d="M10.8 1.6 14.4 5.2l-2 1.2-.8 3.2-1 1-2.2-2.2-4.8 4.8-.8-.8 4.8-4.8-2.2-2.2 1-1 3.2-.8 1.2-2Z" />
          </svg>
          <span class="mobile-card-title">{{ session.title || session.session_id.slice(0, 8) }}</span>
          <span class="mobile-source-chip" :class="session.source">{{ sourceLabel }}</span>
        </div>

        <div class="mobile-card-meta-row">
          <AgentBadge :agent="session.agent" size="sm" />
          <span v-if="session.model" class="mobile-model" :title="session.model">{{ session.model }}</span>
          <span v-if="session.subagent_count > 0" class="mobile-subagents">
            {{ session.subagent_count }} 子智能体
          </span>
        </div>

        <div class="mobile-card-footer">
          <span class="mobile-hostname">{{ session.hostname || '—' }}</span>
          <span class="mobile-relative-time">{{ relativeTime }}</span>
        </div>
      </div>

      <button
        v-if="hasChildren"
        class="mobile-subagent-toggle"
        type="button"
        :aria-label="expanded ? '收起子智能体' : '展开子智能体'"
        :aria-expanded="expanded"
        @click.stop="$emit('toggle-subagents')"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" :class="{ expanded }">
          <path d="m6 3.5 4.5 4.5L6 12.5" />
        </svg>
      </button>
    </article>

    <div v-if="session.exit_reason" class="mobile-exit-card">
      <span aria-hidden="true">!</span>
      {{ exitReasonLabel }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AgentBadge from './AgentBadge.vue'

const props = defineProps<{
  session: any
  effectiveStatus: string
  relativeTime: string
  expanded: boolean
}>()

const emit = defineEmits<{
  open: []
  'toggle-subagents': []
}>()

const isActive = computed(() => ['running', 'busy', 'retry'].includes(props.effectiveStatus))
const hasChildren = computed(() => Boolean(props.session.children?.length))
const sourceLabel = computed(() => props.session.source === 'terminal' ? '终端' : 'Web')
const exitReasonLabel = computed(() => ({
  user_interrupt: '用户中断',
  normal_exit: '正常退出',
  process_crash: '异常退出',
  signal_kill: '被终止',
  unknown: '已退出',
} as Record<string, string>)[props.session.exit_reason] || '已退出')

function openSession() {
  if (!props.session.__pendingDelete) emit('open')
}
</script>

<style scoped>
.mobile-card-stack { position: relative; }
.mobile-session-card {
  display: flex;
  min-height: 76px;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 14px;
  border: 1px solid var(--border, #21262d);
  border-radius: 12px;
  background: var(--surface, #161b22);
  cursor: pointer;
  transition: border-color .15s, background .15s, opacity .25s;
}
.mobile-session-card:active { background: var(--surface-hover, #1c2129); }
.mobile-session-card:focus-visible { outline: 2px solid var(--accent, #58a6ff); outline-offset: 2px; }
.mobile-session-card.pending-delete { pointer-events: none; opacity: .35; }
.mobile-status-dot {
  position: relative;
  display: grid;
  width: 10px;
  height: 10px;
  flex: 0 0 10px;
  place-items: center;
  margin-top: 6px;
  border-radius: 50%;
  background: #6b7280;
}
.mobile-status-dot.running { background: #22c55e; }
.mobile-status-dot.busy { background: #d29922; }
.mobile-status-dot.idle { background: #eab308; }
.mobile-status-dot.waiting_approval { background: #f97316; }
.mobile-status-dot.waiting_question { background: #a855f7; }
.mobile-status-dot.completed { background: #9ca3af; color: white; }
.mobile-status-dot.error { background: #ef4444; }
.mobile-status-dot.killed { background: #dc2626; color: white; }
.mobile-status-dot.disconnected { border: 2px dashed #3b82f6; background: transparent; }
.pulse-ring {
  position: absolute;
  inset: -3px;
  border: 2px solid currentColor;
  border-radius: 50%;
  color: inherit;
  animation: mobile-pulse 1.5s infinite;
}
.mobile-status-dot.running .pulse-ring { color: #22c55e; }
.mobile-status-dot.busy .pulse-ring { color: #d29922; }
.status-icon { font-size: 8px; font-weight: 800; line-height: 1; }
.mobile-card-content { min-width: 0; flex: 1; }
.mobile-card-title-row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}
.mobile-pin { width: 13px; height: 13px; flex: 0 0 13px; fill: var(--accent, #58a6ff); }
.mobile-card-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--fg, #e6edf3);
  font-size: 16px;
  font-weight: 600;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mobile-source-chip {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--accent-muted, rgba(88, 166, 255, .14));
  color: var(--accent, #58a6ff);
  font-size: 10px;
  font-weight: 650;
  line-height: 14px;
}
.mobile-source-chip.terminal { background: rgba(31, 111, 235, .14); color: #79c0ff; }
.mobile-card-meta-row {
  display: flex;
  height: 20px;
  min-width: 0;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  overflow: hidden;
}
.mobile-model {
  min-width: 0;
  overflow: hidden;
  color: var(--fg-tertiary, #8b949e);
  font: 11px/16px var(--font-mono, ui-monospace, monospace);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mobile-subagents {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(192, 132, 252, .12);
  color: #c084fc;
  font-size: 10px;
  line-height: 14px;
}
.mobile-card-footer {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 3px;
  color: var(--fg-tertiary, #8b949e);
  font-size: 11px;
  line-height: 16px;
}
.mobile-hostname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobile-relative-time { flex: 0 0 auto; white-space: nowrap; }
.mobile-subagent-toggle {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  place-items: center;
  margin: 1px -4px 0 0;
  padding: 0;
  border: 1px solid var(--sub-agent, #c084fc);
  border-radius: 50%;
  background: var(--sub-agent-bg, rgba(192, 132, 252, .12));
  color: var(--sub-agent, #c084fc);
}
.mobile-subagent-toggle:active { background: var(--sub-agent, #c084fc); color: var(--surface, #161b22); }
.mobile-subagent-toggle svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; transition: transform .18s; }
.mobile-subagent-toggle svg.expanded { transform: rotate(90deg); }
.mobile-exit-card {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: -5px 6px 0;
  padding: 10px 10px 7px;
  border: 1px solid color-mix(in srgb, var(--warning, #d29922) 30%, transparent);
  border-top: 0;
  border-radius: 0 0 10px 10px;
  background: var(--warning-bg, rgba(210, 153, 34, .08));
  color: var(--warning, #d29922);
  font-size: 11px;
}
.mobile-exit-card span { font-weight: 800; }
@keyframes mobile-pulse {
  0% { opacity: .8; transform: scale(1); }
  100% { opacity: 0; transform: scale(1.6); }
}
@media (prefers-reduced-motion: reduce) {
  .pulse-ring { animation: none; }
  .mobile-subagent-toggle svg { transition: none; }
}
</style>
