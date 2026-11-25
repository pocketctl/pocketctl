import {describe,expect,it} from 'vitest'
import {formatUsageTokens, formatUsageWithShare, dashboardComposition} from '../usageTokenFormat'
describe('Token decimal units and integer half-up rounding',()=>{
 it.each([
  ['0','0'],['999','999'],['1000','1K'],['1499','1K'],['1500','2K'],
  ['999499','999K'],['999500','1M'],['1000000','1M'],['1500000','2M'],
  ['999499999','999M'],['999500000','1G'],['1500000000','2G'],
  ['999500000000','1T'],['1500000000000','2T'],['62103174781','62G'],
  ['9007499999999999','9007T'],['9007500000000000','9008T'],
  ['9223372036854775807','9223372T'],
 ])('%s → %s',(value,expected)=>expect(formatUsageTokens(value)).toBe(expected))
 it.each([null,undefined,'','bad','-1','1.5'])('keeps unknown or invalid %s unknown',value=>expect(formatUsageTokens(value)).toBe('—'))
})


it.each([
  [null, '1000', '—'], ['0', '1000', '0 · 0.0%'], ['0', '0', '0'],
  ['42', null, '42'], ['26563', '1000000000', '27K · <0.1%'],
])('renders amount %s against total %s without confusing missing values with zero', (part, total, expected) => {
  expect(formatUsageWithShare(part, total)).toBe(expected)
})


it('retains four confirmed zero subtotals alongside total-only records', () => {
  const analysis = { input: null, output: null, cache_read: null, cache_create: null, requests: null, total: '50' }
  const split = dashboardComposition(analysis, { input: '0', output: '0', cache_read: '0', cache_create: '0', known_total: '0', unknown_total: '50' })
  expect(split.rows.map(row => row.value)).toEqual(['0', '0', '0', '0', '50'])
})
