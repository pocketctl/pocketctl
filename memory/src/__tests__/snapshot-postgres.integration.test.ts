import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { applyMemorySchema } from '../schema.js'
import { assertMemoryTestDatabase } from '../testing/test-db.js'
import { createSnapshotReconciler } from '../snapshot/reconcile-worker.js'

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL
const integrationEnabled = Boolean(
  databaseUrl && process.env.RUN_MEMORY_POSTGRES_INTEGRATION === '1',
)
const describeWithDatabase = integrationEnabled ? describe : describe.skip

const INSTALLATION = '11111111-1111-1111-1111-111111111111'

function relayEvent(eventId: number, sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    event_id: eventId,
    event_type: 'agent_text',
    payload: { type: 'agent_text', session_id: sessionId, text: 'redacted' },
    created_at: '2026-08-23T00:00:00Z',
    ...overrides,
  }
}

interface RelayScript {
  sessions?: Array<{ session_id: string; cursor: string }>
  /** Pages of events per session id. */
  eventsBySession?: Record<string, Array<Array<Record<string, unknown>>>>
}

function makeRelay(script: RelayScript) {
  const sessions = script.sessions ?? [
    { session_id: 'ses-1', cursor: '1' },
    { session_id: 'ses-2', cursor: '2' },
  ]
  const eventsBySession: Record<string, Array<Array<Record<string, unknown>>>> = script.eventsBySession ?? {
    'ses-1': [[relayEvent(1, 'ses-1'), relayEvent(2, 'ses-1')], [relayEvent(3, 'ses-1')], []],
    // Relay event ids are journal-global: sessions never share one.
    'ses-2': [[relayEvent(4, 'ses-2')], []],
  }
  return {
    listSessions: vi.fn(async (_installationId: string, cursor?: string) => {
      const start = cursor ? sessions.findIndex(s => s.cursor === cursor) + 1 : 0
      const page = sessions.slice(start, start + 1)
      // The next cursor points at this page's last session; the caller
      // resumes strictly after it.
      const next = start + 1 < sessions.length ? page[page.length - 1].cursor : ''
      return { sessions: page, next_cursor: next }
    }),
    getSnapshot: vi.fn(async (_installationId: string, sessionId: string, cursor?: string) => {
      const pages: Array<Array<Record<string, unknown>>> = eventsBySession[sessionId] ?? [[]]
      const pageIndex = cursor ? Number(cursor) : 0
      const page = pages[pageIndex] ?? []
      const next = pageIndex + 1 < pages.length ? String(pageIndex + 1) : ''
      return { events: page as Array<Record<string, unknown>>, next_cursor: next }
    }),
    acknowledgeReconcile: vi.fn(async () => undefined),
  }
}

async function seedLocalSession(pool: pg.Pool, sessionId: string) {
  await pool.query(`
    INSERT INTO source_sessions
      (installation_id, session_id, first_recorded_at, last_recorded_at)
    VALUES ($1, $2, NOW(), NOW())
  `, [INSTALLATION, sessionId])
  await pool.query(`
    INSERT INTO source_events
      (source_event_id, installation_id, origin, origin_position, session_id, event_type,
       occurred_at, payload, payload_hash)
    VALUES (gen_random_uuid(), $1, 'feed', $2, $3, 'agent_text', NOW(), '{}'::jsonb, gen_random_bytes(0)::bytea || ''::bytea)
    ON CONFLICT DO NOTHING
  `, [INSTALLATION, `feed-${sessionId}`, sessionId]).catch(() => undefined)
}

