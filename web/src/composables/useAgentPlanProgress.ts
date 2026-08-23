import { computed, reactive, toValue, type MaybeRefOrGetter } from 'vue'
import { mergeAgentPlan, type AgentPlanSnapshot } from '../utils/agentPlanMerge'

const plans = reactive<Record<string, AgentPlanSnapshot | undefined>>({})

export function useAgentPlanProgress() {
  function acceptAgentPlan(event: unknown): AgentPlanSnapshot | undefined {
    const payload = (event as any)?.payload && typeof (event as any).payload === 'object'
      ? (event as any).payload
      : event as any
    const sessionId = String(payload?.session_id ?? payload?.sessionId ?? '')
    if (!sessionId) return undefined
    plans[sessionId] = mergeAgentPlan(plans[sessionId], event)
    return plans[sessionId]
  }

  function planForSession(sessionId: MaybeRefOrGetter<string>) {
    return computed(() => plans[toValue(sessionId)])
  }

  return { acceptAgentPlan, planForSession }
}

export function resetAgentPlanProgressForTests(): void {
  for (const sessionId of Object.keys(plans)) delete plans[sessionId]
}
