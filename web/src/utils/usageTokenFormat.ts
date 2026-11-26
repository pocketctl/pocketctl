import type { UsageAmounts, UsageComposition } from '../types/usage'

/** Decimal SI units for display only; retain exact server integers for accounting. */
export function formatUsageTokens(value: string | bigint | number | null | undefined): string {
  if (value === null || value === undefined || !/^\d+$/.test(String(value))) return '—'
  const amount = BigInt(value)
  const units = ['', 'K', 'M', 'G', 'T']
  let unit = 0, divisor = 1n
  while (unit < units.length - 1 && amount >= divisor * 1000n) { divisor *= 1000n; unit++ }
  let rounded = (amount + divisor / 2n) / divisor
  if (rounded >= 1000n && unit < units.length - 1) {
    divisor *= 1000n; unit++
    rounded = (amount + divisor / 2n) / divisor
  }
  return rounded.toString() + units[unit]
}

export const usageComponents = ['input', 'output', 'cache_read', 'cache_create'] as const

type Amount = Parameters<typeof formatUsageTokens>[0]
type Composition = Partial<Record<typeof usageComponents[number] | 'total', Amount>>

const isAmount = (value: Amount): value is string | bigint | number => value != null && /^\d+$/.test(String(value))

/** A share needs both a confirmed numerator and a positive denominator. */
export function formatUsageShare(part: Amount, total: Amount): string | undefined {
  if (!isAmount(part) || !isAmount(total)) return
  const numerator = BigInt(part)
  const denominator = BigInt(total)
  if (denominator === 0n || numerator > denominator) return
  const tenths = (numerator * 1000n + denominator / 2n) / denominator
  return `${tenths / 10n}.${tenths % 10n}%`
}

export function formatUsageWithShare(part: Amount, total: Amount, format = formatUsageTokens): string {
  const share = formatUsageShare(part, total)
  if (share === '0.0%' && BigInt(part!) > 0n) return `${format(part)} · <0.1%`
  return share ? `${format(part)} · ${share}` : format(part)
}

export function hasChartableComposition(amounts?: Composition | null): boolean {
  if (!amounts || !isAmount(amounts.total) || BigInt(amounts.total) === 0n) return false
  let sum = 0n
  for (const key of usageComponents) {
    const value = amounts[key]
    if (!isAmount(value)) return false
    sum += BigInt(value)
  }
  return sum === BigInt(amounts.total)
}

type CompositionRow = { key: typeof usageComponents[number] | 'unknown_total'; value: string | null }

/** Check optional partial subtotals against the selected interval before drawing shares. */
export function dashboardComposition(analysis: UsageAmounts, reported?: UsageComposition) {
  const total = analysis.total
  if (reported && isAmount(total) && isAmount(reported.unknown_total)) {
    const unknown = BigInt(reported.unknown_total)
    const allUnknown = unknown > 0n && unknown === BigInt(total)
    if (allUnknown && (reported.known_total == null || reported.known_total === '0') &&
        usageComponents.every(key => reported[key] == null)) {
      return { rows: [{ key: 'unknown_total', value: reported.unknown_total }] as CompositionRow[], chartable: false }
    }
    if (isAmount(reported.known_total) && usageComponents.every(key => isAmount(reported[key]))) {
      const sum = usageComponents.reduce((n, key) => n + BigInt(reported[key]!), 0n)
      if (sum === BigInt(reported.known_total) && sum + unknown === BigInt(total)) {
        const rows: CompositionRow[] = usageComponents.map(key => ({ key, value: reported[key] }))
        if (unknown > 0n) rows.push({ key: 'unknown_total', value: reported.unknown_total })
        return { rows, chartable: sum + unknown > 0n }
      }
    }
  }
  const rows: CompositionRow[] = usageComponents.some(key => analysis[key] != null)
    ? usageComponents.map(key => ({ key, value: analysis[key] })) : []
  return { rows, chartable: hasChartableComposition(analysis) }
}
