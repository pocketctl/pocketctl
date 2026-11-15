const DAY = 86_400_000
const OFFSET = 8 * 3_600_000
export function shanghaiDate(time: Date | number): string {
  return new Date(Number(time) + OFFSET).toISOString().slice(0, 10)
}
export function dateStart(date: string): number { return Date.parse(`${date}T00:00:00+08:00`) }
export function addDays(date: string, days: number): string { return shanghaiDate(dateStart(date) + days * DAY) }
export interface StatisticsRange {
  from: string; to: string; previousFrom: string; previousTo: string
  start: string; end: string; previousStart: string; previousEnd: string; days: number
}
export function parseStatisticsRange(query: Record<string, unknown>, now = new Date()): StatisticsRange {
  if (Object.keys(query).some(key => !['from', 'to'].includes(key))) throw new Error('Unsupported statistics query')
  const today = shanghaiDate(now)
  const from = query.from ?? addDays(today, -7)
  const to = query.to ?? addDays(today, -1)
  if ((query.from === undefined) !== (query.to === undefined)) throw new Error('Both dates are required')
  for (const date of [from, to]) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateStart(date)) || shanghaiDate(dateStart(date)) !== date) throw new Error('Invalid date')
  }
  const first = from as string, last = to as string
  const days = (dateStart(last) - dateStart(first)) / DAY + 1
  if (days < 1 || days > 90 || last > today) throw new Error('Range must contain 1 to 90 nonfuture dates')
  const previousFrom = addDays(first, -days), previousTo = addDays(last, -days)
  const end = Math.min(dateStart(addDays(last, 1)), now.getTime())
  return {
    from: first, to: last, previousFrom, previousTo, days,
    start: new Date(dateStart(first)).toISOString(), end: new Date(end).toISOString(),
    previousStart: new Date(dateStart(previousFrom)).toISOString(),
    previousEnd: new Date(end - days * DAY).toISOString(),
  }
}
