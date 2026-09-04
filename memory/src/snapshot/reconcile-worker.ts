import type pg from 'pg'
import type { JobClaim } from '../jobs/types.js'
import { createSnapshotRepository } from './repository.js'

export interface SnapshotReconcilerOptions {
  pool: pg.Pool
  relay: {
    listSessions(installationId: string, cursor?: string): Promise<{
      sessions: Array<Record<string, unknown>>
      next_cursor: string
    }>
    getSnapshot(installationId: string, sessionId: string, cursor?: string): Promise<{
      events: Array<Record<string, unknown>>
      next_cursor: string
    }>
    acknowledgeReconcile(installationId: string): Promise<void>
  }
  /** Safety cap on pagination loops (malformed relay pages). */
  maxPages?: number
  onSnapshotResult?(result: 'success' | 'failure'): void
}

const DEFAULT_MAX_PAGES = 10_000

/**
 * Snapshot reconcile: drain the inventory page by page, land every session's
 * events durably, then finalize locally (authoritative rebuild + flag clear)
 * and only afterwards ACK Relay. Failures anywhere before the finalize keep
 * the previous projection intact; an ACK failure retries the ack only.
 */
export function createSnapshotReconciler(options: SnapshotReconcilerOptions) {
  const repository = createSnapshotRepository(options.pool)
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES

  async function reconcile(installationId: string): Promise<{
    state: 'completed'
    generation: number
    sessionsSeen: number
    eventsSeen: number
  }> {
    const pendingAck = await repository.pendingAcknowledgement(installationId)
    if (pendingAck) {
      try {
        await options.relay.acknowledgeReconcile(installationId)
        await repository.markAcknowledged(installationId, pendingAck.generation)
      } catch (error) {
        options.onSnapshotResult?.('failure')
        throw error
      }
      options.onSnapshotResult?.('success')
      return { state: 'completed', ...pendingAck }
    }

    const run = await repository.startRun(installationId)
    try {
      const inventorySessionIds: string[] = []
      let sessionsSeen = 0
      let eventsSeen = 0
      let cursor: string | undefined
      let inventoryComplete = false
      for (let page = 0; page < maxPages; page++) {
        const result = await options.relay.listSessions(installationId, cursor)
        // An empty page is the terminator even when Relay keeps returning a
        // (position-carrying) cursor for it.
        if (result.sessions.length === 0) {
          inventoryComplete = true
          break
        }
        for (const session of result.sessions) {
          const sessionId = String(session.session_id ?? '')
          if (!sessionId) continue
          inventorySessionIds.push(sessionId)
          sessionsSeen++
          eventsSeen += await drainSessionEvents(installationId, run.generation, sessionId)
        }
        if (!result.next_cursor) {
          inventoryComplete = true
          break
        }
        cursor = result.next_cursor
      }
      if (!inventoryComplete) throw new Error('snapshot inventory pagination incomplete')
      await repository.finalizeRun({
        installationId,
        generation: run.generation,
        inventorySessionIds,
        sessionsSeen,
        eventsSeen,
      })
    } catch (error) {
      const code = /integrity/.test(error instanceof Error ? error.message : '')
        ? 'feed_integrity'
        : 'snapshot_failed'
      await repository.failRun(installationId, run.generation, code)
      options.onSnapshotResult?.('failure')
      throw error
    }

    // Local commit done; the completion ACK is retried on failure without
    // redoing the rebuild.
    try {
      await options.relay.acknowledgeReconcile(installationId)
      await repository.markAcknowledged(installationId, run.generation)
    } catch (error) {
      options.onSnapshotResult?.('failure')
      throw error
    }
    options.onSnapshotResult?.('success')
    return {
      state: 'completed',
      generation: run.generation,
      sessionsSeen: await countSessionsSeen(installationId, run.generation),
      eventsSeen: await countEventsSeen(installationId, run.generation),
    }
  }

  async function drainSessionEvents(
    installationId: string,
    generation: number,
    sessionId: string,
  ): Promise<number> {
    let seen = 0
    let cursor: string | undefined
    let complete = false
    for (let page = 0; page < maxPages; page++) {
      const result = await options.relay.getSnapshot(installationId, sessionId, cursor)
      seen += await repository.persistSessionEvents(
        installationId, generation, sessionId, result.events,
      )
      if (!result.next_cursor || result.events.length === 0) {
        complete = true
        break
      }
      cursor = result.next_cursor
    }
    if (!complete) throw new Error(`snapshot session pagination incomplete for ${sessionId}`)
    return seen
  }

  async function countSessionsSeen(installationId: string, generation: number): Promise<number> {
    const result = await options.pool.query<{ count: string }>(
      `SELECT sessions_seen::text AS count FROM memory_snapshot_runs
       WHERE installation_id = $1 AND generation = $2`,
      [installationId, generation],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  async function countEventsSeen(installationId: string, generation: number): Promise<number> {
    const result = await options.pool.query<{ count: string }>(
      `SELECT events_seen::text AS count FROM memory_snapshot_runs
       WHERE installation_id = $1 AND generation = $2`,
      [installationId, generation],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  return {
    reconcile,
    async handleSnapshotReconcile(job: JobClaim, signal: AbortSignal): Promise<void> {
      if (!job.installation_id) return
      if (signal.aborted) throw new Error('snapshot_reconcile aborted')
      await reconcile(job.installation_id)
    },
  }
}

export type SnapshotReconciler = ReturnType<typeof createSnapshotReconciler>
