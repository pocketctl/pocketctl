import { expect, test } from 'vitest'
import { assertMemoryTestDatabase, memoryTestDatabaseConfig } from '../testing/test-db.js'

const good = 'postgresql://lifecycle_test:SYNTHETIC_PASSWORD@127.0.0.1:5432/lifecycle_test'
// Mutation caught: trusting only the authority portion lets pg query options
// replace the validated host/database before a destructive suite connects.
test.each([
  ['remote', 'postgresql://lifecycle_test:SYNTHETIC_PASSWORD@remote.invalid/lifecycle_test'],
  ['business_name', 'postgresql://business:SYNTHETIC_PASSWORD@localhost/business'],
  ['wrong_role', 'postgresql://wrong:SYNTHETIC_PASSWORD@localhost/lifecycle_test'],
  ['host_override', `${good}?host=remote.invalid`],
  ['database_override', `${good}?database=business`],
  ['role_override', `${good}?user=postgres`],
  ['options', `${good}?options=-csearch_path%3Dpublic`],
  ['encoded_options', `${good}?%6fptions=-csearch_path%3Dpublic`],
  ['malformed_escape', 'postgresql://bad%FE:SYNTHETIC_PASSWORD@localhost/bad%FE'],
  ['missing', ''],
])('AC-01 %s', (_, url) => {
  expect(() => memoryTestDatabaseConfig(url)).toThrow()
  try { memoryTestDatabaseConfig(url) } catch (error) { expect(String(error)).not.toContain('SYNTHETIC_PASSWORD') }
})
test.each([
  ['superuser', { database: 'lifecycle_test', user: 'lifecycle_test', superuser: true }],
  ['identity_mismatch', { database: 'business', user: 'lifecycle_test', superuser: false }],
  ['unknown_privilege', { database: 'lifecycle_test', user: 'lifecycle_test' }],
] as const)('AC-01 %s', async (_, identity) => {
  const sql: string[] = []
  const connection = { query: async (query: string) => { sql.push(query); return { rows: [identity] } } }
  await expect(assertMemoryTestDatabase(connection, good)).rejects.toThrow()
  expect(sql).toHaveLength(1)
  expect(sql[0]).not.toMatch(/TRUNCATE|DELETE|DROP|CREATE|ALTER/i)
})
test('AC-01 allowed_identity', async () => {
  const connection = { query: async () => ({ rows: [{ database: 'lifecycle_test', user: 'lifecycle_test', superuser: false }] }) }
  expect(await assertMemoryTestDatabase(connection, good)).toEqual({ database: 'lifecycle_test', user: 'lifecycle_test' })
})
