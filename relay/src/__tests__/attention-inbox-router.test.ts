import { describe, expect, test, vi } from 'vitest'
import { Router } from '../router.js'

function ws(): any {
  const sent: any[] = []
  return {
    readyState: 1,
    send: vi.fn((raw: string) => sent.push(JSON.parse(raw))),
    close: vi.fn(),
    terminate: vi.fn(),
    _sent: sent,
  }
}

function pool(options: {
  owned?: boolean
  daemonId?: string | null
  agentType?: string
  runtimePolicyError?: boolean
} = {}): any {
  const owned = options.owned ?? true
  const daemonId = options.daemonId === undefined ? 'd1' : options.daemonId
  const agentType = options.agentType ?? 'codex'
  const value: any = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('WITH owned_session')) {
        if (options.runtimePolicyError) throw new Error('runtime policy unavailable')
        return {
          rows: owned ? [{
            daemon_id: daemonId, agent_type: agentType, source: 'terminal',
            control_mode: 'managed', capabilities: ['shared_runtime'], status: 'waiting',
          }] : [],
          rowCount: owned ? 1 : 0,
        }
      }
      if (/SELECT 1 FROM sessions/i.test(sql)) {
        return { rows: owned ? [{ ok: 1 }] : [], rowCount: owned ? 1 : 0 }
      }
      if (/SELECT daemon_id FROM sessions/i.test(sql)) {
        return { rows: daemonId ? [{ daemon_id: daemonId }] : [], rowCount: daemonId ? 1 : 0 }
      }
      return { rows: [], rowCount: 0 }
    }),
  }
  value.connect = vi.fn(async () => ({ query: value.query, release: vi.fn() }))
  return value
}

describe('Attention Inbox router adapter', () => {
  test('forwards only the normalized interaction command to the owned online daemon', async () => {
    const router = new Router(pool())
    const daemon = ws()
    ;(router as any).daemons.set('d1', { ws: daemon, daemonId: 'd1', userId: 7 })

    const result = await router.submitAttentionInboxInteraction(7, {
      type: 'approval_response',
      session_id: 'ses_1',
      request_id: 'req_1',
      action: 'once',
    })

    expect(result).toEqual({ accepted: true })
    expect(daemon._sent).toEqual([{
      type: 'approval_response',
      session_id: 'ses_1',
      request_id: 'req_1',
      action: 'once',
    }])
  })

  test('does not send when the session is not owned by the caller', async () => {
    const router = new Router(pool({ owned: false }))
    const daemon = ws()
    ;(router as any).daemons.set('d1', { ws: daemon, daemonId: 'd1', userId: 8 })

    const result = await router.submitAttentionInboxInteraction(7, {
      type: 'question_reject', session_id: 'ses_1', request_id: 'req_1',
    })

    expect(result).toEqual({ accepted: false, code: 'session_not_found' })
    expect(daemon._sent).toEqual([])
  })

  test('reports daemon unreachable without optimistic resolution', async () => {
    const router = new Router(pool({ daemonId: 'offline' }))

    const result = await router.submitAttentionInboxInteraction(7, {
      type: 'question_response',
      session_id: 'ses_1',
      request_id: 'req_1',
      answers: [['A']],
    })

    expect(result).toEqual({ accepted: false, code: 'daemon_unreachable' })
  })

  test('rejects every observer Attention interaction, including unknown future variants, before daemon send', async () => {
    const router = new Router(pool({ agentType: 'codex-desktop' }))
    const daemon = ws()
    ;(router as any).daemons.set('d1', { ws: daemon, daemonId: 'd1', userId: 7 })
    const commands: any[] = [
      { type: 'approval_response', session_id: 'ses_1', request_id: 'approval-1', action: 'once' },
      { type: 'question_response', session_id: 'ses_1', request_id: 'question-1', answers: [['A']] },
      { type: 'question_reject', session_id: 'ses_1', request_id: 'question-2' },
      { type: 'future_interaction_response', session_id: 'ses_1', request_id: 'future-1' },
    ]

    for (const command of commands) {
      await expect(router.submitAttentionInboxInteraction(7, command)).resolves.toEqual({
        accepted: false, code: 'observer_read_only',
      })
    }
    expect(daemon._sent).toEqual([])
  })

  test('fails closed before Attention daemon send when runtime policy cannot be loaded', async () => {
    const router = new Router(pool({ runtimePolicyError: true }))
    const daemon = ws()
    ;(router as any).daemons.set('d1', { ws: daemon, daemonId: 'd1', userId: 7 })

    const result = await router.submitAttentionInboxInteraction(7, {
      type: 'approval_response', session_id: 'ses_1', request_id: 'req-policy', action: 'once',
    })

    expect(result).toEqual({ accepted: false, code: 'session_not_found' })
    expect(daemon._sent).toEqual([])
  })

  test('fails closed for an unknown future managed interaction variant', async () => {
    const router = new Router(pool({ agentType: 'codex' }))
    const daemon = ws()
    ;(router as any).daemons.set('d1', { ws: daemon, daemonId: 'd1', userId: 7 })

    const result = await router.submitAttentionInboxInteraction(7, {
      type: 'future_interaction_response', session_id: 'ses_1', request_id: 'future-managed',
    } as any)

    expect(result).toEqual({ accepted: false, code: 'interaction_unsupported' })
    expect(daemon._sent).toEqual([])
  })
})