describeWithDatabase('snapshot reconcile (PostgreSQL)', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    await assertMemoryTestDatabase(pool, databaseUrl!)
    await applyMemorySchema(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE memory_jobs, memory_snapshot_runs, memory_snapshot_events,
               memory_feed_inbox, source_artifacts, source_turns, source_events,
               source_sessions, work_episodes, memory_session_tombstones,
               memory_installations RESTART IDENTITY CASCADE
    `)
    await pool.query(`
      INSERT INTO memory_installations
        (installation_id, provider_id, relay_status, local_status, config_version, snapshot_required)
      VALUES ($1, 'pocketctl-memory', 'active', 'degraded', 1, TRUE)
    `, [INSTALLATION])
  })

  test('reconciles multi-page inventory and sessions, commits locally, then acks', async () => {
    await seedLocalSession(pool, 'ses-gone')  // history absent from inventory
    await seedLocalSession(pool, 'ses-1')
    const relay = makeRelay({})
    const reconciler = createSnapshotReconciler({ pool, relay })

    const result = await reconciler.reconcile(INSTALLATION)
    expect(result.state).toBe('completed')
    expect(result.sessionsSeen).toBe(2)
    expect(result.eventsSeen).toBe(4)

    // Inventory covered ses-1/ses-2 with multi-page events each.
    const snapshotRows = await pool.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM memory_snapshot_events ORDER BY session_id`,
    )
    expect(snapshotRows.rows.map(row => row.session_id)).toEqual(['ses-1', 'ses-2'])

    // Snapshot rows are added without treating inventory absence as a
    // tombstone. The helper's empty legacy source fixture adds no event.
    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM source_events WHERE installation_id = $1`,
      [INSTALLATION],
    )
    expect(Number(events.rows[0].count)).toBe(4)

    // Locally committed BEFORE the ack: the ack already sees completed state.
    expect(relay.acknowledgeReconcile).toHaveBeenCalledTimes(1)

    const run = await pool.query<{ state: string; generation: string }>(
      `SELECT state, generation::text FROM memory_snapshot_runs`,
    )
    expect(run.rows[0].state).toBe('completed')

    // Missing inventory entries retain history; present sessions are rebuilt.
    const sessions = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM source_sessions ORDER BY session_id`,
    )
    expect(sessions.rows.map(row => row.session_id)).toEqual(['ses-1', 'ses-2', 'ses-gone'])

    const installation = await pool.query<{ snapshot_required: boolean }>(
      `SELECT snapshot_required FROM memory_installations`,
    )
    expect(installation.rows[0].snapshot_required).toBe(false)
  })

  test('repeated snapshot rebuild preserves original source UUIDs, sequence and provenance', async () => {
    const reconciler = createSnapshotReconciler({ pool, relay: makeRelay({}) })
    await reconciler.reconcile(INSTALLATION)
    await pool.query(`UPDATE source_events SET source_sequence=9007199254740993,
      source_provenance='{"state":"unknown"}',classification='{"content_class":"historical"}'
      WHERE installation_id=$1 AND origin='snapshot' AND origin_position='1'`, [INSTALLATION])
    const before = (await pool.query(`SELECT source_event_id::text,origin_position,source_sequence::text,
      encode(payload_hash,'hex') AS hash,source_provenance,classification
      FROM source_events WHERE installation_id=$1 ORDER BY origin_position`, [INSTALLATION])).rows
    await reconciler.reconcile(INSTALLATION)
    const after = (await pool.query(`SELECT source_event_id::text,origin_position,source_sequence::text,
      encode(payload_hash,'hex') AS hash,source_provenance,classification
      FROM source_events WHERE installation_id=$1 ORDER BY origin_position`, [INSTALLATION])).rows
    expect(after).toEqual(before)
  })

  test('keeps verified Feed UUID and frozen metadata when the snapshot names the same canonical source', async () => {
    const reconciler=createSnapshotReconciler({pool,relay:makeRelay({})})
    await reconciler.reconcile(INSTALLATION)
    const {canonicalPayloadHash}=await import('../inbox/canonical-json.js')
    await pool.query(`UPDATE source_events SET origin='feed',origin_position='1001',
      source_kind='relay_event',canonical_key='1',canonical_session_key='ses-1',
      source_version='{"content":"1","authorization":"1","storage":"1"}',
      source_sequence=9007199254740993,content_hash=$2,hash_version='canonical-json-sha256-v1',
      mapping_state='verified',adapter_version='reviewed-v1',source_provenance='{"state":"unknown"}'
      WHERE installation_id=$1 AND origin_position='1'`,[INSTALLATION,canonicalPayloadHash(relayEvent(1,'ses-1').payload)])
    const before=(await pool.query(`SELECT * FROM source_events WHERE canonical_key='1' AND installation_id=$1`,[INSTALLATION])).rows[0]
    await reconciler.reconcile(INSTALLATION)
    const rows=(await pool.query(`SELECT * FROM source_events WHERE installation_id=$1 AND session_id='ses-1'`,[INSTALLATION])).rows
    expect(rows).toHaveLength(3)
    expect(rows.find(row=>row.source_event_id===before.source_event_id)).toEqual(before)
  })

  test('rejects a verified canonical id with conflicting content rather than replacing its UUID', async () => {
    const reconciler=createSnapshotReconciler({pool,relay:makeRelay({})})
    await reconciler.reconcile(INSTALLATION)
    await pool.query(`UPDATE source_events SET source_kind='relay_event',canonical_key='1',canonical_session_key='ses-1',
      source_version='{"content":"1","authorization":"1","storage":"1"}',content_hash=sha256('wrong'::bytea),
      hash_version='canonical-json-sha256-v1',mapping_state='verified',adapter_version='reviewed-v1'
      WHERE installation_id=$1 AND origin_position='1'`,[INSTALLATION])
    const before=(await pool.query('SELECT source_event_id::text FROM source_events ORDER BY source_event_id')).rows
    await expect(reconciler.reconcile(INSTALLATION)).rejects.toThrow('snapshot canonical source integrity conflict')
    expect((await pool.query('SELECT source_event_id::text FROM source_events ORDER BY source_event_id')).rows).toEqual(before)
    expect((await pool.query('SELECT state FROM memory_snapshot_runs ORDER BY generation DESC LIMIT 1')).rows[0].state).toBe('failed')
  })

  test('equal bodies at different canonical ids remain separate sources', async () => {
    const {canonicalPayloadHash}=await import('../inbox/canonical-json.js')
    const script={sessions:[{session_id:'ses-1',cursor:'1'}],eventsBySession:{'ses-1':[[relayEvent(1,'ses-1'),relayEvent(2,'ses-1')],[]]}}
    const reconciler=createSnapshotReconciler({pool,relay:makeRelay(script)})
    await reconciler.reconcile(INSTALLATION)
    await pool.query(`UPDATE source_events SET source_kind='relay_event',canonical_key='1',canonical_session_key='ses-1',
      source_version='{"content":"1","authorization":"1","storage":"1"}',content_hash=$2,
      hash_version='canonical-json-sha256-v1',mapping_state='verified',adapter_version='reviewed-v1'
      WHERE installation_id=$1 AND origin_position='1'`,[INSTALLATION,canonicalPayloadHash(relayEvent(1,'ses-1').payload)])
    await reconciler.reconcile(INSTALLATION)
    expect((await pool.query('SELECT count(*)::text AS n FROM source_events')).rows[0].n).toBe('2')
  })

  test('inventory absence preserves Team and unproved historical sources, turns and sessions', async () => {
    await seedLocalSession(pool,'team_history')
    const source=(await pool.query(`INSERT INTO source_events
      (source_event_id,installation_id,origin,origin_position,session_id,turn_id,event_type,occurred_at,payload,payload_hash,source_provenance)
      VALUES(gen_random_uuid(),$1,'team','delivery:1','team_history','team-turn','agent_text',NOW(),'{"text":"owned"}',sha256('owned'::bytea),'{"team":{"id":"1"}}') RETURNING source_event_id`,[INSTALLATION])).rows[0]
    await pool.query(`INSERT INTO source_turns(installation_id,turn_id,session_id,state,event_count,first_source_event_id,last_source_event_id)
      VALUES($1,'team-turn','team_history','completed',1,$2,$2)`,[INSTALLATION,source.source_event_id])
    const before=(await pool.query('SELECT * FROM source_events WHERE installation_id=$1 ORDER BY source_event_id',[INSTALLATION])).rows
    const turns=(await pool.query('SELECT * FROM source_turns WHERE installation_id=$1',[INSTALLATION])).rows
    await createSnapshotReconciler({pool,relay:makeRelay({sessions:[]})}).reconcile(INSTALLATION)
    expect((await pool.query('SELECT * FROM source_events WHERE installation_id=$1 ORDER BY source_event_id',[INSTALLATION])).rows).toEqual(before)
    expect((await pool.query('SELECT * FROM source_turns WHERE installation_id=$1',[INSTALLATION])).rows).toEqual(turns)
    expect((await pool.query('SELECT session_id FROM source_sessions WHERE installation_id=$1',[INSTALLATION])).rows).toEqual([{session_id:'team_history'}])
  })

  test('a tombstone prevents snapshot page bodies from landing before finalize', async () => {
    const {createSnapshotRepository}=await import('../snapshot/repository.js')
    const repository=createSnapshotRepository(pool),run=await repository.startRun(INSTALLATION)
    await pool.query(`INSERT INTO memory_session_tombstones(installation_id,session_id,reason,purged_at) VALUES($1,'ses-1','deleted',NOW())`,[INSTALLATION])
    await repository.persistSessionEvents(INSTALLATION,run.generation,'ses-1',[relayEvent(1,'ses-1')])
    expect((await pool.query('SELECT count(*)::text AS n FROM memory_snapshot_events')).rows[0].n).toBe('0')
  })

  test('duplicate Relay ids with different bodies in one page fail before durable landing', async () => {
    const {createSnapshotRepository}=await import('../snapshot/repository.js')
    const repository=createSnapshotRepository(pool),run=await repository.startRun(INSTALLATION)
    await expect(repository.persistSessionEvents(INSTALLATION,run.generation,'ses-1',[
      relayEvent(1,'ses-1'),relayEvent(1,'ses-1',{payload:{text:'different'}}),
    ])).rejects.toThrow('snapshot integrity')
    expect((await pool.query('SELECT count(*)::text AS n FROM memory_snapshot_events')).rows[0].n).toBe('0')
  })

  test('a Relay id cannot be rebound to a different session in another page', async () => {
    const {createSnapshotRepository}=await import('../snapshot/repository.js')
    const repository=createSnapshotRepository(pool),run=await repository.startRun(INSTALLATION)
    await repository.persistSessionEvents(INSTALLATION,run.generation,'ses-1',[relayEvent(1,'ses-1')])
    await expect(repository.persistSessionEvents(INSTALLATION,run.generation,'ses-2',[relayEvent(1,'ses-2')])).rejects.toThrow('snapshot integrity')
    expect((await pool.query('SELECT session_id FROM memory_snapshot_events')).rows).toEqual([{session_id:'ses-1'}])
  })

  test('prepared legacy sources validate the old snapshot envelope while preserving its digest hash', async () => {
    await createSnapshotReconciler({ pool, relay: makeRelay({}) }).reconcile(INSTALLATION)
    const source=(await pool.query("SELECT source_event_id::text,payload_hash FROM source_events WHERE installation_id=$1 AND origin_position='1'",[INSTALLATION])).rows[0]
    const {prepareSourceReferences}=await import('../sources/prepared-sources.js')
    const prepared=await prepareSourceReferences(pool,INSTALLATION,[source.source_event_id])
    expect(prepared.events[0].payload).toEqual(relayEvent(1,'ses-1').payload)
    expect(prepared.events[0].payload_hash).toEqual(source.payload_hash)
    const client=await pool.connect()
    try{await client.query('BEGIN');await prepared.assertCurrent(client);await client.query('ROLLBACK')}finally{client.release()}
    await pool.query("UPDATE source_events SET payload='{\"text\":\"changed\"}' WHERE source_event_id=$1",[source.source_event_id])
    await expect(prepareSourceReferences(pool,INSTALLATION,[source.source_event_id])).rejects.toThrow('source_reference_hash_mismatch')
  })

  test('a payload hash mismatch fails the generation without touching old data', async () => {
    await seedLocalSession(pool, 'ses-1')
    const mutated: Record<string, Array<Array<Record<string, unknown>>>> = {
      'ses-1': [
        [relayEvent(1, 'ses-1')],
        // Same relay event id, different payload → integrity violation.
        [relayEvent(1, 'ses-1', { payload: { type: 'agent_text', text: 'tampered' } })],
        [],
      ],
    }
    const relay = makeRelay({ eventsBySession: mutated })
    const reconciler = createSnapshotReconciler({ pool, relay })
    await expect(reconciler.reconcile(INSTALLATION)).rejects.toThrow(/integrity/)
    expect(relay.acknowledgeReconcile).not.toHaveBeenCalled()
    const run = await pool.query<{ state: string; error_code: string | null }>(
      `SELECT state, error_code FROM memory_snapshot_runs`,
    )
    expect(run.rows[0].state).toBe('failed')
    expect(run.rows[0].error_code).toBe('feed_integrity')
    // Old projection rows survive a failed generation.
    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM source_sessions`,
    )
    expect(Number(events.rows[0].count)).toBe(1)
  })

  test('an inventory failure fails the run and keeps the previous projection', async () => {
    await seedLocalSession(pool, 'ses-1')
    const relay = makeRelay({})
    relay.listSessions.mockRejectedValueOnce(new Error('relay outage'))
    const reconciler = createSnapshotReconciler({ pool, relay })
    await expect(reconciler.reconcile(INSTALLATION)).rejects.toThrow(/outage/)
    expect(relay.acknowledgeReconcile).not.toHaveBeenCalled()
    const sessions = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM source_sessions`,
    )
    expect(Number(sessions.rows[0].count)).toBe(1)
  })

  test('a crashed run resumes under the same generation', async () => {
    const relay = makeRelay({})
    // First attempt dies mid-way after starting the run.
    relay.getSnapshot.mockRejectedValueOnce(new Error('crash'))
    const first = createSnapshotReconciler({ pool, relay })
    await expect(first.reconcile(INSTALLATION)).rejects.toThrow(/crash/)
    const runAfterCrash = await pool.query<{ generation: string; state: string }>(
      `SELECT generation::text, state FROM memory_snapshot_runs`,
    )
    expect(runAfterCrash.rows[0].state).toBe('failed')

    // Retry starts a NEW generation rather than resurrecting the failed one.
    relay.getSnapshot.mockReset()
    relay.getSnapshot.mockImplementation(async (_i: string, sessionId: string, cursor?: string) => {
      const pages: Array<Array<Record<string, unknown>>> = sessionId === 'ses-1'
        ? [[relayEvent(1, 'ses-1')], []]
        : [[relayEvent(2, 'ses-2')], []]
      const pageIndex = cursor ? Number(cursor) : 0
      const page = pages[pageIndex] ?? []
      const next = pageIndex + 1 < pages.length ? String(pageIndex + 1) : ''
      return { events: page, next_cursor: next }
    })
    const second = createSnapshotReconciler({ pool, relay })
    const result = await second.reconcile(INSTALLATION)
    expect(result.state).toBe('completed')
    const runs = await pool.query<{ generation: string; state: string }>(
      `SELECT generation::text, state FROM memory_snapshot_runs ORDER BY generation`,
    )
    expect(runs.rows.map(row => [row.generation, row.state])).toEqual([
      ['1', 'failed'], ['2', 'completed'],
    ])
  })

  test('an ack failure leaves the completed generation for ack-only retry', async () => {
    const relay = makeRelay({})
    relay.acknowledgeReconcile.mockRejectedValueOnce(new Error('ack timeout'))
    const reconciler = createSnapshotReconciler({ pool, relay })
    await expect(reconciler.reconcile(INSTALLATION)).rejects.toThrow(/ack/)
    // Local commit already happened: the run is completed, flag cleared.
    const run = await pool.query<{ state: string }>(`SELECT state FROM memory_snapshot_runs`)
    expect(run.rows[0].state).toBe('completed')
    const installation = await pool.query<{ snapshot_required: boolean }>(
      `SELECT snapshot_required FROM memory_installations`,
    )
    expect(installation.rows[0].snapshot_required).toBe(false)
    const inventoryCalls = relay.listSessions.mock.calls.length
    const snapshotCalls = relay.getSnapshot.mock.calls.length
    // A retry must not re-read or rebuild anything; it only re-acks the
    // already completed local generation.
    const again = await reconciler.reconcile(INSTALLATION)
    expect(again.state).toBe('completed')
    expect(relay.acknowledgeReconcile).toHaveBeenCalledTimes(2)
    expect(relay.listSessions).toHaveBeenCalledTimes(inventoryCalls)
    expect(relay.getSnapshot).toHaveBeenCalledTimes(snapshotCalls)
    const runs = await pool.query<{ count: string; acked_at: Date | null }>(`
      SELECT COUNT(*)::text AS count, MAX(relay_acked_at) AS acked_at
      FROM memory_snapshot_runs
    `)
    expect(runs.rows[0].count).toBe('1')
    expect(runs.rows[0].acked_at).not.toBeNull()
  })

  test('rejects an inventory that still has a cursor at the pagination cap', async () => {
    await seedLocalSession(pool, 'ses-existing')
    const relay = makeRelay({})
    const reconciler = createSnapshotReconciler({ pool, relay, maxPages: 1 })
    await expect(reconciler.reconcile(INSTALLATION)).rejects.toThrow(/pagination incomplete/)
    expect(relay.acknowledgeReconcile).not.toHaveBeenCalled()
    const sessions = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM source_sessions`,
    )
    expect(sessions.rows).toEqual([{ session_id: 'ses-existing' }])
  })

  test('rejects a session snapshot that still has a cursor at the pagination cap', async () => {
    const relay = makeRelay({
      sessions: [{ session_id: 'ses-1', cursor: '1' }],
      eventsBySession: {
        'ses-1': [[relayEvent(1, 'ses-1')], [relayEvent(2, 'ses-1')], []],
      },
    })
    const reconciler = createSnapshotReconciler({ pool, relay, maxPages: 1 })
    await expect(reconciler.reconcile(INSTALLATION)).rejects.toThrow(/pagination incomplete/)
    expect(relay.acknowledgeReconcile).not.toHaveBeenCalled()
  })

  test('stores bigint relay event ids without JavaScript number rounding', async () => {
    const eventId = '9007199254740993'
    const relay = makeRelay({
      sessions: [{ session_id: 'ses-1', cursor: '1' }],
      eventsBySession: {
        'ses-1': [[relayEvent(1, 'ses-1', { event_id: eventId })], []],
      },
    })
    await createSnapshotReconciler({ pool, relay }).reconcile(INSTALLATION)
    const stored = await pool.query<{ relay_event_id: string }>(
      `SELECT relay_event_id::text FROM memory_snapshot_events`,
    )
    expect(stored.rows).toEqual([{ relay_event_id: eventId }])
  })

  test('preserves raced Feed rows without redundant projection work', async () => {
    // ses-1's snapshot event carries a stable identity (event_id: evt-1).
    const script: RelayScript = {
      eventsBySession: {
        'ses-1': [[
          relayEvent(1, 'ses-1', {
            payload: { type: 'agent_text', session_id: 'ses-1', event_id: 'evt-1', text: 'snapshot' },
            created_at: '2026-08-23T00:00:01Z',
          }),
        ], []],
        'ses-2': [[]],
      },
    }
    // Every projected Feed position survives reconciliation, including
    // identity-less and departed-session history. None needs reprojecting.
    const seeds: Array<[number, string, Record<string, unknown>]> = [
      [99, 'ses-1', { event_id: 'evt-99' }],
      [98, 'ses-1', { event_id: 'evt-1' }],
      [97, 'ses-1', {}],
      [96, 'ses-1', { event_id: 'evt-96' }],
      [100, 'ses-departed', { event_id: 'evt-100' }],
    ]
    for (const [feedId, sessionId, data] of seeds) {
      // projected_at slightly ahead of "now": the revive window guard only
      // picks up rows projected during the drain, i.e. at or after the run's
      // started_at, which the seed precedes by milliseconds.
      await pool.query(`
        INSERT INTO memory_feed_inbox
          (installation_id, feed_id, envelope_version, topic, source_kind, source_id,
           session_id, event_type, recorded_at, data, payload_hash, projection_state, projected_at)
        VALUES ($1::uuid, $2::bigint, 1, 'session.event.v1', 'canonical_event', $3,
                $3, 'agent_text', NOW(), $4::jsonb, sha256($5::text::bytea), 'projected',
                NOW() + INTERVAL '5 seconds')
      `, [INSTALLATION, feedId, sessionId, JSON.stringify(data), `seed-${feedId}`])
      await pool.query(`
        INSERT INTO source_events
          (source_event_id, installation_id, origin, origin_position, session_id,
           event_type, occurred_at, payload, payload_hash)
        VALUES (gen_random_uuid(), $1::uuid, 'feed', $2, $3, 'agent_text', NOW(), $4::jsonb,
                sha256($5::text::bytea))
      `, [INSTALLATION, String(feedId), sessionId, JSON.stringify(data), `seed-${feedId}`])
    }

    // Push feed 96's projection timestamp out of the race window.
    await pool.query(`
      UPDATE memory_feed_inbox SET projected_at = NOW() - INTERVAL '20 minutes'
      WHERE installation_id = $1 AND feed_id = 96
    `, [INSTALLATION])

    const relay = makeRelay(script)
    const reconciler = createSnapshotReconciler({ pool, relay })
    await reconciler.reconcile(INSTALLATION)

    const states = await pool.query<{ feed_id_str: string; projection_state: string }>(`
      SELECT feed_id::text AS feed_id_str, projection_state FROM memory_feed_inbox
      WHERE installation_id = $1 ORDER BY feed_id
    `, [INSTALLATION])
    expect(states.rows).toEqual([
      { feed_id_str: '96', projection_state: 'projected' },
      { feed_id_str: '97', projection_state: 'projected' },
      { feed_id_str: '98', projection_state: 'projected' },
      { feed_id_str: '99', projection_state: 'projected' },
      { feed_id_str: '100', projection_state: 'projected' },
    ])

    // The identity-matched row keeps its rebuilt snapshot representative —
    // no feed-origin duplicate was created for evt-1.
    const evt1 = await pool.query<{ origin: string }>(`
      SELECT origin FROM source_events
      WHERE installation_id = $1 AND canonical_event_key = 'event_id:evt-1'
    `, [INSTALLATION])
    expect(evt1.rows).toEqual([{ origin: 'snapshot' }])

    // Inventory absence keeps the historical Feed event.
    const departedEvent = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM source_events
      WHERE installation_id = $1 AND origin_position = '100'
    `, [INSTALLATION])
    expect(Number(departedEvent.rows[0].count)).toBe(1)

    // No replay job: original Feed positions survived.
    const projectJobs = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM memory_jobs
      WHERE installation_id = $1 AND job_type = 'project_feed'
    `, [INSTALLATION])
    expect(Number(projectJobs.rows[0].count)).toBe(0)
  })

  test('a tombstoned session still listed by relay never resurrects', async () => {
    await pool.query(`
      INSERT INTO memory_session_tombstones (installation_id, session_id, reason, purged_at)
      VALUES ($1, 'ses-2', 'user_deleted', NOW())
    `, [INSTALLATION])
    const relay = makeRelay({})
    const reconciler = createSnapshotReconciler({ pool, relay })
    await reconciler.reconcile(INSTALLATION)

    const resurrected = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM source_events
      WHERE installation_id = $1 AND session_id = 'ses-2'
    `, [INSTALLATION])
    expect(Number(resurrected.rows[0].count)).toBe(0)
    const session = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM source_sessions
      WHERE installation_id = $1 AND session_id = 'ses-2'
    `, [INSTALLATION])
    expect(Number(session.rows[0].count)).toBe(0)
  })

  test('expires a stale running generation so a crashed run cannot wedge the installation', async () => {
    await pool.query(`
      INSERT INTO memory_snapshot_runs (run_id, installation_id, generation, state, started_at)
      VALUES (gen_random_uuid(), $1, 1, 'running', NOW() - INTERVAL '3 hours')
    `, [INSTALLATION])
    const relay = makeRelay({})
    const reconciler = createSnapshotReconciler({ pool, relay })
    // The stale row is failed inside startRun and the reconcile proceeds.
    const result = await reconciler.reconcile(INSTALLATION)
    expect(result.state).toBe('completed')
    const runs = await pool.query<{ generation: string; state: string; error_code: string | null }>(`
      SELECT generation::text, state, error_code FROM memory_snapshot_runs ORDER BY generation
    `)
    expect(runs.rows.map(row => [row.generation, row.state, row.error_code])).toEqual([
      ['1', 'failed', 'stale_running'],
      ['2', 'completed', null],
    ])
  })

  test('a live running generation rejects a second reconcile without wedging', async () => {
    await pool.query(`
      INSERT INTO memory_snapshot_runs (run_id, installation_id, generation, state)
      VALUES (gen_random_uuid(), $1, 1, 'running')
    `, [INSTALLATION])
    const relay = makeRelay({})
    const reconciler = createSnapshotReconciler({ pool, relay })
    // startRun hits the v5 index; the error propagates to the job ladder
    // (no run row was created, so no failRun bookkeeping exists to break).
    await expect(reconciler.reconcile(INSTALLATION)).rejects.toThrow()
    expect(relay.listSessions).not.toHaveBeenCalled()
    expect(relay.acknowledgeReconcile).not.toHaveBeenCalled()
  })

  test('the canonical key SQL matches the TypeScript extractor', async () => {
    const corpus: Array<Record<string, unknown>> = [
      { event_id: 'e-1' },
      { event_id: '' },
      { event_id: 42 },
      { event_id: true },
      { message_id: 'm', part_id: 'p', revision: 3 },
      { message_id: 'm', part_id: 'p', revision: 'v2' },
      { message_id: 'm', part_id: 'p', revision: 0 },
      { message_id: 'm', part_id: 'p', revision: 0.5 },
      { message_id: 'm', part_id: 'p', revision: false },
      { message_id: 'm', part_id: '', revision: 1 },
      { message_id: 7, part_id: 'p', revision: 1 },
      { call_id: 'c', event_type: 'tool_call' },
      { call_id: 'c' },
      { type: 'agent_text' },
      {},
    ]
    const stored = corpus.map(item => ({ ...item, session_id: 'ses-1' }))
    const script: RelayScript = {
      eventsBySession: {
        'ses-1': [stored.map((payload, index) => relayEvent(index + 1, 'ses-1', { payload })), []],
        'ses-2': [[]],
      },
    }
    const relay = makeRelay(script)
    await createSnapshotReconciler({ pool, relay }).reconcile(INSTALLATION)

    const { extractCanonicalEventKey } = await import('../projection/event-identity.js')
    const rows = await pool.query<{ canonical_event_key: string | null }>(`
      SELECT canonical_event_key FROM source_events
      WHERE installation_id = $1 AND session_id = 'ses-1'
      ORDER BY origin_position::bigint
    `, [INSTALLATION])
    expect(rows.rows.length).toBe(stored.length)
    for (let i = 0; i < stored.length; i++) {
      expect(rows.rows[i].canonical_event_key, `payload ${JSON.stringify(stored[i])}`)
        .toBe(extractCanonicalEventKey(stored[i]))
    }
  })

  test('identical occurred_at breaks ties by relay arrival order, deterministically', async () => {
    // Two same-turn events share a timestamp across sessions; the lower
    // relay event id (journal arrival order) must win the attribution, and
    // repeated reconciles must not flip the outcome.
    const script: RelayScript = {
      eventsBySession: {
        'ses-1': [[
          relayEvent(20, 'ses-1', {
            payload: { type: 'agent_text', session_id: 'ses-1', turn_id: 'turn-d', text: 'later arrival' },
            created_at: '2026-08-23T00:00:00Z',
          }),
        ], []],
        'ses-2': [[
          relayEvent(10, 'ses-2', {
            payload: { type: 'agent_text', session_id: 'ses-2', turn_id: 'turn-d', text: 'earlier arrival' },
            created_at: '2026-08-23T00:00:00Z',
          }),
        ], []],
      },
    }
    const relay = makeRelay(script)
    const reconciler = createSnapshotReconciler({ pool, relay })
    const readTurn = async () => pool.query<{ session_id: string; event_count: string }>(`
      SELECT session_id, event_count::text FROM source_turns
      WHERE installation_id = $1 AND turn_id = 'turn-d'
    `, [INSTALLATION])

    await reconciler.reconcile(INSTALLATION)
    let turn = await readTurn()
    expect(turn.rows[0]).toEqual({ session_id: 'ses-2', event_count: '2' })

    await reconciler.reconcile(INSTALLATION)
    turn = await readTurn()
    expect(turn.rows[0]).toEqual({ session_id: 'ses-2', event_count: '2' })
  })

  test('a turn id reused across two sessions rebuilds as one turn without wedging', async () => {
    // Same payload-supplied turn id in two inventory sessions: the rebuild
    // must attribute it to the earliest event's session (feed-equivalent
    // first-insert-wins) instead of violating the (installation, turn) key
    // and dead-lettering the reconcile job for good.
    const script: RelayScript = {
      eventsBySession: {
        'ses-1': [[
          relayEvent(1, 'ses-1', {
            payload: { type: 'agent_text', session_id: 'ses-1', turn_id: 'turn-c', text: 'first' },
            created_at: '2026-08-23T00:00:01Z',
          }),
          relayEvent(2, 'ses-1', {
            payload: {
              type: 'turn_lifecycle', session_id: 'ses-1', turn_id: 'turn-c',
              status: 'completed', reason: 'done',
            },
            created_at: '2026-08-23T00:00:02Z',
          }),
        ], []],
        'ses-2': [[
          relayEvent(10, 'ses-2', {
            payload: { type: 'agent_text', session_id: 'ses-2', turn_id: 'turn-c', text: 'collision' },
            created_at: '2026-08-23T00:00:05Z',
          }),
        ], []],
      },
    }
    const relay = makeRelay(script)
    const reconciler = createSnapshotReconciler({ pool, relay })
    const result = await reconciler.reconcile(INSTALLATION)
    expect(result.state).toBe('completed')

    const turns = await pool.query<{ turn_id: string; session_id: string; state: string; event_count: string }>(`
      SELECT turn_id, session_id, state, event_count::text
      FROM source_turns WHERE installation_id = $1
    `, [INSTALLATION])
    expect(turns.rows).toEqual([
      { turn_id: 'turn-c', session_id: 'ses-1', state: 'completed', event_count: '3' },
    ])
  })

  test('rebuilds turns, artifacts and episode work after a reconcile', async () => {
    await seedLocalSession(pool, 'ses-1')
    // A stale episode for a turn the snapshot no longer knows, plus one for
    // a turn that will be rebuilt — only the orphan may disappear.
    for (const [turnId, eventCount] of [['turn-gone', 1], ['turn-1', 99]] as const) {
      await pool.query(`
        INSERT INTO work_episodes
          (installation_id, episode_id, session_id, turn_id, state, outcome,
           event_count, compiler_version)
        VALUES ($1, gen_random_uuid(), 'ses-1', $2, 'ready', 'completed', $3, 'stale')
      `, [INSTALLATION, turnId, eventCount])
    }
    const script: RelayScript = {
      eventsBySession: {
        'ses-1': [[
          relayEvent(1, 'ses-1', {
            payload: { type: 'agent_text', session_id: 'ses-1', turn_id: 'turn-1', text: 'a' },
            created_at: '2026-08-23T00:00:01Z',
          }),
          relayEvent(2, 'ses-1', {
            event_type: 'file_change',
            payload: {
              type: 'file_change', session_id: 'ses-1', turn_id: 'turn-1',
              file_path: '/repo/x.ts', change_type: 'edit',
            },
            created_at: '2026-08-23T00:00:02Z',
          }),
          relayEvent(3, 'ses-1', {
            payload: {
              type: 'turn_lifecycle', session_id: 'ses-1', turn_id: 'turn-1',
              status: 'completed', reason: 'done',
            },
            created_at: '2026-08-23T00:00:03Z',
          }),
          // Late same-turn event after the terminal one: the rebuilt state
          // must not regress, exactly like the incremental feed projector.
          relayEvent(4, 'ses-1', {
            payload: {
              type: 'agent_text', session_id: 'ses-1', turn_id: 'turn-1',
              status: 'running', text: 'late',
            },
            created_at: '2026-08-23T00:00:04Z',
          }),
          relayEvent(5, 'ses-1', {
            payload: { type: 'agent_text', session_id: 'ses-1', turn_id: 'turn-2', text: 'b' },
            created_at: '2026-08-23T00:00:05Z',
          }),
        ], []],
        'ses-2': [[]],
      },
    }
    const relay = makeRelay(script)
    const reconciler = createSnapshotReconciler({ pool, relay })
    await reconciler.reconcile(INSTALLATION)

    const turns = await pool.query<{
      turn_id: string
      state: string
      terminal_at: Date | null
      started_at: Date | null
      event_count: string
    }>(`
      SELECT turn_id, state, terminal_at, started_at, event_count::text
      FROM source_turns WHERE installation_id = $1 ORDER BY turn_id
    `, [INSTALLATION])
    expect(turns.rows.map(row => row.turn_id)).toEqual(['turn-1', 'turn-2'])
    const turn1 = turns.rows[0]
    expect(turn1.state).toBe('completed')
    expect(turn1.event_count).toBe('4')
    expect(turn1.started_at?.toISOString()).toBe('2026-08-23T00:00:01.000Z')
    expect(turn1.terminal_at?.toISOString()).toBe('2026-08-23T00:00:03.000Z')
    expect(turns.rows[1].state).toBe('running')

    const artifacts = await pool.query<{ artifact_type: string; path: string }>(`
      SELECT artifact_type, path FROM source_artifacts WHERE installation_id = $1
    `, [INSTALLATION])
    expect(artifacts.rows).toEqual([
      { artifact_type: 'file_change', path: '/repo/x.ts' },
    ])

    const episodes = await pool.query<{ turn_id: string }>(`
      SELECT turn_id FROM work_episodes WHERE installation_id = $1 ORDER BY turn_id
    `, [INSTALLATION])
    expect(episodes.rows.map(row => row.turn_id)).toEqual(['turn-1'])

    const compileJobs = await pool.query<{ idempotency_key: string; state: string }>(`
      SELECT idempotency_key, state FROM memory_jobs
      WHERE installation_id = $1 AND job_type = 'compile_episode' ORDER BY idempotency_key
    `, [INSTALLATION])
    expect(compileJobs.rows).toEqual([
      { idempotency_key: 'compile_episode:turn-1', state: 'pending' },
    ])
  })
})
