<template>
  <span :class="['agent-badge', kind, `size-${size}`]" :title="label">
    <svg class="agent-logo" :width="iconSize" :height="iconSize" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <!-- Claude Code: terracotta radiating asterisk (Claude-style mark) -->
      <g v-if="kind === 'claude'" fill="currentColor">
        <path d="M12 2.5l1.7 7.2 5.5-4.9-3.2 6.6 7.3-.4-6.6 3.1 4.9 5.4-7.2-1.6L14 25l-2-7.2-1.7 7.2-.4-7.3-6.6 3.2 4.9-5.5L1 14.3l7.2.4L5 8.1l5.5 4.9z" transform="scale(0.62) translate(7.3 7.3)" />
      </g>
      <!-- Codex CLI: green code brackets < > -->
      <g v-else-if="kind === 'codex'" data-agent-icon="codex" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <polyline points="9,7 4,12 9,17" />
        <polyline points="15,7 20,12 15,17" />
      </g>
      <!-- Codex Desktop: same green family, with a desktop-window frame -->
      <g v-else-if="kind === 'codex-desktop'" data-agent-icon="codex-desktop" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <rect x="2.5" y="4" width="19" height="14" rx="2" />
        <path d="M8 21h8M12 18v3" />
        <path d="m9 8-3 3 3 3M15 8l3 3-3 3" />
      </g>
      <!-- OpenCode: purple terminal prompt >_ -->
      <g v-else-if="kind === 'opencode'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <polyline points="5,8 10,12 5,16" />
        <line x1="13" y1="16" x2="19" y2="16" />
      </g>
      <!-- ZCode: read-only eye (observer sync) -->
      <g v-else-if="kind === 'zcode'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </g>
    </svg>
    <span class="agent-text">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { AGENT_DISPLAY_NAMES } from '../utils/agentDisplay'

const props = withDefaults(defineProps<{
  /** raw agent_type value (e.g. 'claude-code', 'codex', 'opencode'); unknown → claude */
  agent?: string
  size?: 'sm' | 'md'
}>(), {
  agent: 'claude-code',
  size: 'sm',
})

// normalized visual kind
const kind = computed<'claude' | 'codex' | 'codex-desktop' | 'opencode' | 'zcode'>(() => {
  const a = (props.agent || '').toLowerCase()
  if (a === 'codex') return 'codex'
  if (a === 'codex-desktop') return 'codex-desktop'
  if (a === 'opencode') return 'opencode'
  if (a === 'zcode') return 'zcode'
  return 'claude'
})

const label = computed(() => AGENT_DISPLAY_NAMES[props.agent] || AGENT_DISPLAY_NAMES['claude-code'])

const iconSize = computed(() => props.size === 'md' ? 14 : 12)
</script>

<style scoped>
.agent-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  font-family: var(--font-body, inherit);
  vertical-align: middle;
}
.agent-badge .agent-logo { flex-shrink: 0; }
.agent-badge.size-md { font-size: 12px; padding: 2px 9px; gap: 5px; }

/* Claude Code — terracotta */
.agent-badge.claude { background: rgba(217, 119, 87, 0.14); color: #d97757; }
/* Codex — green */
.agent-badge.codex { background: rgba(63, 185, 80, 0.14); color: #3fb950; }
/* Codex Desktop — green family with a distinct framed icon/badge */
.agent-badge.codex-desktop { background: rgba(63, 185, 80, 0.2); color: #2ea043; box-shadow: inset 0 0 0 1px rgba(63, 185, 80, 0.18); }
/* OpenCode — purple */
.agent-badge.opencode { background: rgba(167, 139, 250, 0.14); color: #a78bfa; }
/* ZCode — teal (read-only observer) */
.agent-badge.zcode { background: rgba(20, 184, 166, 0.14); color: #14b8a6; }
</style>
