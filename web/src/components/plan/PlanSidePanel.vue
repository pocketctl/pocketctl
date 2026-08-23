<template>
  <aside class="plan-side-panel" :aria-label="t('plan.title')">
    <PlanProgressContent :plan="plan" :connected="connected">
      <template #actions>
        <button type="button" class="plan-panel-close" :aria-label="t('plan.close')" @click="$emit('close')">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </template>
    </PlanProgressContent>
  </aside>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import type { AgentPlanSnapshot } from '../../utils/agentPlanMerge'
import PlanProgressContent from './PlanProgressContent.vue'

defineProps<{ plan: AgentPlanSnapshot; connected: boolean }>()
defineEmits<{ (event: 'close'): void }>()
const { t } = useLocale()
</script>

<style scoped>
.plan-side-panel { width: 340px; min-width: 320px; max-width: 380px; height: 100%; flex: 0 0 340px; overflow-y: auto; padding: 18px 16px; border-left: 1px solid var(--border); background: var(--surface); }
.plan-panel-close { width: 44px; height: 44px; display: grid; place-items: center; margin: -10px -10px 0 0; border: 0; border-radius: var(--radius-md); color: var(--fg-secondary); background: transparent; cursor: pointer; }
.plan-panel-close:hover { color: var(--fg); background: var(--surface-hover); }
.plan-panel-close svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
@media (max-width: 1120px) and (min-width: 769px) {
  .plan-side-panel { position: absolute; z-index: 45; inset: 0 0 0 auto; box-shadow: -12px 0 32px rgba(0, 0, 0, .18); }
}
@media (max-width: 768px) { .plan-side-panel { display: none; } }
</style>
