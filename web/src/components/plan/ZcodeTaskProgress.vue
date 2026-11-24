<template>
  <button ref="anchor" type="button" class="zcode-task-progress"
    :data-complete="status === 'completed' || undefined"
    :aria-label="t('plan.open', { completed, total: plan.items.length })"
    :aria-expanded="open" @click="open = !open">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m2 5 1.5 1.5L6 3.5M9 5h8M2 12l1.5 1.5L6 10.5M9 12h8"/></svg>
    {{ t('plan.status.' + status) }} <span>{{ completed }}/{{ plan.items.length }}</span>
  </button>
  <ActionList v-if="open" :anchor="anchor" :title="t('plan.title')" :mobile-sheet="true" prefer-above @close="open = false">
    <PlanProgressContent :plan="plan" :connected="connected" :show-heading="false" />
  </ActionList>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ActionList from '../ActionList.vue'
import PlanProgressContent from './PlanProgressContent.vue'
import { useLocale } from '../../composables/useLocale'
import { completedPlanItemCount, type AgentPlanSnapshot } from '../../utils/agentPlanMerge'

const props = defineProps<{ plan: AgentPlanSnapshot; connected: boolean }>()
const { t } = useLocale()
const open = ref(false)
const anchor = ref<HTMLButtonElement | null>(null)
const completed = computed(() => completedPlanItemCount(props.plan))
const status = computed(() => completed.value === props.plan.items.length ? 'completed'
  : props.plan.items.some(item => item.status === 'in_progress') ? 'in_progress' : 'pending')
</script>

<style scoped>
.zcode-task-progress { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface); color: var(--fg); box-shadow: var(--shadow-sm); font: 600 13px var(--font-body); pointer-events: auto; cursor: pointer; }
.zcode-task-progress:hover { background: var(--surface-hover); }
.zcode-task-progress svg { width: 16px; height: 16px; fill: none; stroke: var(--accent); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.zcode-task-progress[data-complete] svg { stroke: var(--success); }
.zcode-task-progress span { color: var(--fg-secondary); font-variant-numeric: tabular-nums; }
@media (max-width: 768px) { .zcode-task-progress { min-height: 44px; } }
</style>
