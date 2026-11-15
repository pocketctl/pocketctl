import {describe,test,expect,vi} from 'vitest'
import type pg from 'pg'
import {assertUsageAnalyticsSchema} from '../usage-analytics/schema.js'
import {safeMaterializationError} from '../inbox-worker.js'

describe('personal usage writer capability',()=>{
 test('reports PostgreSQL permission errors without leaking diagnostics',()=>{
  expect(safeMaterializationError(Object.assign(new Error('sensitive database diagnostics'),{code:'42501'}))).toBe('database_permission_denied')
 })
 test('rejects enabled database writes without sequence USAGE before ingress starts',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{version:1,write_enabled:true}]}).mockResolvedValueOnce({rows:[{ready:false}]})
  await expect(assertUsageAnalyticsSchema({query} as unknown as pg.Pool)).rejects.toThrow('usage_change_sequence_usage_required')
 })
 test('accepts the minimum sequence capability without requiring SELECT or UPDATE',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{ready:true}]}).mockResolvedValueOnce({rows:[{version:1,write_enabled:true}]}).mockResolvedValueOnce({rows:[{ready:true}]})
  await expect(assertUsageAnalyticsSchema({query} as unknown as pg.Pool)).resolves.toBeUndefined()
 })
})
