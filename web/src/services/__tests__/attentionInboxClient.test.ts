import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AttentionInboxItem, AttentionInboxSnapshot } from '../../types/attentionInbox'

const accessToken = { value: 'access-1' }
const doRefreshToken = vi.fn(async () => {
  accessToken.value = 'access-2'
  return true
})

vi.mock('../../composables/useAuth', () => ({
  useAuth: () => ({ accessToken, doRefreshToken }),
}))

vi.mock('../../composables/useEnv', () => ({
  getRelayOrigin: () => 'https://relay.example',
}))

const {
  AttentionInboxApiError,
  listAttentionInbox,
  mutateAttentionItem,
  mutateAttentionRecovery,
  submitAttentionAction,
} = await import('../attentionInboxClient')

const item: AttentionInboxItem = {
  item_id: '8c60a71b-01d9-4d3e-896e-04686b587c4d',
  revision: 4,
  provider: 'codex',
  kind: 'approval',
  state: 'open',
  risk: { level: 'high', classification_incomplete: true, reasons: [] },
  daemon: { id: 'daemon-1', display_name: 'Mac Studio' },
  session: { id: 'session-1', title: 'Deploy', status: 'waiting_approval' },
  request_id: 'request-1',
  title: 'Approval required',
  summary: 'Deploy production',
  context: { command: './deploy.sh' },
  allowed_actions: [{ id: 'once', style: 'primary', destructive: false, label_key: 'attention.action.once' }],
  seen_at: null,
  snoozed_until: null,
  submitted_at: null,
  resolved_at: null,
  handled_at: null,
  expires_at: null,
  resolution: null,
  last_error: null,
  created_at: '2026-08-12T01:00:00.000Z',
  updated_at: '2026-08-12T01:00:00.000Z',
}

const snapshot: AttentionInboxSnapshot = {
  schema_version: 1,
  server_time: '2026-08-12T01:00:00.000Z',
  capabilities: {
    schema_version: 1,
    mode: 'on',
    enabled: true,
    remote_response_enabled: true,
    providers: {
      codex: { projection: true, remote_response: true },
      opencode: { projection: true, remote_response: true },
      'claude-code': { projection: false, remote_response: false },
    },
  },
  scope: { type: 'global', daemon_id: null },
  counts: { actionable: 1, open: 1, snoozed: 0, submitting: 0, result_unknown: 0 },
  items: [item],
  next_cursor: null,
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  accessToken.value = 'access-1'
  doRefreshToken.mockClear()
  vi.restoreAllMocks()
})

describe('attentionInboxClient', () => {
  test('builds literal global and daemon snapshot queries', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(200, snapshot))
      .mockResolvedValueOnce(response(200, { ...snapshot, scope: { type: 'daemon', daemon_id: 'daemon/1' } }))

    await listAttentionInbox({ scope: { type: 'global' }, states: ['open', 'result_unknown'], limit: 50 })
    await listAttentionInbox({ scope: { type: 'daemon', daemonId: 'daemon/1' }, states: ['snoozed'], cursor: 'next+page', limit: 25 })

    expect(fetchSpy.mock.calls[0][0]).toBe('https://relay.example/api/attention-inbox/v2/items?scope=global&states=open%2Cresult_unknown&limit=50')
    expect(fetchSpy.mock.calls[1][0]).toBe('https://relay.example/api/attention-inbox/v2/items?scope=daemon&daemon_id=daemon%2F1&states=snoozed&cursor=next%2Bpage&limit=25')
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      credentials: 'include',
      headers: { Authorization: 'Bearer access-1', Accept: 'application/json' },
    })
  })

  test('sends recovery metadata to v2 without an action endpoint', async () => {
    const recovery = {
      recovery_id: item.item_id, revision: 2, kind: 'recovery' as const, state: 'open' as const,
      reason_code: 'daemon_offline' as const, daemon: item.daemon,
      navigation: { type: 'host' as const, daemon_id: 'daemon-1' },
      last_seen_at: item.updated_at, seen_at: null, snoozed_until: null,
      resolved_at: null, handled_at: null, resolution: null,
      created_at: item.created_at, updated_at: item.updated_at,
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(200, { recovery }))

    await mutateAttentionRecovery({
      recoveryId: recovery.recovery_id, expectedRevision: 2, operation: 'mark_seen',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://relay.example/api/attention-inbox/v2/recovery-items/${recovery.recovery_id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ expected_revision: 2, operation: 'mark_seen' }),
      }),
    )
  })

  test('sends revision-checked metadata mutation', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(200, { item }))

    await mutateAttentionItem({
      itemId: item.item_id,
      expectedRevision: 4,
      operation: 'snooze',
      snoozedUntil: '2026-08-12T02:00:00.000Z',
    })

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://relay.example/api/attention-inbox/v1/items/${item.item_id}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          expected_revision: 4,
          operation: 'snooze',
          snoozed_until: '2026-08-12T02:00:00.000Z',
        }),
      }),
    )
  })

  test('uses the supplied idempotency key exactly once for an action', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(202, {
      outcome: 'submitted', receipt_id: '12', item: { ...item, revision: 5, state: 'submitting' }, final: false,
    }))

    await submitAttentionAction({
      itemId: item.item_id,
      expectedRevision: 4,
      actionId: 'answer',
      answers: [['Option A']],
      idempotencyKey: '33ee7974-f12a-4877-bbe9-00f2244e84ff',
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://relay.example/api/attention-inbox/v1/items/${item.item_id}/actions`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': '33ee7974-f12a-4877-bbe9-00f2244e84ff' }),
        body: JSON.stringify({ expected_revision: 4, action_id: 'answer', answers: [['Option A']] }),
      }),
    )
  })

  test('refreshes once after 401 and retries with the fresh token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(401, { error: { code: 'unauthorized', message: 'Unauthorized', retryable: false } }))
      .mockResolvedValueOnce(response(200, snapshot))

    await listAttentionInbox({ scope: { type: 'global' } })

    expect(doRefreshToken).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer access-2' }) })
  })

  test('preserves the current item from a stale-revision response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(409, {
      error: {
        code: 'stale_revision',
        message: 'Item revision is stale',
        retryable: true,
        current_item: { ...item, revision: 6 },
      },
    }))

    const error = await mutateAttentionItem({ itemId: item.item_id, expectedRevision: 4, operation: 'mark_seen' })
      .catch(value => value)

    expect(error).toBeInstanceOf(AttentionInboxApiError)
    expect(error.code).toBe('stale_revision')
    expect(error.retryable).toBe(true)
    expect(error.item?.revision).toBe(6)
  })
})
