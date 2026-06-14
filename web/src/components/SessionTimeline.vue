<template>
  <div class="session-timeline" v-if="milestones.length > 0">
    <div class="timeline-label">Session Lifecycle</div>
    <div class="timeline-track">
      <div
        v-for="(m, i) in milestones"
        :key="i"
        class="milestone"
        :class="{ active: i === milestones.length - 1, passed: i < milestones.length - 1 }"
      >
        <div class="milestone-dot"></div>
        <div class="milestone-info">
          <span class="milestone-status">{{ statusLabel(m.status) }}</span>
          <span class="milestone-time">{{ formatRelativeTime(m.time) }}</span>
        </div>
        <div v-if="i < milestones.length - 1" class="milestone-line"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatRelativeTime } from '../composables/useRelativeTime'

export interface Milestone {
  status: string
  time: string
}

const props = defineProps<{ milestones: Milestone[] }>()

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    running: 'Running',
    busy: 'Running',
    idle: 'Idle',
    waiting_approval: 'Waiting Approval',
    exited: 'Exited',
    disconnected: 'Disconnected',
    completed: 'Completed',
    error: 'Error',
    killed: 'Killed',
  }
  return labels[status] || status
}
</script>

<style scoped>
.session-timeline {
  padding: 12px 20px 8px;
  border-top: 1px solid #21262d;
  background: #0d1117;
}
.timeline-label {
  font-size: 11px; color: #484f58; text-transform: uppercase;
  letter-spacing: 0.5px; margin-bottom: 8px; font-weight: 600;
}
.timeline-track {
  display: flex; align-items: flex-start; gap: 0; overflow-x: auto;
  padding-bottom: 4px;
}
.milestone {
  display: flex; align-items: center; gap: 6px; position: relative;
  white-space: nowrap; flex-shrink: 0;
}
.milestone-dot {
  width: 10px; height: 10px; border-radius: 50%; background: #484f58;
  flex-shrink: 0; transition: all 0.3s ease;
}
.milestone.active .milestone-dot { background: #22C55E; box-shadow: 0 0 6px #22C55E80; }
.milestone.passed .milestone-dot { background: #6B7280; }
.milestone-line {
  width: 24px; height: 2px; background: #30363d; margin: 0 2px;
  align-self: center; flex-shrink: 0;
}
.milestone-info { display: flex; flex-direction: column; gap: 1px; }
.milestone-status { font-size: 11px; color: #e6edf3; font-weight: 500; }
.milestone-time { font-size: 10px; color: #484f58; }
</style>
