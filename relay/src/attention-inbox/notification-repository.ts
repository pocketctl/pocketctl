import { maintenanceSlot } from '../session-lifecycle/schedule.js'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'
import type {
  LifecycleAction,
  LifecycleJobState,
} from '../session-lifecycle/types.js'
import type {
  NotificationSubject,
  SystemNotification,
} from './notification-dto.js'

type Queryable = Pick<pg.Pool, 'query'>
interface ResultInput {
  operationId: string
  notificationId: string
  userId: number
  sessionId: string
  daemonId: string
  titleSnapshot: string
  daemonNameSnapshot: string
  action: LifecycleAction
  state: Exclude<LifecycleJobState, 'queued'>
  activityAt: string
  reasonCode: string
  retentionDays: number
  effectivePurgeAt?: string | null
  stages?: Record<string, 'pending' | 'succeeded' | 'failed' | 'not_applicable'>
}
interface ListInput {
  userId: number
  daemonId?: string | null
  limit: number
  cursor?: string | null
  read?: boolean
}
interface SubjectsInput extends ListInput {
  notificationId: string
}
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
// Current daemon ownership and live-session ownership are checked on EVERY
// read, including cursor pages. Deleted sessions authorize through the original
// user/daemon subject ledger, rather than requiring the removed session row.
const visibility = `s.user_id=$1 AND ($2::text IS NULL OR s.daemon_id=$2)
  AND EXISTS(SELECT 1 FROM daemons d WHERE d.daemon_id=s.daemon_id AND d.user_id=$1)
  AND NOT EXISTS(SELECT 1 FROM sessions live WHERE live.session_id=s.session_id
    AND (live.user_id IS DISTINCT FROM $1 OR live.daemon_id IS DISTINCT FROM s.daemon_id))`
const noticeVisibility = `(EXISTS(SELECT 1 FROM attention_notification_subjects s
  WHERE s.notification_id=n.notification_id AND ${visibility}) OR ($2::text IS NULL AND n.maintenance_summary IS NOT NULL
  AND EXISTS(SELECT 1 FROM maintenance_provider_results mr JOIN extension_installations mi USING(installation_id)
    WHERE mi.owner_user_id=$1 AND mi.owner_type='user' AND mi.status IN('active','paused')
      AND (mr.scheduled_at AT TIME ZONE 'Asia/Shanghai')::date=n.maintenance_day)))`
const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString()
function subject(row: any): NotificationSubject {
  return {
    id: row.subject_id,
    sessionId: row.session_id,
    daemonId: row.daemon_id,
    title: row.title_snapshot || '未命名会话',
    daemonName: row.daemon_name_snapshot || '主机',
    action: row.action,
    state: row.state,
    activityAt: iso(row.activity_at)!,
    executedAt: iso(row.executed_at),
    effectivePurgeAt: iso(row.effective_purge_at),
    reasonCode: row.reason_code,
    stages:row.stages??{},
    navigation: row.accessible
      ? { type: 'session', id: row.session_id }
      : { type: 'lifecycle_detail', id: row.subject_id },
  }
}
function limit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new Error('invalid notification page limit')
}

