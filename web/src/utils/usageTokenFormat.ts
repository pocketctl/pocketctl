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
