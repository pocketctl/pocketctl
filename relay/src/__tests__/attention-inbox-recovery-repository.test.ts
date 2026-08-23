import { describe, expect, test, vi } from 'vitest'

import {
  AttentionRecoveryRepository,
  mapAttentionRecoveryRow,
} from '../attention-inbox/recovery-repository.js'

const recoveryRow = {
  recovery_id: '05d46d26-8cf6-49d0-adf4-ad31ef5d7753',
  user_id: 7,
  daemon_id: 'daemon-1',
  registration_generation: 'registration-1',
  state: 'open',
  revision: '2',
  reason_code: 'daemon_offline',
  daemon_display_name: 'Mac mini',
  last_seen_at: '2026-08-12T10:00:00.000Z',
  created_at: '2026-08-12T10:00:30.000Z',
  updated_at: '2026-08-12T10:01:00.000Z',
}

describe('Attention Inbox recovery repository', () => {
  test('maps a host-level recovery row without a session identity or action list', () => {
    const mapped = mapAttentionRecoveryRow(recoveryRow)

    expect(mapped).toMatchObject({
      recoveryId: recoveryRow.recovery_id,
      daemonId: 'daemon-1',
      registrationGeneration: 'registration-1',
      state: 'open',
      revision: 2,
      reasonCode: 'daemon_offline',
      daemonDisplayName: 'Mac mini',
    })
    expect(mapped.lastSeenAt.toISOString()).toBe('2026-08-12T10:00:00.000Z')
    expect(mapped).not.toHaveProperty('sessionId')
    expect(mapped).not.toHaveProperty('allowedActions')
  })

  test('creates only from the current confirmed-offline DB generation and notifies recovery listeners', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...recoveryRow, inserted: true }], rowCount: 1,
    })
    const repository = new AttentionRecoveryRepository({ query } as never)

    const result = await repository.recordConfirmedOffline({
      userId: 7,
      daemonId: 'daemon-1',
      registrationGeneration: 'registration-1',
      daemonDisplayName: 'Mac mini',
    })

    expect(result).toEqual({ outcome: 'created', item: expect.objectContaining({ daemonId: 'daemon-1' }) })
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("daemon.status = 'offline'"),
      expect.arrayContaining([expect.any(String), 7, 'daemon-1', 'registration-1', 'Mac mini']),
    )
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('ON CONFLICT (user_id, daemon_id, registration_generation)')
    expect(sql).toContain('COALESCE(daemon.last_heartbeat, daemon.created_at, NOW())')
    expect(sql).toContain("'entity', 'recovery'")
  })

  test('reports update/no-op without creating a duplicate generation', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ...recoveryRow, inserted: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    const repository = new AttentionRecoveryRepository({ query } as never)

    await expect(repository.recordConfirmedOffline({
      userId: 7, daemonId: 'daemon-1', registrationGeneration: 'registration-1',
      daemonDisplayName: 'Renamed host',
    })).resolves.toEqual({ outcome: 'updated', item: expect.any(Object) })
    await expect(repository.recordConfirmedOffline({
      userId: 7, daemonId: 'daemon-1', registrationGeneration: 'stale-registration',
      daemonDisplayName: 'Mac mini',
    })).resolves.toEqual({ outcome: 'noop' })
  })

  test('resolves prior generations only when the accepted online generation is current', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...recoveryRow, state: 'resolved', revision: 3, quick_recovery: true }],
      rowCount: 1,
    })
    const repository = new AttentionRecoveryRepository({ query } as never)

    const result = await repository.recordConfirmedOnline({
      userId: 7, daemonId: 'daemon-1', registrationGeneration: 'registration-2',
    })

    expect(result).toEqual({ resolved: 1, quickResolved: 1 })
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("daemon.status = 'online'"),
      [7, 'daemon-1', 'registration-2'],
    )
    expect(String(query.mock.calls[0]?.[0])).toContain("registration_generation <> $3")
  })

  test('allows only revision-checked metadata updates', async () => {
    const selected = { rows: [recoveryRow], rowCount: 1 }
    const changed = { rows: [{ ...recoveryRow, seen_at: new Date(), revision: 3 }], rowCount: 1 }
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(selected)
        .mockResolvedValueOnce(changed)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: vi.fn(),
    }
    const repository = new AttentionRecoveryRepository({
      query: vi.fn(), connect: vi.fn().mockResolvedValue(client),
    } as never)

    const result = await repository.mutateMetadata({
      userId: 7, recoveryId: recoveryRow.recovery_id,
      expectedRevision: 2, operation: 'mark_seen', snoozedUntil: null,
    })

    expect(result).toEqual({ outcome: 'updated', item: expect.objectContaining({ revision: 3 }) })
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('WHERE recovery_id = $1 AND user_id = $2 FOR UPDATE'),
      [recoveryRow.recovery_id, 7],
    )
    expect(client.release).toHaveBeenCalledOnce()
  })

  test('maintenance reconciles offline/online state, snoozes, and retention in bounded queries', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ recovery_id: 'created' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ recovery_id: 'resolved' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ recovery_id: 'woken' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ recovery_id: 'removed' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 })
    const repository = new AttentionRecoveryRepository({ query } as never)

    await expect(repository.runMaintenance()).resolves.toEqual({ changed: 4, open: 1 })
    expect(String(query.mock.calls[0]?.[0])).toContain("daemon.status = 'offline'")
    expect(String(query.mock.calls[0]?.[0]))
      .toContain('COALESCE(daemon.last_heartbeat, daemon.created_at, NOW())')
    expect(String(query.mock.calls[1]?.[0])).toContain("daemon.status = 'online'")
    expect(String(query.mock.calls[2]?.[0])).toContain("state = 'snoozed'")
    expect(String(query.mock.calls[3]?.[0])).toContain("INTERVAL '30 days'")
  })

  test('can defer offline backfill during Relay startup grace while running other maintenance', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 })
    const repository = new AttentionRecoveryRepository({ query } as never)

    await expect(repository.runMaintenance({ projectOffline: false }))
      .resolves.toEqual({ changed: 0, open: 0 })

    expect(query).toHaveBeenCalledTimes(4)
    expect(query.mock.calls.every(call => !String(call[0]).includes("daemon.status = 'offline'"))).toBe(true)
  })
})