export class AttentionNotificationRepository {
  constructor(
    private readonly pool: Pick<pg.Pool, 'query' | 'connect'>,
    private readonly cursorSecret: string,
  ) {
    if (!cursorSecret) throw new Error('notification cursor secret required')
  }
  private cursor(data: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url')
    return `${payload}.${createHmac('sha256', this.cursorSecret).update(payload).digest('base64url')}`
  }
  private parse(
    raw: string | null | undefined,
    scope: Record<string, unknown>,
  ): Record<string, any> | null {
    if (!raw) return null
    if (raw.length > 2048) throw new Error('invalid notification cursor')
    try {
      const [payload, signature, extra] = raw.split('.')
      const expected = createHmac('sha256', this.cursorSecret)
        .update(payload)
        .digest()
      const actual = Buffer.from(signature, 'base64url')
      if (
        extra ||
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error()
      const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      )
      for (const [key, value] of Object.entries(scope))
        if (decoded[key] !== value) throw new Error()
      if (!UUID.test(decoded.id)) throw new Error()
      return decoded
    } catch {
      throw new Error('invalid notification cursor')
    }
  }
  private async notify(
    db: Queryable,
    userId: number,
    id: string,
    revision: number,
    operation: 'changed' | 'removed',
  ) {
    await db.query(
      `INSERT INTO notification_delivery_outbox(user_id,notification_id,revision,operation)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [userId, id, revision, operation],
    )
    await db.query(
      `SELECT pg_notify('pocketctl_attention',json_build_object('entity','notification',
      'user_id',$1::int,'item_id',$2::text,'revision',$3::bigint,'operation',$4::text)::text)`,
      [userId, id, revision, operation],
    )
  }
  async recordResultInTransaction(
    db: pg.PoolClient,
    input: ResultInput,
  ): Promise<{ notificationId: string; revision: number }> {
    // Explicit transaction ownership is the caller's responsibility, as for
    // other *InTransaction methods. The parameter excludes an unrelated Pool.
    if (
      !Number.isInteger(input.retentionDays) ||
      input.retentionDays < 1 ||
      input.retentionDays > 365 ||
      !/^[a-z0-9_]{1,64}$/.test(input.reasonCode)
    )
      throw new Error('invalid lifecycle result metadata')
    const canonicalStages = (value: Record<string, unknown>) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
    const stages = canonicalStages(input.stages ?? {})
    if (stages.length > 4096)
      throw new Error('lifecycle stage metadata too large')
    const bound = await db.query(
      `SELECT j.operation_id,j.maintenance_scheduled_at FROM session_lifecycle_jobs j
      WHERE operation_id=$1 AND user_id=$2 AND session_id=$3 AND action=$4
        AND EXISTS(SELECT 1 FROM daemons WHERE daemon_id=$5 AND user_id=$2)
        AND NOT EXISTS(SELECT 1 FROM sessions live WHERE live.session_id=$3
          AND (live.user_id IS DISTINCT FROM $2 OR live.daemon_id IS DISTINCT FROM $5)) FOR UPDATE`,
      [
        input.operationId,
        input.userId,
        input.sessionId,
        input.action,
        input.daemonId,
      ],
    )
    if (!bound.rows[0]) throw new Error('lifecycle result ownership mismatch')
    const scheduledAt=bound.rows[0].maintenance_scheduled_at
    const dayAt=scheduledAt??maintenanceSlot('archive',new Date())
    const previous = (
      await db.query(
        `SELECT r.notification_id,r.state,r.reason_code,r.stages,
      COALESCE(n.revision,r.notification_revision) AS revision,
      (n.notification_id IS NULL OR n.expires_at<=NOW()) AS expired
      FROM session_lifecycle_results r LEFT JOIN attention_notifications n ON n.notification_id=r.notification_id
      WHERE r.operation_id=$1`,
        [input.operationId],
      )
    ).rows[0]
    if (
      previous &&
      previous.state === input.state &&
      previous.reason_code === input.reasonCode &&
      canonicalStages(previous.stages) === stages
    )
      return {
        notificationId: previous.notification_id,
        revision: Number(previous.revision),
      }
    if (previous?.expired && previous.notification_id)
      throw new Error('lifecycle notification expired')
    let id = previous?.notification_id ?? input.notificationId
    let dailyCreated = false
    // One cross-host, cross-action maintenance message per user/Shanghai day.
    // Compensation always updates the original operation's message.
    if (!previous && input.action !== 'resume') {
      const daily = (await db.query(`INSERT INTO attention_notifications(notification_id,user_id,expires_at,maintenance_day,completed_at,published_at)
        VALUES($1,$2,NOW()+($3::int*interval '1 day'),($5::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,CASE WHEN $4='running' THEN NULL ELSE NOW() END,CASE WHEN $6 THEN NULL ELSE NOW() END)
        ON CONFLICT(user_id,maintenance_day) WHERE maintenance_day IS NOT NULL
        DO UPDATE SET maintenance_day=EXCLUDED.maintenance_day RETURNING notification_id,(xmax=0) AS newly_created`,
        [id,input.userId,input.retentionDays,input.state,dayAt,Boolean(scheduledAt)])).rows[0]
      id = daily.notification_id
      dailyCreated = daily.newly_created
    }
    const title = input.titleSnapshot.trim().slice(0, 512) || '未命名会话'
    const daemonName = input.daemonNameSnapshot.trim().slice(0, 255) || '主机'
    await db.query(
      `INSERT INTO session_lifecycle_results(operation_id,user_id,session_id,daemon_id,
      title_snapshot,daemon_name_snapshot,action,state,activity_at,executed_at,effective_purge_at,reason_code,stages)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $8='running' THEN NULL ELSE NOW() END,$10,$11,$12::jsonb)
      ON CONFLICT(operation_id) DO UPDATE SET state=EXCLUDED.state,reason_code=EXCLUDED.reason_code,
        executed_at=EXCLUDED.executed_at,stages=EXCLUDED.stages,revision=session_lifecycle_results.revision+1,updated_at=NOW()`,
      [
        input.operationId,
        input.userId,
        input.sessionId,
        input.daemonId,
        title,
        daemonName,
        input.action,
        input.state,
        input.activityAt,
        input.effectivePurgeAt ?? null,
        input.reasonCode,
        stages,
      ],
    )
    const inserted = await db.query(
      `INSERT INTO attention_notifications(notification_id,user_id,expires_at,completed_at)
      VALUES($1,$2,NOW()+($3::int*interval '1 day'),CASE WHEN $4='running' THEN NULL ELSE NOW() END)
      ON CONFLICT DO NOTHING RETURNING notification_id`,
      [id, input.userId, input.retentionDays, input.state],
    )
    const notification = (
      await db.query(
        `SELECT revision,published_at FROM attention_notifications
      WHERE notification_id=$1 AND user_id=$2 FOR UPDATE`,
        [id, input.userId],
      )
    ).rows[0]
    if (!notification) throw new Error('notification ownership mismatch')
    await db.query(
      `INSERT INTO attention_notification_subjects(subject_id,notification_id,user_id,operation_id,
      session_id,daemon_id,title_snapshot,daemon_name_snapshot,action,state,activity_at,executed_at,effective_purge_at,reason_code)
      SELECT $1,$2,user_id,operation_id,session_id,daemon_id,title_snapshot,daemon_name_snapshot,action,state,
        activity_at,executed_at,effective_purge_at,reason_code FROM session_lifecycle_results WHERE operation_id=$3
      ON CONFLICT(operation_id) DO UPDATE SET state=EXCLUDED.state,executed_at=EXCLUDED.executed_at,
        effective_purge_at=EXCLUDED.effective_purge_at,reason_code=EXCLUDED.reason_code`,
      [randomUUID(), id, input.operationId],
    )
    let revision = Number(notification.revision)
    if (!inserted.rows[0] && !dailyCreated) {
      revision = Number(
        (
          await db.query(
            `UPDATE attention_notifications SET revision=revision+1,
        completed_at=CASE WHEN $3='running' THEN NULL ELSE NOW() END,
        expires_at=NOW()+($4::int*interval '1 day'),updated_at=NOW()
        WHERE notification_id=$1 AND user_id=$2 RETURNING revision`,
            [id, input.userId, input.state, input.retentionDays],
          )
        ).rows[0].revision,
      )
    }
    if(notification.published_at&&!scheduledAt) await this.notify(db, input.userId, id, revision, 'changed')
    await db.query(
      `UPDATE session_lifecycle_results SET notification_id=$2,notification_revision=$3
      WHERE operation_id=$1`,
      [input.operationId, id, revision],
    )
    return { notificationId: id, revision }
  }

  async list(input: ListInput): Promise<{
    notifications: SystemNotification[]
    unread: number
    nextCursor: string | null
  }> {
    limit(input.limit)
    const scope = {
      type: 'list',
      userId: input.userId,
      daemonId: input.daemonId ?? null,
      read: input.read ?? null,
    }
    const cursor = this.parse(input.cursor, scope)
    const params = [input.userId, input.daemonId ?? null, input.read ?? null]
    const predicate = `n.user_id=$1 AND n.expires_at>NOW() AND n.published_at IS NOT NULL
      AND ($3::boolean IS NULL OR (n.read_at IS NOT NULL)=$3)
      AND ${noticeVisibility}`
    const rows = await this.pool.query(
      `SELECT n.*,
      to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
      FROM attention_notifications n WHERE ${predicate}
      AND ($4::timestamptz IS NULL OR (n.created_at,n.notification_id)<($4::timestamptz,$5::uuid))
      ORDER BY n.created_at DESC,n.notification_id DESC LIMIT $6`,
      [...params, cursor?.time ?? null, cursor?.id ?? null, input.limit + 1],
    )
    const counts = await this.pool.query(
      `SELECT count(*)::int AS unread FROM attention_notifications n
      WHERE n.user_id=$1 AND n.expires_at>NOW() AND n.published_at IS NOT NULL AND n.read_at IS NULL
        AND ${noticeVisibility}`,
      params.slice(0, 2),
    )
    const page = rows.rows.slice(0, input.limit)
    const notifications: SystemNotification[] = []
    for (const row of page) {
      const current = await this.get(
        input.userId,
        row.notification_id,
        input.daemonId,
      )
      if (current) notifications.push(current)
    }
    const last = page.at(-1)
    return {
      notifications,
      unread: counts.rows[0].unread,
      nextCursor:
        rows.rows.length > input.limit && last
          ? this.cursor({
              ...scope,
              time: last.cursor_time,
              id: last.notification_id,
            })
          : null,
    }
  }
  async get(
    userId: number,
    id: string,
    daemonId?: string | null,
  ): Promise<SystemNotification | null> {
    const row = (
      await this.pool.query(
        `SELECT n.* FROM attention_notifications n
      WHERE n.notification_id=$3 AND n.user_id=$1 AND n.expires_at>NOW() AND n.published_at IS NOT NULL
      AND ${noticeVisibility}`,
        [userId, daemonId ?? null, id],
      )
    ).rows[0]
    if (!row) return null
    const page = await this.subjects({
      userId,
      notificationId: id,
      daemonId,
      limit: 3,
    })
    if ((!page || page.total === 0) && !row.maintenance_summary) return null
    let maintenance=row.maintenance_summary
    if(maintenance){
      // Re-authorize summary counters on every read, just like subjects. A
      // previous snapshot must not expose counters after host/owner transfer.
      const counts:Record<string,number>={}
      if(!daemonId){
        const reports=await this.pool.query(`SELECT mr.counts FROM maintenance_provider_results mr
          JOIN extension_installations mi USING(installation_id) WHERE mi.owner_user_id=$1 AND mi.owner_type='user'
          AND mi.status IN('active','paused') AND (mr.scheduled_at AT TIME ZONE 'Asia/Shanghai')::date=$2`,[userId,row.maintenance_day])
        for(const report of reports.rows)for(const [key,n] of Object.entries(report.counts))counts[key]=(counts[key]??0)+Number(n)
      }
      const actions=await this.pool.query(`SELECT s.action,count(*)::int n FROM attention_notification_subjects s
        WHERE s.notification_id=$3 AND ${visibility} GROUP BY s.action`,[userId,daemonId??null,id])
      for(const action of actions.rows)counts['session_'+action.action]=action.n
      maintenance={...maintenance,counts}
    }
    return {
      id,
      revision: Number(row.revision),
      kind: 'system',
      topic: 'session_lifecycle',
      createdAt: iso(row.created_at)!,
      readAt: iso(row.read_at),
      expiresAt: iso(row.expires_at)!,
      subjectCount: page?.total??0,
      subjects: page?.subjects??[],
      subjectsNextCursor: page?.nextCursor??null,
      maintenance: !daemonId?maintenance??undefined:undefined,
      requiresApproval: false,
    }
  }
  async subjects(input: SubjectsInput): Promise<{
    subjects: NotificationSubject[]
    total: number
    nextCursor: string | null
  } | null> {
    limit(input.limit)
    const scope = {
      type: 'subjects',
      userId: input.userId,
      daemonId: input.daemonId ?? null,
      notificationId: input.notificationId,
    }
    const cursor = this.parse(input.cursor, scope)
    const params = [input.userId, input.daemonId ?? null, input.notificationId]
    const predicate = `n.user_id=$1 AND n.notification_id=$3 AND n.expires_at>NOW() AND n.published_at IS NOT NULL AND ${visibility}`
    const rows = await this.pool.query(
      `SELECT s.*,(SELECT r.stages FROM session_lifecycle_results r WHERE r.operation_id=s.operation_id) AS stages, EXISTS(SELECT 1 FROM sessions live
      WHERE live.session_id=s.session_id AND live.user_id=$1 AND live.daemon_id=s.daemon_id
        AND live.content_state NOT IN ('deleting','deleted')) AS accessible
      FROM attention_notification_subjects s JOIN attention_notifications n USING(notification_id)
      WHERE ${predicate} AND ($4::uuid IS NULL OR s.subject_id>$4::uuid)
      ORDER BY s.subject_id LIMIT $5`,
      [...params, cursor?.id ?? null, input.limit + 1],
    )
    const count = await this.pool.query(
      `SELECT count(*)::int AS total FROM attention_notification_subjects s
      JOIN attention_notifications n USING(notification_id) WHERE ${predicate}`,
      params,
    )
    if (count.rows[0].total === 0) {
      const visible=await this.pool.query(`SELECT 1 FROM attention_notifications n WHERE n.user_id=$1 AND n.notification_id=$3
        AND n.expires_at>NOW() AND n.published_at IS NOT NULL AND ${noticeVisibility}`,params)
      if(!visible.rowCount)return null
    }
    const page = rows.rows.slice(0, input.limit)
    return {
      subjects: page.map(subject),
      total: count.rows[0].total,
      nextCursor:
        rows.rows.length > input.limit
          ? this.cursor({ ...scope, id: page.at(-1)!.subject_id })
          : null,
    }
  }
  async getSubject(
    userId: number,
    notificationId: string,
    subjectId: string,
    daemonId?: string | null,
  ): Promise<NotificationSubject | null> {
    const row = (
      await this.pool.query(
        `SELECT s.*,(SELECT r.stages FROM session_lifecycle_results r WHERE r.operation_id=s.operation_id) AS stages, EXISTS(SELECT 1 FROM sessions live
      WHERE live.session_id=s.session_id AND live.user_id=$1 AND live.daemon_id=s.daemon_id
        AND live.content_state NOT IN ('deleting','deleted')) AS accessible
      FROM attention_notification_subjects s JOIN attention_notifications n USING(notification_id)
      WHERE n.user_id=$1 AND n.notification_id=$3 AND n.expires_at>NOW() AND n.published_at IS NOT NULL AND s.subject_id=$4 AND ${visibility}`,
        [userId, daemonId ?? null, notificationId, subjectId],
      )
    ).rows[0]
    return row ? subject(row) : null
  }
  async markRead(
    userId: number,
    id: string,
    expectedRevision: number,
    daemonId?: string | null,
  ): Promise<'read' | 'not_found' | 'stale_revision'> {
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      const row = (
        await db.query(
          `SELECT n.revision,n.read_at FROM attention_notifications n
        WHERE n.user_id=$1 AND n.notification_id=$3 AND n.expires_at>NOW() AND n.published_at IS NOT NULL
        AND ${noticeVisibility}
        FOR UPDATE`,
          [userId, daemonId ?? null, id],
        )
      ).rows[0]
      let outcome: 'read' | 'not_found' | 'stale_revision' = 'not_found'
      if (row) {
        if (row.read_at) outcome = 'read'
        else if (Number(row.revision) !== expectedRevision)
          outcome = 'stale_revision'
        else {
          const updated = (
            await db.query(
              `UPDATE attention_notifications SET read_at=NOW(),revision=revision+1,updated_at=NOW()
            WHERE notification_id=$1 RETURNING revision`,
              [id],
            )
          ).rows[0]
          await this.notify(db, userId, id, Number(updated.revision), 'changed')
          outcome = 'read'
        }
      }
      await db.query('COMMIT')
      return outcome
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }
  async expire(batch: number): Promise<number> {
    limit(batch)
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      const expired = await db.query(
        `SELECT notification_id,user_id,revision FROM attention_notifications
        WHERE expires_at<=NOW() ORDER BY expires_at,notification_id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [batch],
      )
      for (const row of expired.rows) {
        await this.notify(
          db,
          row.user_id,
          row.notification_id,
          Number(row.revision) + 1,
          'removed',
        )
        await db.query(
          `UPDATE session_lifecycle_results SET title_snapshot='',daemon_name_snapshot=''
          WHERE operation_id IN(SELECT operation_id FROM attention_notification_subjects WHERE notification_id=$1)`,
          [row.notification_id],
        )
        await db.query(
          'DELETE FROM attention_notifications WHERE notification_id=$1',
          [row.notification_id],
        )
      }
      await db.query('COMMIT')
      return expired.rows.length
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }

