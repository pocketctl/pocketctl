import { describe, expect, test, vi } from 'vitest'

import { runInScopeTransaction } from '../extensions/scope-repository.js'
import {
  runInScopeIdempotencyTransaction,
  withScopeIdempotencyLock,
} from '../extensions/scope-routes.js'
import { canTransitionSharedScope } from '../extensions/scope-types.js'

describe('scope transaction helper', () => {
  test('checks out one pool client and gives that client to the complete transaction body', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = {
      query: vi.fn(async () => { throw new Error('pool.query must not execute transaction work') }),
      connect: vi.fn(async () => client),
    }

    const result = await runInScopeTransaction(pool as never, async transaction => {
      await transaction.query('BUSINESS')
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(statements).toEqual(['BEGIN', 'BUSINESS', 'COMMIT'])
    expect(client.release).toHaveBeenCalledOnce()
    expect(pool.query).not.toHaveBeenCalled()
  })
})

describe('shared scope lifecycle', () => {
  test('keeps dissolution terminal and permits only monotonic lifecycle transitions', () => {
    expect(canTransitionSharedScope('active', 'suspended')).toBe(true)
    expect(canTransitionSharedScope('suspended', 'active')).toBe(true)
    expect(canTransitionSharedScope('active', 'dissolving')).toBe(true)
    expect(canTransitionSharedScope('dissolving', 'dissolved')).toBe(true)
    expect(canTransitionSharedScope('dissolved', 'suspended')).toBe(false)
    expect(canTransitionSharedScope('dissolved', 'dissolving')).toBe(false)
  })
})

describe('scope idempotency serialization', () => {
  test('holds a dedicated database advisory lock for the complete mutation', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim())
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) }
    await withScopeIdempotencyLock(pool as never, 'actor:operation:key', async () => {
      statements.push('MUTATION')
      return 'done'
    })
    expect(statements[0]).toContain('pg_advisory_lock')
    expect(statements[1]).toBe('MUTATION')
    expect(statements[2]).toContain('pg_advisory_unlock')
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('commits lookup, business write, and receipt on the same checked-out client', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim())
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) }
    await runInScopeIdempotencyTransaction(pool as never, 'actor:operation:key', async transaction => {
      await transaction.query('IDEMPOTENCY LOOKUP')
      await transaction.query('BUSINESS WRITE')
      await transaction.query('IDEMPOTENCY RECEIPT')
    })
    expect(statements[0]).toBe('BEGIN')
    expect(statements[1]).toContain('pg_advisory_xact_lock')
    expect(statements.slice(2)).toEqual([
      'IDEMPOTENCY LOOKUP', 'BUSINESS WRITE', 'IDEMPOTENCY RECEIPT', 'COMMIT',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })
})
