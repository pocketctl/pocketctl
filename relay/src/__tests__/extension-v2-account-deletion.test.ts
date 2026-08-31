import { describe, expect, test, vi } from 'vitest'

import { revokeExtensionDataForUser } from '../db.js'

describe('extension v2 account deletion journal', () => {
  test('emits membership revocation control rows before detaching the deleted user', async () => {
    const sql: string[] = []
    const client = {
      query: vi.fn(async (statement: string) => {
        sql.push(statement.replace(/\s+/g, ' ').trim())
        return { rows: [], rowCount: 0 }
      }),
    }

    await revokeExtensionDataForUser(client as never, 42)

    const eventIndex = sql.findIndex(statement =>
      statement.includes('INSERT INTO extension_scope_outbox')
      && statement.includes("'scope.membership.v2'"))
    const revokeIndex = sql.findIndex(statement => statement.includes('UPDATE extension_scope_memberships'))
    expect(eventIndex).toBeGreaterThanOrEqual(0)
    expect(eventIndex).toBeLessThan(revokeIndex)
  })
})
