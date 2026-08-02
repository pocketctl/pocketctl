const settledSessionStatuses = new Set([
  'idle',
  'completed',
  'exited',
  'error',
  'killed',
])

type ToolMessage = {
  type?: string
  status?: string
}

// A replayed tool call without a result is not evidence that the tool is still
// running once its session has settled. Keep this client-only state distinct
// from timeout: a late tool_result can still upgrade it to completed.
export function reconcileUnresolvedTools(messages: ToolMessage[], sessionStatus: string): void {
  if (!settledSessionStatuses.has(sessionStatus)) return
  for (const message of messages) {
    if (message.type === 'tool_call' && message.status === 'running') {
      message.status = 'unknown'
    }
  }
}
