import {describe,expect,test} from 'vitest'
import {dailyMaintenanceSlot,nextDailyMaintenanceAt} from '../maintenance/daily.js'
describe('03:00 Shanghai maintenance schedule',()=>{
 test.each([
  ['2026-10-31T02:59:59+08:00',null,'2026-10-30T19:00:00.000Z'],
  ['2026-10-31T03:00:00+08:00','2026-10-30T19:00:00.000Z','2026-10-31T19:00:00.000Z'],
  ['2026-11-01T00:00:00+08:00',null,'2026-10-31T19:00:00.000Z'],
 ])('wall-clock slot %s',(now,slot,next)=>{
  expect(dailyMaintenanceSlot(new Date(now))?.toISOString()??null).toBe(slot)
  expect(nextDailyMaintenanceAt(new Date(now)).toISOString()).toBe(next)
 })
})
