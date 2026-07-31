import { beforeEach, describe, expect, test, vi } from 'vitest'

process.env.JWT_SECRET ||= 'account-deletion-auth-test-secret'

function authPool(userPresent: boolean) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/revoked_tokens/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/SELECT EXISTS.*users/is.test(sql)) return { rows: [{ exists: userPresent }], rowCount: 1 }
      throw new Error(`unexpected query: ${sql}`)
    }),
  } as any
}

function deletionPool(userPresent: boolean, events: string[] = []) {
  const client = {
    query: vi.fn(async (sql: string) => {
      events.push(sql.replace(/\s+/g, ' ').trim())
      if (/SELECT id FROM users WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        return { rows: userPresent ? [{ id: 7 }] : [], rowCount: userPresent ? 1 : 0 }
      }
      if (/SELECT session_id FROM sessions/i.test(sql) || /SELECT daemon_id FROM daemons/i.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return {
    query: vi.fn(async (sql: string) => {
      if (/revoked_tokens/i.test(sql)) return { rows: [], rowCount: 0 }
      if (/SELECT EXISTS.*users/is.test(sql)) return { rows: [{ exists: true }], rowCount: 1 }
      throw new Error(`unexpected query: ${sql}`)
    }),
    connect: vi.fn().mockResolvedValue(client),
    client,
  } as any
}

function replyDouble() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    code(value: number) {
      this.statusCode = value
      return this
    },
    header(name: string, value: string) {
      this.headers[name] = value
      return this
    },
  }
}

function socketDouble() {
  return {
    readyState: 1,
    close: vi.fn(),
    send: vi.fn(),
  } as any
}

describe('deleted-account authorization boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  test('rejects a valid access token after its user row is deleted', async () => {
    const { signAccessToken, verifyAccessTokenWithRevocation } = await import('../auth.js')
    const token = await signAccessToken(7, 'deleted@example.com')

    await expect(verifyAccessTokenWithRevocation(token, authPool(false))).resolves.toBeNull()
  })

  test('fails closed when account-existence lookup fails', async () => {
    const { signAccessToken, verifyAccessTokenWithRevocation } = await import('../auth.js')
    const token = await signAccessToken(7, 'person@example.com')
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockRejectedValueOnce(new Error('database unavailable')),
    } as any

    await expect(verifyAccessTokenWithRevocation(token, pool)).resolves.toBeNull()
  })

  test('fails closed when revocation lookup fails', async () => {
    const { signAccessToken, verifyAccessTokenWithRevocation } = await import('../auth.js')
    const token = await signAccessToken(7, 'person@example.com')
    const pool = {
      query: vi.fn()
        .mockRejectedValueOnce(new Error('revocation table unavailable'))
        .mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 }),
    } as any

    await expect(verifyAccessTokenWithRevocation(token, pool)).resolves.toBeNull()
  })

  test('rejects a pre-issued websocket ticket after account deletion', async () => {
    const { createWsTicketStore } = await import('../config/ws-tickets.js')
    const { consumeLiveUserWsTicket } = await import('../server.js')
    const store = createWsTicketStore()
    const { ticket } = store.create({
      userId: 7,
      email: 'deleted@example.com',
      jti: 'jti-7',
      machine_id: 'web',
    })

    await expect(consumeLiveUserWsTicket(store, ticket, authPool(false))).resolves.toBeNull()
  })

  test('terminates only the deleted user app and daemon sockets', async () => {
    const { Router } = await import('../router.js')
    const router = new Router({} as any)
    const deletedClient = socketDouble()
    const otherClient = socketDouble()
    const deletedDaemon = socketDouble()
    const otherDaemon = socketDouble()
    router.registerClient(deletedClient, 7)
    router.registerClient(otherClient, 8)
    ;(router as any).daemons.set('deleted-daemon', {
      ws: deletedDaemon, daemonId: 'deleted-daemon', userId: 7,
    })
    ;(router as any).daemons.set('other-daemon', {
      ws: otherDaemon, daemonId: 'other-daemon', userId: 8,
    })

    router.terminateUserConnections(7)

    expect(deletedClient.close).toHaveBeenCalledWith(4001, 'account deleted')
    expect(deletedDaemon.close).toHaveBeenCalledWith(4001, 'account deleted')
    expect(otherClient.close).not.toHaveBeenCalled()
    expect(otherDaemon.close).not.toHaveBeenCalled()
    router.stop()
  })

  test('requires authentication for account deletion', async () => {
    const { handleDeleteAccountRequest } = await import('../server.js')
    const reply = replyDouble()

    const body = await handleDeleteAccountRequest(
      { headers: {} } as any,
      reply as any,
      deletionPool(true),
      { terminateUserConnections: vi.fn() } as any,
    )

    expect(reply.statusCode).toBe(401)
    expect(body).toEqual({ error: 'authorization required' })
  })

  test('deletes the account, clears the refresh cookie, and closes live connections', async () => {
    const { signAccessToken } = await import('../auth.js')
    const { handleDeleteAccountRequest } = await import('../server.js')
    const token = await signAccessToken(7, 'person@example.com')
    const events: string[] = []
    const pool = deletionPool(true, events)
    const router = {
      terminateUserConnections: vi.fn(() => events.push('TERMINATE USER CONNECTIONS')),
    }
    const reply = replyDouble()

    const body = await handleDeleteAccountRequest(
      { headers: { authorization: `Bearer ${token}` } } as any,
      reply as any,
      pool,
      router as any,
    )

    expect(reply.statusCode).toBe(200)
    expect(body).toEqual({ success: true })
    expect(reply.headers['Set-Cookie']).toContain('Max-Age=0')
    expect(events.indexOf('TERMINATE USER CONNECTIONS')).toBeLessThan(
      events.findIndex(value => value === 'BEGIN'),
    )
  })

  test('returns not found when a concurrent request already deleted the account', async () => {
    const { signAccessToken } = await import('../auth.js')
    const { handleDeleteAccountRequest } = await import('../server.js')
    const token = await signAccessToken(7, 'person@example.com')
    const reply = replyDouble()

    const body = await handleDeleteAccountRequest(
      { headers: { authorization: `Bearer ${token}` } } as any,
      reply as any,
      deletionPool(false),
      { terminateUserConnections: vi.fn() } as any,
    )

    expect(reply.statusCode).toBe(404)
    expect(body).toEqual({ error: 'user not found' })
  })
})
