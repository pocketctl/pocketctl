import type pg from 'pg'
import { teamEventView } from './event-repository.js'
import type { TeamEvent } from './types.js'

// Each Relay owns a durable cursor. Consumers never compete for a global
// delivered bit. Sending before committing the cursor intentionally permits
// duplicate frames after a crash; event_id is the client deduplication key.
export class TeamEventFanout {
  private timer?: ReturnType<typeof setTimeout>
  private stopped = true
  private inFlight?: Promise<number>
  constructor(private readonly pool: pg.Pool, readonly nodeId: string,
    private readonly deliver: (sessionId: string, participants: number[], event: TeamEvent) => Promise<void>,
    private readonly revalidate?: () => Promise<void>, private readonly intervalMs = 250) {}
  start() { if (!this.stopped) return;this.stopped=false;this.schedule(0) }
  async stop() {this.stopped=true;if(this.timer) clearTimeout(this.timer);this.timer=undefined;await this.inFlight}
  private schedule(delay: number) {
    if(this.stopped) return
    this.timer=setTimeout(()=>{
      this.timer=undefined
      this.inFlight=this.pollOnce()
      void this.inFlight.catch(e=>console.error('[team-fanout] delivery deferred',{code:e?.code ?? 'delivery_failed'}))
        .finally(()=>{this.inFlight=undefined;this.schedule(this.intervalMs)})
    },delay)
    this.timer.unref?.()
  }
  async pollOnce(limit = 100): Promise<number> {
    const client=await this.pool.connect()
    let released=false
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO team_event_cursors(node_id) VALUES($1) ON CONFLICT DO NOTHING`,[this.nodeId])
      const cursor=(await client.query(`SELECT journal_seq FROM team_event_cursors WHERE node_id=$1 FOR UPDATE`,[this.nodeId])).rows[0]
      const rows=(await client.query(`SELECT j.journal_seq,e.* FROM team_event_journal j
        JOIN collaboration_events e ON e.event_id=j.event_id WHERE j.journal_seq>$1 ORDER BY j.journal_seq LIMIT $2`,[cursor.journal_seq,Math.max(1,Math.min(500,limit))])).rows
      for (const row of rows) {
        const participants=(await client.query(`SELECT p.user_id FROM collaboration_session_participants p
          JOIN collaboration_sessions s ON s.team_session_id=p.team_session_id
          JOIN collaboration_team_memberships m ON m.team_id=s.team_id AND m.user_id=p.user_id AND m.state='active'
          WHERE p.team_session_id=$1 AND p.state='active'`,[row.team_session_id])).rows.map(r=>Number(r.user_id))
        await this.deliver(row.team_session_id,participants,teamEventView(row))
      }
      if(rows.length) await client.query(`UPDATE team_event_cursors SET journal_seq=$2,updated_at=NOW() WHERE node_id=$1`,[this.nodeId,rows[rows.length-1].journal_seq])
      await client.query('COMMIT')
      client.release();released=true
      // Also catches permission changes that did not create a shared event.
      await this.revalidate?.()
      return rows.length
    } catch(e) {if(!released)await client.query('ROLLBACK');throw e} finally {if(!released)client.release()}
  }
}
