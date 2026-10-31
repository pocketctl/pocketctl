import { describe, expect, test } from 'vitest'
import { maintenanceSlot, nextMaintenanceAt } from '../session-lifecycle/schedule.js'

describe('daily Asia/Shanghai lifecycle schedule', () => {
  test.each([
    ['2026-10-30T00:59:59+08:00', 'archive', '2026-10-28T19:00:00.000Z'],
    ['2026-10-30T03:00:00+08:00', 'archive', '2026-10-29T19:00:00.000Z'],
    ['2026-10-30T02:59:59+08:00', 'purge', '2026-10-28T19:00:00.000Z'],
    ['2026-10-30T03:00:00+08:00', 'purge', '2026-10-29T19:00:00.000Z'],
    ['2026-11-01T00:00:00+08:00', 'archive', '2026-10-30T19:00:00.000Z'],
  ] as const)('%s selects the latest %s slot', (now, action, expected) => {
    expect(maintenanceSlot(action,new Date(now)).toISOString()).toBe(expected)
    expect(nextMaintenanceAt(action,new Date(now)).getTime()).toBe(new Date(expected).getTime()+86400000)
  })
})
