import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { FairIngressQueue } from '../ingress/fair-queue.js'
import { IngressController } from '../ingress/controller.js'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { createInboxWorker } from '../inbox-worker.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { RealtimeOutboxConsumer, RealtimeOutboxRepository, RealtimeOutboxWriter } from '../materialization/realtime-outbox.js'
import { getRecentEvents, listSessionsPageByDaemon } from '../db.js'
import {
  assertDurableIngressTestDatabase,
  resetDurableIngressTestDatabase,
} from './durable-ingress-test-db.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const describeWithDatabase = databaseUrl ? describe : describe.skip

async function drainWorkerUntilCompleted(
  pool: pg.Pool,
  worker: ReturnType<typeof createInboxWorker>,
  eventId: string,
  maxRuns: number,
): Promise<number> {
  for (let run = 1; run <= maxRuns; run++) {
    await worker.runOnce()
    const result = await pool.query<{ status: number }>(
      `SELECT status
       FROM event_inbox
       WHERE payload->>'event_id' = $1`,
      [eventId],
    )
    if (result.rows[0]?.status === 2) return run
  }
  throw new Error(`mixed-agent Worker did not complete ${eventId} within ${maxRuns} ordered runs`)
}

describeWithDatabase('mixed-Agent durable ingress PostgreSQL release gate', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 })
    await assertDurableIngressTestDatabase(pool, databaseUrl!)
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await resetDurableIngressTestDatabase(pool, databaseUrl!)
  })

  test('prioritizes OpenCode and Claude controls during a 10k Codex replay without payload drift or duplicate usage', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('mixed-agent-gate@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    const identities = [
      ['mixed-codex-daemon', 'mixed-codex-session'],
      ['mixed-opencode-daemon', 'mixed-opencode-session'],
      ['mixed-claude-daemon', 'mixed-claude-session'],
    ] as const
    for (const [daemonId, sessionId] of identities) {
      await pool.query(`INSERT INTO daemons (daemon_id, user_id) VALUES ($1, $2)`, [daemonId, userId])
      await pool.query(
        `INSERT INTO sessions (session_id, daemon_id, user_id, status)
         VALUES ($1, $2, $3, 'running')`,
        [sessionId, daemonId, userId],
      )
    }

    const openCodeQuestion = {
      type: 'question_request',
      session_id: 'mixed-opencode-session',
      request_id: 'mixed-opencode-question',
      event_id: 'mixed-opencode-question-event',
      questions: [{ id: 'choice', question: 'Proceed?', options: [{ label: 'Yes' }] }],
      control_mode: 'managed',
      seq: 1,
    }
    const claudeApproval = {
      type: 'approval_request',
      session_id: 'mixed-claude-session',
      request_id: 'mixed-claude-approval',
      event_id: 'mixed-claude-approval-event',
      approval_kind: 'tool',
      tool: 'Bash',
      input: { command: 'git status --short' },
      available_decisions: ['once', 'reject'],
      seq: 1,
    }
    let controlAcceptedAt = 0
    const controlAckLatency: number[] = []
    const ackByDaemon = new Map<string, number>()
    const repository = new InboxRepository(pool)
    const controller = new IngressController({
      repository,
      queue: new FairIngressQueue({
        maxEventsPerDaemon: 12_000,
        maxEvents: 20_000,
        maxBytesPerDaemon: 32 << 20,
      }),
      sendAck: (daemonId, checkpoint) => {
        ackByDaemon.set(daemonId, checkpoint.ackSeq)
        if (daemonId !== 'mixed-codex-daemon') {
          controlAckLatency.push(performance.now() - controlAcceptedAt)
        }
      },
      disconnectRetryable: () => undefined,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    })

    const target = (
      daemonId: string,
      daemonGeneration: number,
    ) => ({ daemonId, registrationId: `${daemonId}-registration`, userId, daemonGeneration })

    expect(controller.accept(
      target('mixed-codex-daemon', 401),
      {
        type: 'agent_text',
        session_id: 'mixed-codex-session',
        event_id: 'mixed-codex-usage',
        part_id: 'mixed-codex-usage-part',
        revision: 1,
        text: 'usage-bearing event',
        usage: { input_tokens: 7, output_tokens: 5 },
        seq: 1,
      },
      { agentType: 'codex', cwd: '/repo' },
    )).toEqual({ kind: 'accepted' })
    expect(controller.accept(
      target('mixed-codex-daemon', 401),
      {
        type: 'agent_text',
        session_id: 'mixed-codex-session',
        event_id: 'mixed-codex-usage',
        part_id: 'mixed-codex-usage-part',
        revision: 1,
        text: 'usage-bearing event',
        usage: { input_tokens: 7, output_tokens: 5 },
        seq: 2,
      },
      { agentType: 'codex', cwd: '/repo' },
    )).toEqual({ kind: 'accepted' })
    const codexReplaySentinel = {
      type: 'agent_text',
      session_id: 'mixed-codex-session',
      agent_id: 'mixed-codex-child',
      parent_session_id: 'mixed-codex-session',
      root_session_id: 'mixed-codex-session',
      is_subagent: true,
      part_id: 'mixed-codex-replay-sentinel',
      revision: 1,
      snapshot: 'replay sentinel',
      resync: true,
      event_id: 'mixed-codex-replay-sentinel-event',
      seq: 3,
    }
    expect(controller.accept(
      target('mixed-codex-daemon', 401),
      codexReplaySentinel,
      { agentType: 'codex', cwd: '/repo' },
    )).toEqual({ kind: 'accepted' })
    for (let offset = 1; offset < 10_000; offset++) {
      expect(controller.accept(
        target('mixed-codex-daemon', 401),
        {
          type: 'agent_text',
          session_id: 'mixed-codex-session',
          agent_id: 'mixed-codex-child',
          parent_session_id: 'mixed-codex-session',
          root_session_id: 'mixed-codex-session',
          is_subagent: true,
          part_id: `mixed-codex-replay-${offset}`,
          revision: 1,
          snapshot: `replay ${offset}`,
          resync: true,
          event_id: `mixed-codex-replay-event-${offset}`,
          seq: offset + 3,
        },
        { agentType: 'codex', cwd: '/repo' },
      )).toEqual({ kind: 'accepted' })
    }
    controlAcceptedAt = performance.now()
    expect(controller.accept(
      target('mixed-opencode-daemon', 402),
      openCodeQuestion,
      { agentType: 'opencode', cwd: '/repo' },
    )).toEqual({ kind: 'accepted' })
    expect(controller.accept(
      target('mixed-claude-daemon', 403),
      claudeApproval,
      { agentType: 'claude-code', cwd: '/repo' },
    )).toEqual({ kind: 'accepted' })

    await controller.flushNow()

    expect(ackByDaemon.get('mixed-codex-daemon')).toBe(10_002)
    expect(ackByDaemon.get('mixed-opencode-daemon')).toBe(1)
    expect(ackByDaemon.get('mixed-claude-daemon')).toBe(1)
    const sortedControlLatency = [...controlAckLatency].sort((left, right) => left - right)
    const p95Index = Math.max(0, Math.ceil(sortedControlLatency.length * 0.95) - 1)
    expect(sortedControlLatency[p95Index]).toBeLessThan(1_000)

    const durability = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox_receipt) AS receipts,
        (SELECT COUNT(*)::int FROM event_inbox) AS canonical,
        (SELECT COUNT(*)::int FROM event_inbox_receipt receipt
          LEFT JOIN event_inbox inbox ON inbox.inbox_id = receipt.inbox_id
          WHERE inbox.inbox_id IS NULL) AS post_ack_loss
    `)
    expect(durability.rows[0]).toEqual({
      receipts: 10_004,
      canonical: 10_003,
      post_ack_loss: 0,
    })

    const worker = createInboxWorker({
      repository,
      materializer: new EventMaterializer({
        pool,
        durableHooks: {
          claimQuotaReservationSession: async () => undefined,
          settleQuotaReservation: async () => undefined,
          notifyUser: async () => undefined,
          notifyProUser: async () => undefined,
        },
      }),
      workerId: 'mixed-agent-worker',
      shardCount: 1,
      shardIndex: 0,
      batchSize: 64,
      outboxWriter: new RealtimeOutboxWriter(pool),
    })
    const sentinelDrainRuns = await drainWorkerUntilCompleted(
      pool,
      worker,
      codexReplaySentinel.event_id,
      10_004,
    )
    // The sentinel is an early codex-stream row (seq 3), so a correct
    // one-head-per-stream worker reaches it inside the first bounded runOnce;
    // the number of runs is therefore not the bounded-drain guarantee. What
    // bounded drain must prove is that one run cannot finish the 10k replay:
    // after the sentinel's run, almost the whole backlog is still unresolved.
    expect(sentinelDrainRuns).toBeGreaterThanOrEqual(1)
    const unresolved = await pool.query<{ pending: number }>(
      `SELECT COUNT(*)::int AS pending FROM event_inbox WHERE status IN (0, 1)`,
    )
    expect(unresolved.rows[0].pending).toBeGreaterThan(9_000)

    const delivered: Array<{ type: string; sessionId: string | null; payload: Record<string, unknown> }> = []
    const consumer = new RealtimeOutboxConsumer({
      repository: new RealtimeOutboxRepository(pool),
      batchSize: 64,
      deliver: (delivery) => {
        delivered.push({ type: delivery.type, sessionId: delivery.sessionId, payload: delivery.payload })
        return true
      },
    })
    await consumer.runOnce()
    expect(delivered).toEqual(expect.arrayContaining([
      { type: 'question_request', sessionId: 'mixed-opencode-session', payload: openCodeQuestion },
      { type: 'approval_request', sessionId: 'mixed-claude-session', payload: claudeApproval },
      { type: 'agent_text', sessionId: 'mixed-codex-session', payload: codexReplaySentinel },
    ]))

    const sessionVisibleReplay = await getRecentEvents(pool, 'mixed-codex-session', 100)
    expect(sessionVisibleReplay).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: 'agent_text',
        payload: codexReplaySentinel,
      }),
    ]))

    const usage = await pool.query<{
      tok_input: number;
      tok_output: number;
      usage_events: number;
    }>(`
      SELECT
        sessions.tok_input::int,
        sessions.tok_output::int,
        (SELECT COUNT(*)::int FROM events
          WHERE session_id = 'mixed-codex-session'
            AND payload->>'event_id' = 'mixed-codex-usage') AS usage_events
      FROM sessions
      WHERE session_id = 'mixed-codex-session'
    `)
    expect(usage.rows[0]).toEqual({ tok_input: 7, tok_output: 5, usage_events: 1 })
  }, 120_000)

  test('materializes a replayed Codex Desktop history once with observer policy and stable session activity', async () => {
    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (email, password_hash)
       VALUES ('desktop-observer-e2e@example.test', '') RETURNING id`,
    )
    const userId = user.rows[0].id
    const daemonId = 'desktop-observer-e2e-daemon'
    const sessionId = 'desktop-observer-e2e-12345678'
    await pool.query(
      `INSERT INTO daemons (daemon_id, user_id, hostname, status)
       VALUES ($1, $2, 'fixture-host', 'online')`,
      [daemonId, userId],
    )
    await pool.query(
      `INSERT INTO sessions (
         session_id, daemon_id, user_id, agent_type, source, control_mode,
         capabilities, status, cwd, title, model, last_activity_at
       ) VALUES (
         $1, $2, $3, 'codex', 'terminal', 'legacy_read_only', '[]'::jsonb,
         'exited', '/fixture/project', 'old fixture title', 'old-fixture-model',
         '2026-09-01T00:00:00.000Z'::timestamptz
       )`,
      [sessionId, daemonId, userId],
    )

    const sourceActivity = '2026-09-01T01:02:03.000Z'
    const history: Array<Record<string, any>> = [
      {
        type: 'session_discovered', session_id: sessionId,
        agent: 'codex-desktop', source: 'observer', control_mode: 'legacy_read_only',
        capabilities: ['history_sync'], status: 'busy', cwd: '/fixture/project',
        title: 'Terminal Session-12345678', model: 'gpt-5.6-fixture',
        last_activity_at: sourceActivity,
      },
      {
        type: 'session_model_changed', session_id: sessionId,
        model: 'gpt-5.6-fixture',
      },
      {
        type: 'session_model_changed', session_id: sessionId, event_id: 'jsonl:desktop-source:1:0',
        model: 'gpt-5.6-fixture', resync: true,
      },
      {
        type: 'session_meta', session_id: sessionId, event_id: 'jsonl:desktop-source:1:1',
        effort: 'high', resync: true,
      },
      {
        type: 'turn_status', session_id: sessionId, event_id: 'turn:desktop-fixture:status:running',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_status: 'running', turn_reason: 'task_started_event', turn_origin: 'native', turn_confidence: 'native',
        actor_scope: 'root', flow_scope: 'auxiliary', content_class: 'lifecycle', classifier_version: 'v1', resync: true,
      },
      {
        type: 'user_text', session_id: sessionId, event_id: 'jsonl:desktop-source:3:0',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_origin: 'native', turn_confidence: 'native', text: 'fixture user request', resync: true,
      },
      {
        type: 'tool_call', session_id: sessionId, event_id: 'jsonl:desktop-source:4:0',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_origin: 'native', turn_confidence: 'native', call_id: 'fixture-call-1', tool: 'exec',
        input: { cmd: 'printf fixture' }, resync: true,
      },
      {
        type: 'tool_result', session_id: sessionId, event_id: 'jsonl:desktop-source:5:0',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_origin: 'native', turn_confidence: 'native', call_id: 'fixture-call-1',
        output: 'fixture tool result', resync: true,
      },
      {
        type: 'agent_file_change', session_id: sessionId, event_id: 'codex:file-change:fixture',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_origin: 'native', turn_confidence: 'native', change_set_id: 'native:fixture-patch-1',
        call_id: 'fixture-patch-1', change_index: 0, change_total: 1,
        path: 'fixture.txt', change_kind: 'create', status: 'completed',
        diff: '--- /dev/null\n+++ b/fixture.txt\n@@ -0,0 +1 @@\n+fixture file\n',
        additions: 1, deletions: 0, resync: true,
      },
      {
        type: 'tool_call', session_id: sessionId, event_id: 'jsonl:desktop-source:7:0',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_origin: 'native', turn_confidence: 'native', call_id: 'fixture-plan-1', tool: 'update_plan',
        input: { explanation: 'fixture plan', plan: [{ step: 'fixture step', status: 'completed' }] },
        resync: true,
      },
      {
        type: 'agent_plan', session_id: sessionId, event_id: 'codex:plan:fixture-plan-1',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_origin: 'native', turn_confidence: 'native', part_id: `plan:${sessionId}`, revision: 1,
        explanation: 'fixture plan', plan: [{ step: 'fixture step', status: 'completed' }],
        resync: true,
      },
      {
        type: 'agent_text', session_id: sessionId, event_id: 'jsonl:desktop-source:8:0',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_origin: 'native', turn_confidence: 'native', text: 'fixture assistant response',
        resync: true,
      },
      {
        type: 'agent_text', session_id: sessionId, event_id: 'jsonl:desktop-source:10:0',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_origin: 'native', turn_confidence: 'native',
        usage: { input_tokens: 13, output_tokens: 8, cache_read_tokens: 5, reasoning_tokens: 3, total_tokens: 21 },
        resync: true,
      },
      {
        type: 'turn_status', session_id: sessionId, event_id: 'turn:desktop-fixture:status:completed',
        turn_id: 'turn:v1:codex:fixture', source_turn_id: 'fixture-turn-1',
        turn_status: 'completed', turn_reason: 'task_complete_event', turn_origin: 'native', turn_confidence: 'native',
        actor_scope: 'root', flow_scope: 'auxiliary', content_class: 'lifecycle', classifier_version: 'v1', resync: true,
      },
      {
        type: 'session_status', session_id: sessionId,
        status: 'busy', resync: true,
      },
    ]

    const repository = new InboxRepository(pool)
    const acked = new Map<number, number>()
    const ingest = async (generation: number) => {
      const controller = new IngressController({
        repository,
        queue: new FairIngressQueue({ maxEventsPerDaemon: 64, maxEvents: 128 }),
        sendAck: (_ackedDaemon, checkpoint) => acked.set(generation, checkpoint.ackSeq),
        disconnectRetryable: () => undefined,
        setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
        clearTimer: () => undefined,
      })
      for (const [index, event] of history.entries()) {
        expect(controller.accept(
          { daemonId, registrationId: `desktop-registration-${generation}`, userId, daemonGeneration: generation },
          { ...event, seq: index + 1 },
          { agentType: 'codex', cwd: '/fixture/project' },
        )).toEqual({ kind: 'accepted' })
      }
      await controller.flushNow()
    }

    await ingest(901)
    await ingest(902)
    expect(acked).toEqual(new Map([[901, history.length], [902, history.length]]))

    const worker = createInboxWorker({
      repository,
      materializer: new EventMaterializer({
        pool,
        durableHooks: {
          claimQuotaReservationSession: async () => undefined,
          settleQuotaReservation: async () => undefined,
          notifyUser: async () => undefined,
          notifyProUser: async () => undefined,
        },
      }),
      workerId: 'desktop-observer-e2e-worker',
      shardCount: 1,
      shardIndex: 0,
      batchSize: 32,
      outboxWriter: new RealtimeOutboxWriter(pool),
    })
    await drainWorkerUntilCompleted(pool, worker, 'turn:desktop-fixture:status:completed', 32)
    await worker.runOnce()

    const durable = await pool.query<{
      canonical: number; receipts: number; events: number;
      stable_inbox: number; generation_scoped_inbox: number;
      stable_events: number; no_id_events: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM event_inbox WHERE daemon_id = $1) AS canonical,
         (SELECT COUNT(*)::int FROM event_inbox_receipt WHERE daemon_id = $1) AS receipts,
         (SELECT COUNT(*)::int FROM events WHERE session_id = $2) AS events,
         (SELECT COUNT(*)::int FROM event_inbox WHERE daemon_id = $1 AND payload ? 'event_id') AS stable_inbox,
         (SELECT COUNT(*)::int FROM event_inbox WHERE daemon_id = $1 AND NOT payload ? 'event_id') AS generation_scoped_inbox,
         (SELECT COUNT(*)::int FROM events WHERE session_id = $2 AND payload ? 'event_id') AS stable_events,
         (SELECT COUNT(*)::int FROM events WHERE session_id = $2 AND NOT payload ? 'event_id') AS no_id_events`,
      [daemonId, sessionId],
    )
    // The actual main handler emits three no-ID frames per generation:
    // discovery, its separately extracted model, and the current status after
    // hydration. They remain generation-scoped in the inbox, while identical
    // payload hashes converge in events. The twelve retained JSONL projections
    // use stable IDs and deduplicate in both layers.
    expect(durable.rows[0]).toEqual({
      canonical: 18,
      receipts: history.length * 2,
      events: history.length,
      stable_inbox: 12,
      generation_scoped_inbox: 6,
      stable_events: 12,
      no_id_events: 3,
    })

    const persisted = await pool.query<{
      agent_type: string; source: string; control_mode: string; capabilities: string[];
      status: string; cwd: string; title: string; model: string; last_activity_at: Date;
      total_tokens: number; tok_input: number; tok_output: number; tok_cache_read: number;
    }>(
      `SELECT agent_type, source, control_mode, capabilities, status, cwd, title, model,
              last_activity_at, total_tokens::int, tok_input::int, tok_output::int, tok_cache_read::int
       FROM sessions WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    )
    expect({ ...persisted.rows[0], last_activity_at: persisted.rows[0].last_activity_at.toISOString() }).toEqual({
      agent_type: 'codex-desktop', source: 'observer', control_mode: 'legacy_read_only',
      capabilities: ['history_sync'], status: 'busy', cwd: '/fixture/project',
      title: 'Terminal Session-12345678', model: 'gpt-5.6-fixture', last_activity_at: sourceActivity,
      total_tokens: 26, tok_input: 13, tok_output: 8, tok_cache_read: 5,
    })

    const list = await listSessionsPageByDaemon(pool, { userId, daemonId, limit: 20 })
    expect(list.sessions).toHaveLength(1)
    expect(list.sessions[0]).toMatchObject({
      session_id: sessionId, agent_type: 'codex-desktop', source: 'observer',
      control_mode: 'legacy_read_only', capabilities: ['history_sync'], status: 'busy',
      title: 'Terminal Session-12345678', model: 'gpt-5.6-fixture', totalTokens: 26,
    })
    expect(new Date(list.sessions[0].last_activity_at).toISOString()).toBe(sourceActivity)

    const replay = (await getRecentEvents(pool, sessionId, 100)).reverse()
    expect(replay).toHaveLength(history.length)
    expect(replay.filter((row) => row.payload.event_id).map((row) => row.payload.event_id)).toEqual(
      history.filter((event) => event.event_id).map((event) => event.event_id),
    )
    expect(replay.filter((row) => !row.payload.event_id).map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'session_discovered', 'session_model_changed', 'session_status',
    ]))
    expect(replay.filter((row) => !row.payload.event_id)).toHaveLength(3)
    expect(replay.filter((row) => row.event_type === 'session_model_changed')).toHaveLength(2)
    expect(replay.filter((row) => row.event_type === 'session_meta')).toHaveLength(1)
    expect(replay.filter((row) => row.event_type === 'session_status')).toHaveLength(1)
    expect(replay.filter((row) => row.event_type === 'tool_call')).toHaveLength(2)
    expect(replay.filter((row) => row.event_type === 'agent_plan')).toHaveLength(1)
    const assistantEvents = replay.filter((row) => row.event_type === 'agent_text')
    expect(assistantEvents).toHaveLength(2)
    expect(assistantEvents.filter((row) => row.payload.text === 'fixture assistant response')).toHaveLength(1)
    expect(assistantEvents.find((row) => row.payload.text === 'fixture assistant response')?.payload.usage).toBeUndefined()
    expect(assistantEvents.find((row) => row.payload.usage)?.payload.text).toBeUndefined()
    expect(assistantEvents.find((row) => row.payload.usage)?.payload.usage).toEqual({
      input_tokens: 13, output_tokens: 8, cache_read_tokens: 5, reasoning_tokens: 3, total_tokens: 21,
    })
    expect(replay.find((row) => row.event_type === 'user_text')?.payload.text).toBe('fixture user request')
    expect(replay.find((row) => row.event_type === 'tool_result')?.payload.output).toBe('fixture tool result')
    expect(replay.find((row) => row.event_type === 'agent_file_change')?.payload.path).toBe('fixture.txt')
  }, 30_000)
})
