import { randomUUID } from 'node:crypto'
import type pg from 'pg'

/** Team quality decisions are not native approval commands. Keep their durable
 * attention records separate, as with recovery records in the existing Inbox. */
export class TeamDeliveryProjector {
  private timer?: ReturnType<typeof setTimeout>
  private running?: Promise<number>
  private stopped = true
  constructor(private readonly pool: pg.Pool, private readonly intervalMs = 1000) {}

  async runOnce(): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // No numeric cursor: each outbox row is marked only after its projection.
      const tasks = (await client.query(`SELECT task_id FROM team_delivery_outbox WHERE processed_at IS NULL
        GROUP BY task_id ORDER BY min(created_at),task_id LIMIT 50`)).rows
      let count = 0
      for (const { task_id: taskId } of tasks) {
        // Same lock order as delivery mutations; independent workers skip a
        // claimed task and cannot reopen an item using an older event payload.
        const task = (await client.query('SELECT state FROM team_tasks WHERE task_id=$1 FOR UPDATE SKIP LOCKED', [taskId])).rows[0]
        if (!task) continue
        const events = (await client.query('SELECT event_id FROM team_delivery_outbox WHERE task_id=$1 AND processed_at IS NULL ORDER BY created_at,event_id LIMIT 500 FOR UPDATE', [taskId])).rows
        if (!events.length) continue
        const current = (await client.query(`WITH heads AS (
          SELECT task_id,spec_revision,latest_submission_id,
            NOT EXISTS(SELECT 1 FROM team_task_plan_runtime r WHERE r.task_id=h.task_id) AS scope_active
            FROM team_task_delivery_heads h WHERE task_id=$1
          UNION ALL
          SELECT h.task_id,h.spec_revision,h.latest_submission_id,a.state<>'cancelled' AS scope_active
            FROM team_step_delivery_heads h JOIN team_task_step_attempts a ON a.attempt_id=h.attempt_id AND a.task_id=h.task_id WHERE h.task_id=$1
          ) SELECT s.submission_id,s.submitted_by_user_id,p.reviewer_user_id,d.decision,h.scope_active
          FROM heads h
          JOIN team_task_specs p ON p.task_id=h.task_id AND p.revision=h.spec_revision
          JOIN team_task_submissions s ON s.submission_id=h.latest_submission_id AND s.task_id=h.task_id AND s.spec_revision=h.spec_revision AND s.state='published'
          LEFT JOIN team_acceptance_decisions d ON d.submission_id=s.submission_id
          WHERE h.task_id=$1`, [taskId])).rows
        const active = current.filter(row => ['open','in_progress'].includes(task.state) && row.scope_active && row.decision !== 'accepted').map(row => ({
          submission_id: row.submission_id, user_id: Number(row.decision === 'changes_requested' ? row.submitted_by_user_id : row.reviewer_user_id),
          kind: row.decision === 'changes_requested' ? 'changes_requested' : 'review_required',
        }))
        await client.query(`UPDATE team_delivery_attention_items i SET state=CASE WHEN submission_id=ANY($2::uuid[]) THEN 'resolved' ELSE 'superseded' END,
          revision=revision+1,updated_at=NOW() WHERE task_id=$1 AND state='open'
          AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) AS keep(submission_id uuid,user_id int,kind text)
            WHERE keep.submission_id=i.submission_id AND keep.user_id=i.user_id AND keep.kind=i.kind)`, [taskId, current.map(row => row.submission_id), JSON.stringify(active)])
        for (const item of active) await client.query(`INSERT INTO team_delivery_attention_items(item_id,task_id,submission_id,user_id,kind,state)
          VALUES($1,$2,$3,$4,$5,'open') ON CONFLICT(submission_id,user_id,kind) DO UPDATE SET
          state='open',revision=team_delivery_attention_items.revision+1,updated_at=NOW()
          WHERE team_delivery_attention_items.state<>'open'`, [randomUUID(), taskId, item.submission_id, item.user_id, item.kind])
        await client.query('UPDATE team_delivery_outbox SET processed_at=NOW() WHERE event_id=ANY($1::uuid[])', [events.map(e => e.event_id)])
        count += events.length
      }
      await client.query('COMMIT')
      return count
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { client.release() }
  }
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }
  private schedule(delay: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.running = this.runOnce()
      void this.running.catch(error => console.error('[team-delivery-projector] projection failed', { name: error instanceof Error ? error.name : 'unknown' }))
        .finally(() => { this.running = undefined; this.schedule(this.intervalMs) })
    }, delay)
    this.timer.unref?.()
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.running
  }
}
