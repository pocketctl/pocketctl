<template>
  <span :class="['team-run-status', state, { stopping: stopRequested }]" data-testid="team-run-status">
    <span class="status-dot"></span>{{ label }}
  </span>
</template>

<script setup lang="ts">
import { useLocale } from "../../composables/useLocale"
const { t } = useLocale()
import { computed } from 'vue'
import type { TeamRunState } from '../../types/team'

const props = defineProps<{ state: TeamRunState; stopRequested?: boolean }>()
const label = computed(() => props.stopRequested ? t('workspace.stopping') : ({
  ready: t('workspace.preparing'), running: t('session.status.running'), waiting_input: t('workspace.waiting_supplement'), blocked: t('workspace.blocked'), paused: t('team.session_state.paused'),
  completed: t('team.task_state.completed'), failed: t('workspace.run_failed'), cancelled: t('memory.skills.cancelled'),
} as Record<TeamRunState, string>)[props.state])
</script>

<style scoped>
.team-run-status { display: inline-flex; align-items: center; gap: 6px; width: fit-content; padding: 5px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--fg-secondary); background: var(--bg); font-size: 9px; font-weight: 650; }.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-tertiary); }.running,.ready { color: var(--accent); }.running .status-dot,.ready .status-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }.waiting_input,.paused,.stopping { color: var(--warning); }.waiting_input .status-dot,.paused .status-dot,.stopping .status-dot { background: var(--warning); }.blocked,.failed { color: var(--error); }.blocked .status-dot,.failed .status-dot { background: var(--error); }.completed { color: var(--success); }.completed .status-dot { background: var(--success); }
</style>
