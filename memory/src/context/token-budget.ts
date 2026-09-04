/**
 * Conservative token budgeting (plan 3.4/7.4). The estimator deliberately
 * OVERESTIMATES (3 bytes per token) so a rendered pack can never overflow a
 * real tokenizer. Pruning removes whole items only — never a truncated
 * codepoint or reference — lowest-ranked dynamic items first, then
 * non-pinned stable items.
 */

export interface BudgetItem {
  key: string
  section: 'stable' | 'dynamic'
  estimatedTokens: number
  /** Rank within the section (higher = keep longer). */
  rank: number
  pinned: boolean
}

/** Conservative estimate: ceil(UTF-8 bytes / 3), minimum 1 per item. */
export function estimateTokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8')
  return Math.max(1, Math.ceil(bytes / 3))
}

export interface BudgetOutcome {
  kept: string[]
  pruned: string[]
}

export function applyTokenBudget(input: {
  items: readonly BudgetItem[]
  stableTokens: number
  dynamicTokens: number
  maxItems: number
}): BudgetOutcome {
  const stable = input.items
    .filter(item => item.section === 'stable')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.rank - a.rank || (a.key < b.key ? -1 : 1))
  const dynamic = input.items
    .filter(item => item.section === 'dynamic')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.rank - a.rank || (a.key < b.key ? -1 : 1))

  const kept: string[] = []
  const pruned: string[] = []
  let stableUsed = 0
  let dynamicUsed = 0

  const admit = (item: BudgetItem): boolean => {
    if (kept.length >= input.maxItems) return false
    if (item.section === 'stable') {
      if (stableUsed + item.estimatedTokens > input.stableTokens) return false
      stableUsed += item.estimatedTokens
    } else {
      if (dynamicUsed + item.estimatedTokens > input.dynamicTokens) return false
      dynamicUsed += item.estimatedTokens
    }
    kept.push(item.key)
    return true
  }

  for (const item of [...stable, ...dynamic]) {
    if (!admit(item)) pruned.push(item.key)
  }
  return { kept, pruned }
}

/**
 * Near-duplicate detection before pruning: identical normalized identity, or
 * rendered text equal after collapsing whitespace/case, collapses to the
 * higher-ranked entry.
 */
export function dedupeItems<T extends {
  normalizedKey: string
  renderedText: string
  rank: number
}>(items: readonly T[]): T[] {
  const byIdentity = new Map<string, T>()
  const byRendered = new Map<string, T>()
  const sorted = [...items].sort((a, b) => b.rank - a.rank || (a.normalizedKey < b.normalizedKey ? -1 : 1))
  const kept: T[] = []
  for (const item of sorted) {
    const renderedKey = item.renderedText.toLowerCase().replace(/\s+/g, ' ').trim()
    const identityHit = byIdentity.get(item.normalizedKey)
    const renderedHit = byRendered.get(renderedKey)
    if (identityHit || renderedHit) continue
    byIdentity.set(item.normalizedKey, item)
    byRendered.set(renderedKey, item)
    kept.push(item)
  }
  return kept
}
