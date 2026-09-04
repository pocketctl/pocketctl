import { describe, expect, test, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import {
  CANONICAL_EVENT_SOURCE_KIND,
  ExtensionJournalOwnerMissingError,
  createExtensionJournalSinkFromEnv,
  createPostgresExtensionJournalSink,
  extensionJournalEligibility,
} from '../extensions/journal.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import type { MaterializationInput } from '../materialization/types.js'

function materializerQuery(sinkCalls: Array<Record<string, unknown>>) {
  return vi.fn(async (sql: string, params?: unknown[]) => {
    if (/INSERT INTO extension_source_outbox/.test(sql)) {
      sinkCalls.push({ sql, params })
      return { rows: [], rowCount: 1 }
    }
    if (/INSERT INTO events/.test(sql)) {
      return { rows: [{ id: 91, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
    }
    if (/SELECT effect_status/.test(sql)) {
      return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
    }
    if (/session_allowed/.test(sql)) {
      return { rows: [{ session_exists: true, session_allowed: true }], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  })
}

function ownedInput(overrides: Partial<MaterializationInput> = {}): MaterializationInput {
  return {
    inboxId: 7,
    userId: 42,
    daemonId: 'daemon-1',
    sessionId: 'ses-1',
    eventType: 'agent_text',
    payload: { type: 'agent_text', session_id: 'ses-1', text: 'hello' },
    receivedAt: new Date('2026-08-23T10:00:00Z'),
    ...overrides,
  }
}

describe('extension journal eligibility policy', () => {
  test('journals ownable session events', () => {
    expect(extensionJournalEligibility({
      ownerUserId: 42, ledgerSessionId: 'ses-1', sessionId: 'ses-1',
    })).toEqual({ journal: true })
  })

  test('excludes app-review demo fixtures by marker and prefix', () => {
    expect(extensionJournalEligibility({
      ownerUserId: 42, ledgerSessionId: 'app-review-demo-ios-release',
      sessionId: 'app-review-demo-ios-release', sessionSource: 'daemon',
    })).toEqual({ journal: false, reason: 'excluded_demo_data' })
    expect(extensionJournalEligibility({
      ownerUserId: 42, ledgerSessionId: 'any', sessionId: 'app-review-demo-x',
    })).toEqual({ journal: false, reason: 'excluded_demo_data' })
  })

  test('events without a ledger session have no projection scope', () => {
    expect(extensionJournalEligibility({
      ownerUserId: 42, ledgerSessionId: '', sessionId: null,
    })).toEqual({ journal: false, reason: 'skipped_no_session' })
  })

  test('a missing owner is not a silent skip', () => {
    expect(extensionJournalEligibility({
      ownerUserId: null, ledgerSessionId: 'ses-1', sessionId: 'ses-1',
    })).toEqual({ journal: false, reason: 'skipped_no_owner' })
  })
})

describe('postgres extension journal sink', () => {
  test('appends one O(1) row with a stable source identity', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
    const sink = createPostgresExtensionJournalSink()

    await sink.appendCanonicalEvent({ query } as never, {
      sourceEventId: 93821,
      ownerUserId: 42,
      sessionId: 'session-1',
      eventType: 'agent_text',
      occurredAt: new Date('2026-08-23T10:00:00Z'),
      payload: { type: 'agent_text', text: 'before\u0000after' },
    })

    expect(query).toHaveBeenCalledOnce()
    const [sql, params] = query.mock.calls[0]
    expect(String(sql)).toContain('INSERT INTO extension_source_outbox')
    expect(String(sql)).toContain('ON CONFLICT (source_kind, source_id) DO NOTHING')
    expect(params).toEqual([
      CANONICAL_EVENT_SOURCE_KIND,
      'event:93821',
      42,
      'session-1',
      'agent_text',
      new Date('2026-08-23T10:00:00Z'),
      JSON.stringify({ type: 'agent_text', text: 'before\uFFFDafter' }),
    ])
  })

  test('sink injection follows the feature flag', () => {
    expect(createExtensionJournalSinkFromEnv({})).toBeNull()
    expect(createExtensionJournalSinkFromEnv({ RELAY_EXTENSIONS: 'off' })).toBeNull()
    expect(createExtensionJournalSinkFromEnv({ RELAY_EXTENSIONS: 'shadow' })).not.toBeNull()
    expect(createExtensionJournalSinkFromEnv({ RELAY_EXTENSIONS: 'enabled' })).not.toBeNull()
    expect(() => createExtensionJournalSinkFromEnv({ RELAY_EXTENSIONS: 'junk' })).toThrow()
  })
})

describe('EventMaterializer journal integration', () => {
  test('shadow sink appends the journal on the fence transaction client', async () => {
    const sinkCalls: Array<Record<string, unknown>> = []
    const query = materializerQuery(sinkCalls)
    const sink = createPostgresExtensionJournalSink()
    const materializer = new EventMaterializer({
      pool: { query } as never,
      extensionJournalSink: sink,
    })

    await materializer.materialize(ownedInput())

    expect(sinkCalls.length).toBe(1)
    const params = sinkCalls[0].params as unknown[]
    expect(params[0]).toBe(CANONICAL_EVENT_SOURCE_KIND)
    expect(params[1]).toBe('event:91')
    expect(params[2]).toBe(42)
    expect(params[3]).toBe('ses-1')
    expect(params[4]).toBe('agent_text')
  })

  test('a missing owner surfaces as a typed authorization error', async () => {
    const sinkCalls: Array<Record<string, unknown>> = []
    const query = materializerQuery(sinkCalls)
    const materializer = new EventMaterializer({
      pool: { query } as never,
      extensionJournalSink: createPostgresExtensionJournalSink(),
    })

    await expect(materializer.materialize(ownedInput({ userId: null })))
      .rejects.toBeInstanceOf(ExtensionJournalOwnerMissingError)
    expect(sinkCalls.length).toBe(0)
  })

  test('off mode (no sink) never touches the journal table', async () => {
    vi.stubEnv('RELAY_EXTENSIONS', 'off')
    try {
      const sinkCalls: Array<Record<string, unknown>> = []
      const query = materializerQuery(sinkCalls)
      const materializer = new EventMaterializer({ pool: { query } as never })

      await materializer.materialize(ownedInput())

      expect(sinkCalls.length).toBe(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('quota-failure ledger events are fenced when a sink is injected', async () => {
    const beginEnd: string[] = []
    const sinkCalls: Array<Record<string, unknown>> = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (/^BEGIN$/i.test(sql.trim())) { beginEnd.push('BEGIN'); return { rows: [] } }
      if (/^COMMIT$/i.test(sql.trim())) { beginEnd.push('COMMIT'); return { rows: [] } }
      if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] }
      if (/INSERT INTO extension_source_outbox/.test(sql)) {
        sinkCalls.push({ sql, params })
        return { rows: [], rowCount: 1 }
      }
      if (/INSERT INTO events/.test(sql)) {
        return { rows: [{ id: 55, inserted: true, effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
      }
      if (/SELECT effect_status/.test(sql)) {
        return { rows: [{ effect_status: 'pending', effect_step: 0 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const client = { query, release: vi.fn() }
    const pool = { query, connect: vi.fn().mockResolvedValue(client) }

    const materializer = new EventMaterializer({
      pool: pool as never,
      extensionJournalSink: createPostgresExtensionJournalSink(),
      durableHooks: {
        claimQuotaReservationSession: async () => undefined,
        settleQuotaReservation: async () => undefined,
        notifyUser: async () => undefined,
        notifyProUser: async () => undefined,
      },
    })

    await materializer.materialize(ownedInput({
      sessionId: null,
      eventType: 'session_create_failed',
      payload: { type: 'session_create_failed', reason: 'quota', request_id: 'req-1' },
      context: {
        requestId: 'req-1',
        reservationId: 'res-1',
        quotaOperation: 'create',
      },
    }))

    expect(beginEnd).toEqual(['BEGIN', 'COMMIT'])
    expect(sinkCalls.length).toBe(1)
    expect((sinkCalls[0].params as unknown[])[3]).toMatch(/^quota-failure:/)
  })
})

describe('production INSERT INTO events audit', () => {
  test('direct event inserts stay confined to the audited persistence helpers', () => {
    const root = new URL('../', import.meta.url)
    const allowed = new Set([
      'db.ts',
      'config/app-review-demo.ts',
    ])
    const offenders: string[] = []
    for (const file of walk(root)) {
      const relative = decodeURIComponent(file.pathname.slice(root.pathname.length))
      if (allowed.has(relative)) continue
      const source = readFileSync(file, 'utf8')
      if (/INSERT INTO events\b/.test(source)) offenders.push(relative)
    }
    expect(offenders).toEqual([])
  })
})

function* walk(dir: URL): Generator<URL> {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'fixtures') continue
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
    if (entry.isDirectory()) yield* walk(child)
    else if (entry.name.endsWith('.ts')) yield child
  }
}
