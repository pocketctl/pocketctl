export interface TokenDashboardLike {
  summary?: Record<string, unknown>
  dailySeries?: Array<Record<string, unknown>>
  byModel?: Array<Record<string, unknown>>
  byDaemon?: Array<Record<string, unknown>>
}

export interface TokenDashboardComparison {
  matches: boolean
  differingValues: number
  maxAbsoluteDelta: number
}

function amount(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function numericVector(dashboard: TokenDashboardLike): Map<string, number> {
  const values = new Map<string, number>()
  const summary = dashboard.summary ?? {}
  for (const field of ['total', 'today', 'thisWeek', 'thisMonth']) {
    values.set(`summary:${field}`, amount(summary[field]))
  }
  for (const row of dashboard.dailySeries ?? []) {
    const date = String(row.date ?? '')
    for (const field of ['input', 'output', 'cache_read', 'requests']) {
      values.set(`daily:${date}:${field}`, amount(row[field]))
    }
  }
  for (const row of dashboard.byModel ?? []) {
    const model = String(row.model ?? '')
    for (const field of ['input', 'output', 'cache_read', 'requests']) {
      values.set(`model:${model}:${field}`, amount(row[field]))
    }
  }
  for (const row of dashboard.byDaemon ?? []) {
    const daemon = String(row.daemon_id ?? '')
    for (const field of ['input', 'output', 'cache_read', 'requests']) {
      values.set(`daemon:${daemon}:${field}`, amount(row[field]))
    }
  }
  return values
}

/** Returns aggregate drift only; callers never log user, daemon or model keys. */
export function compareTokenDashboards(
  legacy: TokenDashboardLike,
  candidate: TokenDashboardLike,
): TokenDashboardComparison {
  const left = numericVector(legacy)
  const right = numericVector(candidate)
  const keys = new Set([...left.keys(), ...right.keys()])
  let differingValues = 0
  let maxAbsoluteDelta = 0
  for (const key of keys) {
    const delta = Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0))
    if (delta === 0) continue
    differingValues += 1
    maxAbsoluteDelta = Math.max(maxAbsoluteDelta, delta)
  }
  return { matches: differingValues === 0, differingValues, maxAbsoluteDelta }
}
