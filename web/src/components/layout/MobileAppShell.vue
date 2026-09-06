<template>
  <div class="mobile-app-shell">
    <MobileTopBar
      v-if="showTopBar"
      :title="title"
      :connected="connected"
      :reconnecting="reconnecting"
      :is-session="isSession"
      :show-new-session="showNewSession"
      :show-plan="!!plan && !isSession"
      :plan-label="planLabel"
      :plan-open="planOpen"
      :plan-complete="planComplete"
      :session-host="sessionHost"
      :session-host-id="sessionHostId"
      :session-status="sessionStatus"
      :session-status-label="sessionStatusLabel"
      @new-session="$emit('new-session')"
      @open-plan="openPlan"
    />
    <MobileBottomNav v-if="showBottomNav" :session-count="sessionCount" />
    <PlanBottomSheet
      v-if="plan && planOpen"
      :plan="plan"
      :connected="connected"
      @close="requestClosePlan"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import MobileBottomNav from './MobileBottomNav.vue'
import MobileTopBar from './MobileTopBar.vue'
import PlanBottomSheet from '../plan/PlanBottomSheet.vue'
import { useLocale } from '../../composables/useLocale'
import { completedPlanItemCount, type AgentPlanSnapshot } from '../../utils/agentPlanMerge'

const props = defineProps<{
  title: string
  connected: boolean
  reconnecting: boolean
  isSession: boolean
  showTopBar: boolean
  showBottomNav: boolean
  showNewSession: boolean
  sessionCount: number
  plan?: AgentPlanSnapshot
  sessionHost?: string
  sessionHostId?: string
  sessionStatus?: string
  sessionStatusLabel?: string
}>()

defineEmits<{ (event: 'new-session'): void }>()
const { t } = useLocale()
const planOpen = ref(false)
const completed = computed(() => props.plan ? completedPlanItemCount(props.plan) : 0)
const planComplete = computed(() => !!props.plan && completed.value === props.plan.items.length)
const planLabel = computed(() => props.plan
  ? t('plan.open', { completed: completed.value, total: props.plan.items.length })
  : '')
let ownsHistoryEntry = false
let previousFocus: HTMLElement | null = null
let previousBodyOverflow = ''

function restoreFocus() {
  const target = previousFocus
  previousFocus = null
  target?.focus()
}

function closeFromHistory() {
  if (!planOpen.value) return
  planOpen.value = false
  ownsHistoryEntry = false
  restoreFocus()
}

function openPlan() {
  if (!props.plan || planOpen.value) return
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousFocus?.blur()
  window.history.pushState({ ...window.history.state, pocketctlPlanSheet: true }, '')
  ownsHistoryEntry = true
  planOpen.value = true
}

function requestClosePlan() {
  if (ownsHistoryEntry) window.history.back()
  else closeFromHistory()
}

function openPlanFromSessionActions() {
  if (props.isSession && props.plan) openPlan()
}

watch(planOpen, (open) => {
  if (open) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = previousBodyOverflow
  }
})

watch(() => props.plan, plan => {
  if (!plan && planOpen.value) requestClosePlan()
})

onMounted(() => {
  window.addEventListener('popstate', closeFromHistory)
  window.addEventListener('pocketctl:open-mobile-session-plan', openPlanFromSessionActions)
})
onUnmounted(() => {
  window.removeEventListener('popstate', closeFromHistory)
  window.removeEventListener('pocketctl:open-mobile-session-plan', openPlanFromSessionActions)
  document.body.style.overflow = previousBodyOverflow
})
</script>
