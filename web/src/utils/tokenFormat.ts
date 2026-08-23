export function formatTokenCount(value: number | string | null | undefined): string {
  if (value == null) return '—'
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n === 0) return '0'

  const units = ['', 'K', 'M', 'G', 'T'] as const
  let amount = n
  let unitIndex = 0
  while (amount >= 1000 && unitIndex < units.length - 1) {
    amount /= 1000
    unitIndex++
  }

  let decimals = unitIndex <= 1 ? 0 : 1
  let rounded = Number(amount.toFixed(decimals))
  if (rounded >= 1000 && unitIndex < units.length - 1) {
    amount = rounded / 1000
    unitIndex++
    decimals = unitIndex <= 1 ? 0 : 1
    rounded = Number(amount.toFixed(decimals))
  }

  return `${rounded.toFixed(decimals)}${units[unitIndex]}`
}

export function childAgentTokenTotal(child: {
  tokenIn?: number | string | null
  tokenOut?: number | string | null
  tokenCache?: number | string | null
  tokenCacheCreate?: number | string | null
}): number {
  return Number(child.tokenIn || 0) + Number(child.tokenOut || 0)
    + Number(child.tokenCache || 0) + Number(child.tokenCacheCreate || 0)
}
