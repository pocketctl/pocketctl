export interface ResolvedPacketEvidence {
  handle: string
  excerpt: string
  manifest: {
    kind: 'event' | 'artifact' | 'episode'
    source_event_id?: string
    artifact_id?: string
    excerpt_hash?: string
    truncated?: boolean
  }
}

export function resolvePacketEvidence(
  document: unknown,
  manifest: unknown,
  handles: readonly string[],
): ResolvedPacketEvidence[] {
  const excerpts = new Map<string, string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    const handle = typeof object.evidence_handle === 'string' ? object.evidence_handle : null
    const excerpt = typeof object.text === 'string'
      ? object.text
      : (typeof object.summary === 'string' ? object.summary : null)
    if (handle && excerpt && !excerpts.has(handle)) excerpts.set(handle, excerpt)
    for (const child of Object.values(object)) visit(child)
  }
  visit(document)

  const entries = manifest !== null && typeof manifest === 'object'
    ? manifest as Record<string, unknown>
    : {}
  const resolved: ResolvedPacketEvidence[] = []
  for (const handle of handles) {
    const raw = entries[handle]
    const excerpt = excerpts.get(handle)
    if (!excerpt || raw === null || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (entry.kind !== 'event' && entry.kind !== 'artifact' && entry.kind !== 'episode') continue
    resolved.push({
      handle,
      excerpt,
      manifest: {
        kind: entry.kind,
        ...(typeof entry.source_event_id === 'string' ? { source_event_id: entry.source_event_id } : {}),
        ...(typeof entry.artifact_id === 'string' ? { artifact_id: entry.artifact_id } : {}),
        ...(typeof entry.excerpt_hash === 'string' ? { excerpt_hash: entry.excerpt_hash } : {}),
        ...(typeof entry.truncated === 'boolean' ? { truncated: entry.truncated } : {}),
      },
    })
  }
  return resolved
}
