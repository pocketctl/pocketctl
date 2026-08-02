<template>
  <section class="plan-progress-content" :data-complete="allCompleted || undefined">
    <div class="plan-heading-row">
      <div>
        <h2 class="plan-heading">{{ t('plan.title') }}</h2>
        <div class="plan-count">{{ t('plan.progress_count', { completed, total: plan.items.length }) }}</div>
      </div>
      <slot name="actions" />
    </div>

    <div
      class="plan-progress-track"
      role="progressbar"
      :aria-label="t('plan.progress_aria')"
      aria-valuemin="0"
      :aria-valuemax="plan.items.length"
      :aria-valuenow="completed"
    >
      <span :style="{ width: `${progressPercent}%` }" />
    </div>

    <p v-if="!connected" class="plan-sync-state" role="status">{{ t('plan.last_sync') }}</p>
    <p v-if="plan.explanation" class="plan-explanation">{{ plan.explanation }}</p>

    <ol class="plan-step-list">
      <li
        v-for="(item, index) in plan.items"
        :key="`${index}:${item.step}`"
        :class="['plan-step', statusClass(item.status)]"
        :data-plan-status="item.status"
        :aria-label="t('plan.step_aria', { status: statusLabel(item.status), step: item.step })"
      >
        <span class="plan-step-icon" aria-hidden="true">
          <svg v-if="item.status === 'completed'" viewBox="0 0 20 20"><path d="m5 10 3 3 7-7" /></svg>
          <span v-else-if="item.status === 'in_progress'" class="plan-active-dot" />
        </span>
        <span :class="['plan-step-label', { struck: item.status === 'completed' }]">{{ item.step }}</span>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { completedPlanItemCount, type AgentPlanSnapshot, type AgentPlanStatus } from '../../utils/agentPlanMerge'

const props = defineProps<{ plan: AgentPlanSnapshot; connected: boolean }>()
const { t } = useLocale()
const completed = computed(() => completedPlanItemCount(props.plan))
const allCompleted = computed(() => completed.value === props.plan.items.length)
const progressPercent = computed(() => props.plan.items.length ? completed.value / props.plan.items.length * 100 : 0)

function statusClass(status: AgentPlanStatus): string {
  return status === 'in_progress' ? 'in-progress' : status
}

function statusLabel(status: AgentPlanStatus): string {
  return t(`plan.status.${status}`)
}
</script>

<style scoped>
.plan-progress-content { min-height: 0; color: var(--fg); }
.plan-heading-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.plan-heading { margin: 0; font-size: 15px; line-height: 1.35; font-weight: 650; }
.plan-count { margin-top: 3px; color: var(--fg-tertiary); font-size: 12px; }
.plan-progress-track { height: 3px; margin: 14px 0 0; overflow: hidden; border-radius: var(--radius-full); background: var(--border); }
.plan-progress-track > span { display: block; height: 100%; border-radius: inherit; background: var(--accent); transition: width 180ms ease; }
.plan-sync-state { margin: 12px 0 0; padding: 8px 10px; border-radius: var(--radius-md); background: var(--surface-hover); color: var(--fg-tertiary); font-size: 12px; }
.plan-explanation { margin: 14px 0 0; color: var(--fg-secondary); font-size: 12px; line-height: 1.55; }
.plan-step-list { display: flex; flex-direction: column; gap: 2px; margin: 14px 0 0; padding: 0; list-style: none; }
.plan-step { min-height: 44px; display: grid; grid-template-columns: 22px minmax(0, 1fr); align-items: start; gap: 9px; padding: 10px 8px; border-radius: var(--radius-md); color: var(--fg-secondary); }
.plan-step.in-progress { background: var(--accent-muted); color: var(--fg); }
.plan-step.completed { color: var(--fg-tertiary); }
.plan-step-icon { width: 18px; height: 18px; display: grid; place-items: center; margin-top: 1px; border: 1.5px solid var(--border-light); border-radius: 50%; }
.plan-step.in-progress .plan-step-icon { border-color: var(--accent); }
.plan-step.completed .plan-step-icon { border-color: var(--success); color: var(--success); }
.plan-step-icon svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.plan-active-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.plan-step-label { min-width: 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.plan-step-label.struck { text-decoration: line-through; text-decoration-thickness: 1px; }
@media (prefers-reduced-motion: reduce) { .plan-progress-track > span { transition: none; } }
</style>
