export interface RevisionedPartEvent {
  type: 'agent_text' | 'agent_reasoning'
  text?: string
  message_id?: string
  part_id?: string
  revision?: number
  replace?: boolean
  streaming?: boolean
  usage?: unknown
}

export type PartMergeResult = 'inserted' | 'updated' | 'ignored' | 'legacy'

/**
 * Applies an OpenCode mutable Part event to a chat message list. Part identity,
 * rather than list adjacency, lets a text/reasoning Part continue after tool
 * cards have been inserted into the stream.
 */
export function mergeRevisionedPart(target: any[], event: RevisionedPartEvent): PartMergeResult {
  const partId = event.part_id
  const revision = event.revision
  if (!partId || !revision || revision < 1) return 'legacy'

  const existing = target.find((message) => message.partId === partId)
  if (!existing) {
    target.push({
      id: `part:${partId}`,
      type: event.type,
      role: 'agent',
      content: event.text ?? '',
      streaming: event.streaming ?? false,
      messageId: event.message_id,
      partId,
      revision,
      usage: event.usage,
    })
    return 'inserted'
  }

  if ((existing.revision ?? 0) >= revision) return 'ignored'

  existing.content = event.replace
    ? (event.text ?? '')
    : `${existing.content ?? ''}${event.text ?? ''}`
  existing.revision = revision
  existing.streaming = event.streaming ?? false
  if (event.message_id) existing.messageId = event.message_id
  if (event.usage) existing.usage = event.usage
  return 'updated'
}
