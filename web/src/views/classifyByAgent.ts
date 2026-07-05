/**
 * P2: Route an event to the correct message array based on agent_id.
 * If the event carries a non-empty agent_id (or agentId), returns the
 * per-agent bucket in subagentMessages (initialising it if needed).
 * Otherwise returns the defaultTarget (parent-session messages).
 */
export function resolveAgentTarget(
  evt: any,
  subagentMessages: Record<string, any[]>,
  defaultTarget: any[],
): any[] {
  const agentId = evt.agent_id || evt.agentId || ''
  if (!agentId) return defaultTarget
  if (!subagentMessages[agentId]) subagentMessages[agentId] = []
  return subagentMessages[agentId]
}
