import { computed, reactive, toValue, type MaybeRefOrGetter } from 'vue'
import { mergeAgentPlan, normalizeAgentPlanEvent, type AgentPlanSnapshot } from '../utils/agentPlanMerge'

const plans = reactive<Record<string, AgentPlanSnapshot | undefined>>({})

export function useAgentPlanProgress() {
  function acceptAgentPlan(event: unknown): AgentPlanSnapshot | undefined {
    const incoming = normalizeAgentPlanEvent(event)
    if (!incoming) return undefined
    const key = JSON.stringify([incoming.sessionId, incoming.partId])
    plans[key] = mergeAgentPlan(plans[key], event)
    return plans[key]
  }

  function planForSession(sessionId: MaybeRefOrGetter<string>) {
    return computed(() => {
      const lists = Object.values(plans).filter((p): p is AgentPlanSnapshot => !!p && p.sessionId === toValue(sessionId) && p.items.length > 0)
        .sort((a, b) => a.partId.localeCompare(b.partId))
      if (lists.length < 2) return lists[0]
      return { ...lists[0], title: undefined, explanation: '', items: lists.flatMap(p => p.items.map((item, i) => ({ ...item, sourceTitle: i === 0 ? p.title || 'Agent plan' : undefined }))) }
    })
  }

  return { acceptAgentPlan, planForSession }
}

export function resetAgentPlanProgressForTests(): void {
  for (const sessionId of Object.keys(plans)) delete plans[sessionId]
}
