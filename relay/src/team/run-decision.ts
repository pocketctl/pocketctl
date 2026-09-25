export type TeamRunDecision =
  | { action: 'call_agent'; context_version: number; target_offer_id: string; instruction: string }
  | { action: 'request_input'; context_version: number; question: string }
  | { action: 'complete'; context_version: number; summary: string }

export class TeamRunDecisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamRunDecisionError'
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const candidate = fenced?.[1] ?? trimmed
  try {
    const parsed = object(JSON.parse(candidate))
    if (!parsed) throw new Error('not an object')
    return parsed
  } catch {
    throw new TeamRunDecisionError('coordinator response must be one JSON object')
  }
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new TeamRunDecisionError('coordinator decision contains unsupported fields')
  }
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new TeamRunDecisionError(`${field} is invalid`)
  }
  return value.trim()
}

export function parseTeamRunDecision(content: string, input: {
  contextVersion: number
  allowedOfferIds: ReadonlySet<string>
}): TeamRunDecision {
  const value = parseJsonObject(content)
  if (!Number.isSafeInteger(value.context_version) || Number(value.context_version) !== input.contextVersion) {
    throw new TeamRunDecisionError('coordinator decision context version is stale')
  }
  if (value.action === 'call_agent') {
    exactKeys(value, ['action', 'context_version', 'target_offer_id', 'instruction'])
    const targetOfferId = boundedText(value.target_offer_id, 'target_offer_id', 160)
    if (!input.allowedOfferIds.has(targetOfferId)) throw new TeamRunDecisionError('coordinator selected an unavailable Agent')
    return {
      action: 'call_agent', context_version: input.contextVersion, target_offer_id: targetOfferId,
      instruction: boundedText(value.instruction, 'instruction', 16_000),
    }
  }
  if (value.action === 'request_input') {
    exactKeys(value, ['action', 'context_version', 'question'])
    return { action: 'request_input', context_version: input.contextVersion, question: boundedText(value.question, 'question', 4_000) }
  }
  if (value.action === 'complete') {
    exactKeys(value, ['action', 'context_version', 'summary'])
    return { action: 'complete', context_version: input.contextVersion, summary: boundedText(value.summary, 'summary', 16_000) }
  }
  throw new TeamRunDecisionError('coordinator decision action is invalid')
}

export function coordinatorPrompt(input: {
  contextVersion: number
  allowedOfferIds: string[]
  callsRemaining: number
  observation?: string
}): string {
  return [
    'You are the coordinator for a bounded PocketCtl Team collaboration run.',
    'Return exactly one JSON object. Never approve tools, invent users, routes, or Agent IDs.',
    `Frozen context_version: ${input.contextVersion}. Calls remaining after this call: ${input.callsRemaining}.`,
    `Allowed target_offer_id values: ${input.allowedOfferIds.join(', ') || '(none)'}.`,
    'Allowed forms:',
    `{"action":"call_agent","context_version":${input.contextVersion},"target_offer_id":"...","instruction":"..."}`,
    `{"action":"request_input","context_version":${input.contextVersion},"question":"..."}`,
    `{"action":"complete","context_version":${input.contextVersion},"summary":"..."}`,
    input.observation ? `New observation:\n${input.observation}` : 'Choose the next safe action from the shared Context and event history.',
  ].join('\n')
}
