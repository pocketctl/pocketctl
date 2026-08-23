<template>
  <div class="session-agent-picker" title="OpenCode Agent">
    <span class="agent-icon" aria-hidden="true">◎</span>
    <span v-if="loading" data-testid="agent-loading" class="agent-state">Agent…</span>
    <button v-else-if="error" data-testid="agent-retry" class="agent-retry" type="button" @click="$emit('retry')">
      Agent ↻
    </button>
    <select
      v-else
      :value="currentAgent"
      :disabled="disabled || submitting || agents.length === 0"
      aria-label="OpenCode Agent"
      @change="selectAgent"
    >
      <option v-if="currentAgent && !agents.some(agent => agent.name === currentAgent)" :value="currentAgent">
        {{ currentAgent }}
      </option>
      <option v-for="agent in agents" :key="agent.name" :value="agent.name" :title="agent.description">
        {{ agent.name }}
      </option>
    </select>
    <span v-if="submitting" class="agent-spinner" aria-label="Switching Agent"></span>
  </div>
</template>

<script setup lang="ts">
import type { SessionAgentOption } from '../types/opencode-interactions'

defineProps<{
  agents: SessionAgentOption[]
  currentAgent: string
  loading: boolean
  error: string
  disabled: boolean
  submitting: boolean
}>()

const emit = defineEmits<{
  (event: 'select', name: string): void
  (event: 'retry'): void
}>()

function selectAgent(event: Event) {
  emit('select', (event.target as HTMLSelectElement).value)
}
</script>

<style scoped>
.session-agent-picker { display: inline-flex; align-items: center; gap: 4px; min-width: 0; color: var(--fg-tertiary); font-size: 11px; }
.agent-icon { color: var(--accent); font-size: 13px; }
select, .agent-retry { max-width: 116px; padding: 3px 4px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--fg-secondary); font: 500 11px var(--font-mono); cursor: pointer; outline: none; }
select:hover:not(:disabled), .agent-retry:hover { background: var(--surface-hover); color: var(--fg); }
select:disabled { cursor: not-allowed; opacity: .5; }
.agent-retry { color: var(--warning); }
.agent-state { font-family: var(--font-mono); }
.agent-spinner { width: 9px; height: 9px; border: 1.5px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
