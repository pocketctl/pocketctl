<template>
  <span :class="['team-run-status', state, { stopping: stopRequested }]" data-testid="team-run-status">
    <span class="status-dot"></span>{{ label }}
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { TeamRunState } from '../../types/team'

const props = defineProps<{ state: TeamRunState; stopRequested?: boolean }>()
const label = computed(() => props.stopRequested ? '停止处理中' : ({
  ready: '准备中', running: '运行中', waiting_input: '等待补充', blocked: '已阻塞', paused: '已暂停',
  completed: '已完成', failed: '失败退出', cancelled: '已取消',
} as Record<TeamRunState, string>)[props.state])
</script>

<style scoped>
.team-run-status { display: inline-flex; align-items: center; gap: 6px; width: fit-content; padding: 5px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--fg-secondary); background: var(--bg); font-size: 9px; font-weight: 650; }.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg-tertiary); }.running,.ready { color: var(--accent); }.running .status-dot,.ready .status-dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-muted); }.waiting_input,.paused,.stopping { color: var(--warning); }.waiting_input .status-dot,.paused .status-dot,.stopping .status-dot { background: var(--warning); }.blocked,.failed { color: var(--error); }.blocked .status-dot,.failed .status-dot { background: var(--error); }.completed { color: var(--success); }.completed .status-dot { background: var(--success); }
</style>