  /** Re-emits committed compact deltas across every listening Relay instance. */
  async deliverPending(batch: number): Promise<number> {
    limit(batch)
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      const rows = await db.query(
        `SELECT * FROM notification_delivery_outbox WHERE delivered_at IS NULL
        ORDER BY delivery_id FOR UPDATE SKIP LOCKED LIMIT $1`,
        [batch],
      )
      for (const row of rows.rows) {
        await db.query(
          `SELECT pg_notify('pocketctl_attention',json_build_object('entity','notification',
          'user_id',$1::int,'item_id',$2::text,'revision',$3::bigint,'operation',$4::text)::text)`,
          [
            row.user_id,
            row.notification_id,
            Number(row.revision),
            row.operation,
          ],
        )
        await db.query(
          'UPDATE notification_delivery_outbox SET delivered_at=NOW() WHERE delivery_id=$1',
          [row.delivery_id],
        )
      }
      // Bounded diagnostic retention; delivered deltas contain IDs only.
      await db.query(
        `DELETE FROM notification_delivery_outbox WHERE delivery_id IN (
        SELECT delivery_id FROM notification_delivery_outbox WHERE delivered_at<NOW()-interval '7 days'
        ORDER BY delivery_id LIMIT $1)`,
        [batch],
      )
      await db.query('COMMIT')
      return rows.rows.length
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }
}
