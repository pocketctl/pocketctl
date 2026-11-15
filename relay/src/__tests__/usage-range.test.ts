import {describe,it,expect} from 'vitest'
import {parseRange,rangeWindow,granularity,buckets} from '../usage-analytics/range.js'
describe('personal ranges',()=>{
 const now=new Date('2026-11-14T12:00:00Z')
 it('clips 365 days and keeps today',()=>{expect(rangeWindow('all',now).from).toBe('2025-11-15T00:00:00.000Z');expect(rangeWindow('today',now).toExclusive).toBe(now.toISOString())})
 it('uses calendar days across leap years and month end',()=>{expect(rangeWindow('7d',new Date('2024-03-01T00:00:00Z')).from).toBe('2024-02-24T00:00:00.000Z')})
 it('rejects custom ranges',()=>{expect(()=>parseRange('366d')).toThrow();expect(parseRange(undefined)).toBe('30d')})
 it.each([[30,'day'],[31,'week'],[180,'week'],[181,'month'],[365,'month']])('span %i => %s',(days,unit)=>{expect(granularity('all',new Date(+now-(Number(days)-1)*86400000).toISOString(),now)).toBe(unit)})
 it('clips natural month buckets',()=>{const bs=buckets(rangeWindow('all',now),'month');expect(bs).toHaveLength(13);expect(bs[0].bucket_start).toBe('2025-11-15T00:00:00.000Z');expect(bs[0].partial_period).toBe(true);expect(bs.at(-1)?.end_exclusive).toBe(now.toISOString())})
 it('starts weeks Monday',()=>expect(buckets(rangeWindow('7d',now),'week')[0].partial_period).toBe(true))
})
