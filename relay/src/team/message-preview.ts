// Public list presentation only. Keep the original Event bytes unchanged for
// the timeline, copying, references and audit history.
export function teamMessagePreview(content: string | null, kind: string | null): string | null {
  if (content === null) return null
  let preview = content
  if (kind === 'agent_message') {
    try {
      const json = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
      const value = JSON.parse(json)
      if (value && typeof value.summary === 'string' && value.summary.trim()) preview = value.summary
    } catch { /* Ordinary prose and unfinished streams retain their public content. */ }
  }
  return preview.replace(/\s+/g, ' ').trim().slice(0, 240)
}
