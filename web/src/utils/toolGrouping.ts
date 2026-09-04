import { isDiffTool } from './diffRender'

export interface ToolCallGrouping<T> {
  groups: Map<T, T[]>
  continuations: Set<T>
}

function field(message: any, snake: string, camel: string): string {
  const value = message?.[snake] ?? message?.[camel]
  return typeof value === 'string' ? value : ''
}

export function isCompactToolCall(message: any): boolean {
  return message?.type === 'tool_call'
    && message.tool !== 'AskUserQuestion'
    && !isDiffTool(message.tool)
}

function sharesDisplayBoundary(left: any, right: any): boolean {
  return field(left, 'turn_id', 'turnId') === field(right, 'turn_id', 'turnId')
    && field(left, 'flow_scope', 'flowScope') === field(right, 'flow_scope', 'flowScope')
    && field(left, 'actor_scope', 'actorScope') === field(right, 'actor_scope', 'actorScope')
}

/**
 * Index consecutive ordinary tool calls without changing the source messages.
 * Special cards and turn/lane/actor boundaries always terminate a group.
 */
export function buildToolCallGrouping<T>(messages: readonly T[]): ToolCallGrouping<T> {
  const groups = new Map<T, T[]>()
  const continuations = new Set<T>()

  for (let index = 0; index < messages.length; index++) {
    const first = messages[index]
    if (!isCompactToolCall(first)) continue

    const group = [first]
    let cursor = index + 1
    while (
      cursor < messages.length
      && isCompactToolCall(messages[cursor])
      && sharesDisplayBoundary(first, messages[cursor])
    ) {
      group.push(messages[cursor])
      continuations.add(messages[cursor])
      cursor++
    }
    groups.set(first, group)
    index = cursor - 1
  }

  return { groups, continuations }
}
