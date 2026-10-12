const DAY_US = 86_400_000_000n
export { DAY_US }

/** PostgreSQL timestamps must be passed as ISO text, not pg's lossy Date parser. */
export function timestampMicros(value: string | Date): bigint {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new Error('invalid lifecycle timestamp')
    return BigInt(value.getTime()) * 1000n
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    )
  if (!match) throw new Error('invalid lifecycle timestamp')
  const [, day, hour, minute, second, fraction = '', zone] = match
  const calendar = new Date(`${day}T00:00:00Z`)
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== day ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== 'Z' &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))
  ) {
    throw new Error('invalid lifecycle timestamp')
  }
  const milliseconds = Date.parse(`${day}T${hour}:${minute}:${second}${zone}`)
  if (!Number.isFinite(milliseconds))
    throw new Error('invalid lifecycle timestamp')
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, '0') || '0')
}

export function microsTimestamp(value: bigint): string {
  // Floor division also preserves fractional precision before the Unix epoch.
  const seconds =
    value >= 0n ? value / 1_000_000n : (value - 999_999n) / 1_000_000n
  const fraction = value - seconds * 1_000_000n
  return new Date(Number(seconds * 1000n))
    .toISOString()
    .replace(/\.\d{3}Z$/, `.${String(fraction).padStart(6, '0')}Z`)
}
