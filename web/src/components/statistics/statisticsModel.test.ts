import {expect,test} from 'vitest'
import {dateRange,validDateRange,comparison,chartPath,metricValue} from './statisticsModel'
const metric=(value:number|null,status:'complete'|'partial'|'unavailable'='complete')=>({value,status,coverageStart:null})
test('Shanghai default is last seven complete dates across month/year boundaries',()=>{
 expect(dateRange(7,new Date('2026-01-01T16:30:00Z'))).toEqual({from:'2025-12-26',to:'2026-01-01'})
 expect(dateRange(1,new Date('2026-01-01T16:30:00Z'))).toEqual({from:'2026-01-02',to:'2026-01-02'})
})
test('custom validation rejects impossible, future, reversed and over90day dates',()=>{
 expect(validDateRange({from:'2026-02-30',to:'2026-03-01'},'2026-11-07')).toBe(false)
 expect(validDateRange({from:'2026-08-10',to:'2026-11-07'},'2026-11-07')).toBe(true)
 expect(validDateRange({from:'2026-08-09',to:'2026-11-07'},'2026-11-07')).toBe(false)
 expect(validDateRange({from:'2026-11-08',to:'2026-11-07'},'2026-11-07')).toBe(false)
})
test('null breaks chart path while zero remains a real baseline point',()=>{
 expect(chartPath([0,null,4],4)).toBe('M42,220 M850,22')
 expect(metricValue(metric(0))).toBe('0');expect(metricValue(metric(null))).toBe('—')
})
test('partial metrics never compare and prior zero never produces infinity',()=>{
 expect(comparison(metric(4,'partial'),metric(2),true)).toEqual({key:'stats.notComparable'})
 expect(comparison(metric(4),metric(0),true)).toEqual({key:'stats.previousZero'})
 expect(comparison(metric(0),metric(0),true)).toEqual({key:'stats.unchanged'})
})
