import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { FairIngressQueue } from '../ingress/fair-queue.js'
import { IngressController } from '../ingress/controller.js'
import { InboxRepository } from '../ingress/inbox-repository.js'
import { createInboxWorker } from '../inbox-worker.js'
import { EventMaterializer } from '../materialization/event-materializer.js'
import { RealtimeOutboxConsumer, RealtimeOutboxRepository, RealtimeOutboxWriter } from '../materialization/realtime-outbox.js'
import { getRecentEvents } from '../db.js'
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
})
