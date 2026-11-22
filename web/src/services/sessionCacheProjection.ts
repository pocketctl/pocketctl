import { buildToolCallGrouping } from '../utils/toolGrouping'
/** Allowlisted display fields; deliberately exclude runtime, grants, approvals and local sends. */
const pick = (row: any, fields: string[]) => Object.fromEntries(fields.filter(key => row?.[key] !== undefined).map(key => [key, row[key]]))
export function navigationSessions(rows: any[]): any[] {
  return rows.filter(row => row?.session_id && !row.team_id && !row.share_id && !row.shared).slice(0, 500).map(row => ({
    ...pick(row, ['session_id', 'title', 'daemon_id', 'hostname', 'daemon_alias', 'agent_type', 'project_id', 'created_at', 'last_activity_at', 'archived_at', 'pinned', 'pinned_at', 'manual_rank']),
    status: 'unknown', daemon_online: false, __cached: true,
  }))
}
/** Budget visible text separately from collapsed tools: hundreds of calls must not evict the conversation. */
export function historyPreview(rows: any[]): any[] {
  const grouping = buildToolCallGrouping(rows)
  const projected: any[] = []
  for (const row of rows) {
    if (row.__msg_id && !row.__echo_reconciled || row.streaming || grouping.continuations.has(row)) continue
    if (row.type === 'cached_tool_group') { projected.push(row); continue }
    if (row.type === 'tool_call' && row.tool !== 'AskUserQuestion') {
      const completed = (grouping.groups.get(row) || [row]).filter(item => item.status === 'completed')
      if (completed.length) projected.push({ id: 'cache-tools-' + row.id, call_id: row.call_id, type: 'cached_tool_group', turn_id: row.turn_id,
        count: completed.length, tools: [...new Set(completed.map(item => String(item.tool)))].slice(0, 5) })
    } else if (row.role === 'user' || row.type === 'agent_text' || row.type === 'agent_reasoning') {
      projected.push({ ...pick(row, ['id', 'type', 'role', 'turn_id', 'retry_of_turn_id']),
        content: String(row.content || '').slice(0, 16000), streaming: false })
    }
  }
  const kept: any[] = []
  let texts = 0, tools = 0, bytes = 0
  const encoder = new TextEncoder()
  for (let i = projected.length - 1; i >= 0; i--) {
    const row = projected[i], tool = row.type === 'cached_tool_group'
    if (tool ? tools >= 40 : texts >= 80) continue
    const size = encoder.encode(JSON.stringify(row)).byteLength
    if (bytes + size > 768 * 1024) break
    kept.push(row); bytes += size
    if (tool) tools++; else texts++
  }
  return kept.reverse()
}
export function cacheReadDenied(error: any): boolean {
  return [401, 403, 404].includes(error?.status) || /unauthorized|forbidden|not.found|access.denied|permission.denied|session.deleted/i.test(String(error?.code || error?.message || error || ''))
}
