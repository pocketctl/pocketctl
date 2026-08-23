import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { initDB } from '../db.js'
import { assertDurableIngressSchema } from '../event-worker-main.js'
import { initDurableIngressSchema } from '../schema/durable-ingress.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('durable ingress PostgreSQL schema', () => {
  let pool: pg.Pool

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl })
    const database = await pool.query<{ database_name: string }>(
      'SELECT current_database() AS database_name',
    )
    const databaseName = database.rows[0]?.database_name ?? ''
    if (!/test/i.test(databaseName)) {
      throw new Error(`Refusing PostgreSQL integration test against non-test database: ${databaseName || '<unknown>'}`)
    }
    await initDB(pool)
  }, 30_000)

  afterAll(async () => {
    await pool?.end()
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE realtime_outbox, event_inbox_receipt, event_inbox, daemon_ack_checkpoint RESTART IDENTITY CASCADE',
    )
    await pool.query(`DELETE FROM users WHERE email LIKE 'durable-schema-%@example.test'`)
    await pool.query(`DELETE FROM events WHERE session_id LIKE 'durable-schema-%'`)
  })

  test('creates inbox, receipt, checkpoint, and outbox constraints idempotently', async () => {
    await initDurableIngressSchema(pool)
    await initDurableIngressSchema(pool)

    const tables = await pool.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename IN (
          'event_inbox','event_inbox_receipt','daemon_ack_checkpoint',
          'realtime_outbox','request_push_effect'
        )
      ORDER BY tablename
    `)
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'daemon_ack_checkpoint',
      'event_inbox',
      'event_inbox_receipt',
      'realtime_outbox',
      'request_push_effect',
    ])

    const indexes = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN (
          'idx_event_inbox_dedup',
          'idx_event_inbox_pending_claim',
          'idx_event_inbox_receipt_daemon_seq',
          'idx_event_inbox_completed_cleanup',
          'idx_event_inbox_stream_unresolved',
          'idx_realtime_outbox_undelivered'
        )
      ORDER BY indexname
    `)
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'idx_event_inbox_completed_cleanup',
      'idx_event_inbox_dedup',
      'idx_event_inbox_pending_claim',
      'idx_event_inbox_receipt_daemon_seq',
      'idx_event_inbox_stream_unresolved',
      'idx_realtime_outbox_undelivered',
    ])
  })

  test('creates the unresolved-stream partial index with stream-head column order and predicate', async () => {
    await initDurableIngressSchema(pool)
    await initDurableIngressSchema(pool)

    const index = await pool.query<{
      indexdef: string;
      predicate: string;
      indisvalid: boolean;
      indisready: boolean;
    }>(`
      SELECT pg_get_indexdef(i.indexrelid) AS indexdef,
             pg_get_expr(i.indpred, i.indrelid) AS predicate,
             i.indisvalid,
             i.indisready
      FROM pg_index i
      WHERE i.indexrelid = 'idx_event_inbox_stream_unresolved'::regclass
    `)
    expect(index.rows).toHaveLength(1)
    expect(index.rows[0].indexdef).toContain(
      '(daemon_id, daemon_generation, seq, inbox_id)',
    )
    expect(index.rows[0].predicate).toBe('(status = ANY (ARRAY[0, 1]))')
    expect(index.rows[0].indisvalid).toBe(true)
    expect(index.rows[0].indisready).toBe(true)
  })

  test('standalone worker readiness fails closed while the unresolved-stream index is missing', async () => {
    await initDurableIngressSchema(pool)
    await assertDurableIngressSchema(pool)

    await pool.query('DROP INDEX idx_event_inbox_stream_unresolved')
    await expect(assertDurableIngressSchema(pool))
      .rejects.toThrow('durable ingress schema not ready')

    await initDurableIngressSchema(pool)
    await expect(assertDurableIngressSchema(pool)).resolves.toBeUndefined()
  })

  test('declares the required types, defaults, nullability, checks, keys, and foreign-key actions', async () => {
    const columns = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
    }>(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN (
          'event_inbox', 'event_inbox_receipt', 'daemon_ack_checkpoint',
          'realtime_outbox', 'request_push_effect'
        )
      ORDER BY table_name, ordinal_position
    `)
    const column = (tableName: string, columnName: string) => {
      const found = columns.rows.find((row) => row.table_name === tableName && row.column_name === columnName)
      expect(found, `${tableName}.${columnName}`).toBeDefined()
      return found!
    }

    expect(column('event_inbox', 'inbox_id')).toMatchObject({
      data_type: 'bigint', is_nullable: 'NO',
    })
    expect(column('event_inbox', 'inbox_id').column_default).toContain('nextval')
    expect(column('event_inbox', 'user_id')).toMatchObject({
      data_type: 'integer', is_nullable: 'YES', column_default: null,
    })
    expect(column('event_inbox', 'daemon_generation')).toMatchObject({
      data_type: 'bigint', is_nullable: 'NO',
    })
    expect(column('event_inbox', 'seq')).toMatchObject({ data_type: 'bigint', is_nullable: 'NO' })
    expect(column('event_inbox', 'priority_class')).toMatchObject({
      data_type: 'smallint', is_nullable: 'NO',
    })
    expect(column('event_inbox', 'schema_version')).toMatchObject({
      data_type: 'integer', is_nullable: 'NO', column_default: '1',
    })
    expect(column('event_inbox', 'received_at')).toMatchObject({
      data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()',
    })
    expect(column('event_inbox', 'payload')).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' })
    expect(column('event_inbox', 'status')).toMatchObject({
      data_type: 'smallint', is_nullable: 'NO', column_default: '0',
    })
    expect(column('event_inbox', 'attempts')).toMatchObject({
      data_type: 'integer', is_nullable: 'NO', column_default: '0',
    })
    expect(column('event_inbox', 'available_at')).toMatchObject({
      data_type: 'timestamp with time zone', is_nullable: 'NO', column_default: 'now()',
    })
    expect(column('event_inbox', 'materialized_event_id')).toMatchObject({
      data_type: 'bigint', is_nullable: 'YES',
    })
    expect(column('event_inbox_receipt', 'inbox_id')).toMatchObject({
      data_type: 'bigint', is_nullable: 'YES',
    })
    expect(column('event_inbox_receipt', 'daemon_generation')).toMatchObject({
      data_type: 'bigint', is_nullable: 'NO',
    })
    expect(column('daemon_ack_checkpoint', 'ack_seq')).toMatchObject({
      data_type: 'bigint', is_nullable: 'NO', column_default: '0',
    })
    expect(column('realtime_outbox', 'event_id')).toMatchObject({
      data_type: 'bigint', is_nullable: 'YES',
    })
    expect(column('realtime_outbox', 'user_id')).toMatchObject({
      data_type: 'integer', is_nullable: 'YES',
    })
    expect(column('realtime_outbox', 'payload')).toMatchObject({
      data_type: 'jsonb', is_nullable: 'NO',
    })
    expect(column('request_push_effect', 'user_id')).toMatchObject({
      data_type: 'integer', is_nullable: 'NO',
    })
    expect(column('request_push_effect', 'request_id')).toMatchObject({
      data_type: 'text', is_nullable: 'NO',
    })
    expect(column('request_push_effect', 'event_id')).toMatchObject({
      data_type: 'bigint', is_nullable: 'NO',
    })

    const constraints = await pool.query<{
      table_name: string;
      constraint_type: string;
      definition: string;
      referenced_table: string | null;
      delete_action: string;
    }>(`
      SELECT
        conrelid::regclass::text AS table_name,
        contype::text AS constraint_type,
        pg_get_constraintdef(oid) AS definition,
        CASE WHEN confrelid = 0 THEN NULL ELSE confrelid::regclass::text END AS referenced_table,
        confdeltype::text AS delete_action
      FROM pg_constraint
      WHERE conrelid IN (
        'event_inbox'::regclass,
        'event_inbox_receipt'::regclass,
        'daemon_ack_checkpoint'::regclass,
        'realtime_outbox'::regclass,
        'request_push_effect'::regclass
      )
    `)
    const hasConstraint = (
      tableName: string,
      type: string,
      definition: string,
      referencedTable?: string,
      deleteAction?: string,
    ) => constraints.rows.some((row) =>
      row.table_name === tableName
      && row.constraint_type === type
      && row.definition === definition
      && (referencedTable === undefined || row.referenced_table === referencedTable)
      && (deleteAction === undefined || row.delete_action === deleteAction))

    expect(hasConstraint('event_inbox', 'c', 'CHECK (((priority_class >= 0) AND (priority_class <= 3)))')).toBe(true)
    expect(hasConstraint('event_inbox', 'c', 'CHECK (((status >= 0) AND (status <= 3)))')).toBe(true)
    expect(hasConstraint(
      'event_inbox_receipt',
      'u',
      'UNIQUE (daemon_id, daemon_generation, seq)',
    )).toBe(true)
    expect(hasConstraint(
      'daemon_ack_checkpoint',
      'p',
      'PRIMARY KEY (daemon_id, daemon_generation)',
    )).toBe(true)
    expect(hasConstraint(
      'realtime_outbox',
      'u',
      'UNIQUE (inbox_id, delivery_key)',
    )).toBe(true)
    expect(hasConstraint(
      'request_push_effect',
      'p',
      'PRIMARY KEY (user_id, request_id)',
    )).toBe(true)
    expect(hasConstraint(
      'request_push_effect',
      'f',
      'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      'users',
      'c',
    )).toBe(true)
    expect(hasConstraint(
      'request_push_effect',
      'f',
      'FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE',
      'events',
      'c',
    )).toBe(true)
    expect(hasConstraint(
      'event_inbox',
      'f',
      'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      'users',
      'c',
    )).toBe(true)
    expect(hasConstraint(
      'event_inbox_receipt',
      'f',
      'FOREIGN KEY (inbox_id) REFERENCES event_inbox(inbox_id) ON DELETE CASCADE',
      'event_inbox',
      'c',
    )).toBe(true)
    expect(hasConstraint(
      'event_inbox',
      'f',
      'FOREIGN KEY (materialized_event_id) REFERENCES events(id)',
      'events',
      'a',
    )).toBe(true)
    expect(hasConstraint(
      'realtime_outbox',
      'f',
      'FOREIGN KEY (inbox_id) REFERENCES event_inbox(inbox_id) ON DELETE CASCADE',
      'event_inbox',
      'c',
    )).toBe(true)
    expect(hasConstraint(
      'realtime_outbox',
      'f',
      'FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE',
      'events',
      'c',
    )).toBe(true)
    expect(hasConstraint(
      'realtime_outbox',
      'f',
      'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      'users',
      'c',
    )).toBe(true)
  })

  test('migrates an existing realtime outbox event_id column to nullable idempotently', async () => {
    await pool.query(`ALTER TABLE realtime_outbox ALTER COLUMN event_id SET NOT NULL`)

    await initDurableIngressSchema(pool)
    await initDurableIngressSchema(pool)

    const eventId = await pool.query<{ is_nullable: 'YES' | 'NO' }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'realtime_outbox'
         AND column_name = 'event_id'`,
    )
    expect(eventId.rows).toEqual([{ is_nullable: 'YES' }])
  })

  test('accepts non-event outbox rows while retaining the event foreign-key boundary', async () => {
    const inbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       VALUES ('nullable-outbox', 1, 1, 'nullable-outbox', 'interaction_result', 0, '{}'::jsonb)
       RETURNING inbox_id`,
    )
    const nonEvent = await pool.query<{ event_id: string | null }>(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, event_type, audience, payload)
       VALUES ($1, 'inbox:1:user:-:0', NULL, 'interaction_result', 'user', '{}'::jsonb)
       RETURNING event_id`,
      [inbox.rows[0].inbox_id],
    )
    expect(nonEvent.rows).toEqual([{ event_id: null }])

    await expect(pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, event_type, audience, payload)
       VALUES ($1, 'event:invalid:user:-:0', 9223372036854775807, 'agent_event', 'user', '{}'::jsonb)`,
      [inbox.rows[0].inbox_id],
    )).rejects.toMatchObject({ code: '23503' })

    const event = await pool.query<{ id: string }>(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('durable-schema-valid-outbox-event', 'agent_event', '{}'::jsonb)
       RETURNING id`,
    )
    const businessEvent = await pool.query<{ event_id: string; referenced_id: string }>(
      `WITH inserted AS (
         INSERT INTO realtime_outbox
           (inbox_id, delivery_key, event_id, event_type, audience, payload)
         VALUES ($1, 'event:valid:user:-:0', $2, 'agent_event', 'user', '{}'::jsonb)
         RETURNING event_id
       )
       SELECT inserted.event_id, events.id AS referenced_id
       FROM inserted
       JOIN events ON events.id = inserted.event_id`,
      [inbox.rows[0].inbox_id, event.rows[0].id],
    )
    expect(businessEvent.rows).toEqual([{
      event_id: event.rows[0].id,
      referenced_id: event.rows[0].id,
    }])
  })

  test('enforces inbox defaults, nullability, and status ranges through writes', async () => {
    const defaults = await pool.query<{
      user_id: number | null;
      schema_version: number;
      status: number;
      attempts: number;
      received_at: Date;
      available_at: Date;
    }>(
      `INSERT INTO event_inbox
         (user_id, daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       VALUES (NULL, 'defaults', 1, 1, 'defaults', 'agent_event', 0, '{"raw":true}'::jsonb)
       RETURNING user_id, schema_version, status, attempts, received_at, available_at`,
    )
    expect(defaults.rows[0]).toMatchObject({
      user_id: null,
      schema_version: 1,
      status: 0,
      attempts: 0,
    })
    expect(defaults.rows[0].received_at).toBeInstanceOf(Date)
    expect(defaults.rows[0].available_at).toBeInstanceOf(Date)

    await expect(pool.query(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       VALUES ('invalid-priority', 1, 1, 'invalid-priority', 'agent_event', 4, '{}'::jsonb)`,
    )).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, status, payload)
       VALUES ('invalid-status', 1, 1, 'invalid-status', 'agent_event', 0, -1, '{}'::jsonb)`,
    )).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       VALUES ('null-payload', 1, 1, 'null-payload', 'agent_event', 0, NULL)`,
    )).rejects.toMatchObject({ code: '23502' })
  })

  test('enforces receipt, checkpoint, and outbox uniqueness through writes', async () => {
    const inbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       VALUES
         ('unique', 1, 1, 'unique-1', 'agent_event', 0, '{}'::jsonb),
         ('unique', 1, 2, 'unique-2', 'agent_event', 0, '{}'::jsonb)
       RETURNING inbox_id`,
    )
    await pool.query(
      `INSERT INTO event_inbox_receipt (inbox_id, daemon_id, daemon_generation, seq)
       VALUES ($1, 'unique', 1, 1)`,
      [inbox.rows[0].inbox_id],
    )
    await expect(pool.query(
      `INSERT INTO event_inbox_receipt (inbox_id, daemon_id, daemon_generation, seq)
       VALUES ($1, 'unique', 1, 1)`,
      [inbox.rows[1].inbox_id],
    )).rejects.toMatchObject({ code: '23505' })

    await pool.query(
      `INSERT INTO daemon_ack_checkpoint (daemon_id, daemon_generation, ack_seq)
       VALUES ('unique', 1, 0)`,
    )
    await expect(pool.query(
      `INSERT INTO daemon_ack_checkpoint (daemon_id, daemon_generation, ack_seq)
       VALUES ('unique', 1, 99)`,
    )).rejects.toMatchObject({ code: '23505' })

    const events = await pool.query<{ id: string }>(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES
         ('durable-schema-unique-1', 'agent_event', '{}'::jsonb),
         ('durable-schema-unique-2', 'agent_event', '{}'::jsonb)
       RETURNING id`,
    )
    await pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, event_type, audience, payload)
       VALUES ($1, 'same-delivery', $2, 'agent_event', 'user', '{}'::jsonb)`,
      [inbox.rows[0].inbox_id, events.rows[0].id],
    )
    await expect(pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, event_type, audience, payload)
       VALUES ($1, 'same-delivery', $2, 'agent_event', 'user', '{}'::jsonb)`,
      [inbox.rows[0].inbox_id, events.rows[1].id],
    )).rejects.toMatchObject({ code: '23505' })
  })

  test('enforces foreign keys and cascades user, inbox, receipt, and outbox deletes', async () => {
    await expect(pool.query(
      `INSERT INTO event_inbox_receipt (inbox_id, daemon_id, daemon_generation, seq)
       VALUES (9223372036854775807, 'missing-inbox', 1, 1)`,
    )).rejects.toMatchObject({ code: '23503' })

    const user = await pool.query<{ id: number }>(
      `INSERT INTO users (id, email, password_hash)
       SELECT COALESCE(MAX(id), 0) + 1, 'durable-schema-cascade@example.test', 'hash'
       FROM users
       RETURNING id`,
    )
    const materialized = await pool.query<{ id: string }>(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('durable-schema-cascade', 'agent_event', '{}'::jsonb)
       RETURNING id`,
    )
    const inbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (user_id, daemon_id, daemon_generation, seq, dedup_key, event_type,
          priority_class, payload, materialized_event_id)
       VALUES ($1, 'cascade', 1, 1, 'cascade', 'agent_event', 0, '{}'::jsonb, $2)
       RETURNING inbox_id`,
      [user.rows[0].id, materialized.rows[0].id],
    )
    await pool.query(
      `INSERT INTO event_inbox_receipt (inbox_id, daemon_id, daemon_generation, seq)
       VALUES ($1, 'cascade', 1, 1)`,
      [inbox.rows[0].inbox_id],
    )
    await pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, user_id, event_type, audience, payload)
       VALUES ($1, 'cascade', $2, $3, 'agent_event', 'user', '{}'::jsonb)`,
      [inbox.rows[0].inbox_id, materialized.rows[0].id, user.rows[0].id],
    )

    await expect(pool.query(
      `DELETE FROM events WHERE id = $1`,
      [materialized.rows[0].id],
    )).rejects.toMatchObject({ code: '23503' })

    await pool.query(`DELETE FROM users WHERE id = $1`, [user.rows[0].id])
    const cascadeCounts = await pool.query<{
      inbox: number;
      receipts: number;
      outbox: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox WHERE inbox_id = $1) AS inbox,
        (SELECT COUNT(*)::int FROM event_inbox_receipt WHERE inbox_id = $1) AS receipts,
        (SELECT COUNT(*)::int FROM realtime_outbox WHERE inbox_id = $1) AS outbox
    `, [inbox.rows[0].inbox_id])
    expect(cascadeCounts.rows[0]).toEqual({ inbox: 0, receipts: 0, outbox: 0 })

    const outboxEvent = await pool.query<{ id: string }>(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('durable-schema-event-cascade', 'agent_event', '{}'::jsonb)
       RETURNING id`,
    )
    const selfHostedInbox = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       VALUES ('event-cascade', 1, 1, 'event-cascade', 'agent_event', 0, '{}'::jsonb)
       RETURNING inbox_id`,
    )
    await pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, event_type, audience, payload)
       VALUES ($1, 'event-cascade', $2, 'agent_event', 'user', '{}'::jsonb)`,
      [selfHostedInbox.rows[0].inbox_id, outboxEvent.rows[0].id],
    )
    await pool.query(`DELETE FROM events WHERE id = $1`, [outboxEvent.rows[0].id])
    const eventCascade = await pool.query<{ inbox: number; outbox: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox WHERE inbox_id = $1) AS inbox,
        (SELECT COUNT(*)::int FROM realtime_outbox WHERE inbox_id = $1) AS outbox
    `, [selfHostedInbox.rows[0].inbox_id])
    expect(eventCascade.rows[0]).toEqual({ inbox: 1, outbox: 0 })

    const outboxUser = await pool.query<{ id: number }>(
      `INSERT INTO users (id, email, password_hash)
       SELECT COALESCE(MAX(id), 0) + 1, 'durable-schema-outbox-user@example.test', 'hash'
       FROM users
       RETURNING id`,
    )
    const directDeleteEvent = await pool.query<{ id: string }>(
      `INSERT INTO events (session_id, event_type, payload)
       VALUES ('durable-schema-direct-inbox-delete', 'agent_event', '{}'::jsonb)
       RETURNING id`,
    )
    await pool.query(
      `INSERT INTO event_inbox_receipt (inbox_id, daemon_id, daemon_generation, seq)
       VALUES ($1, 'direct-inbox-delete', 1, 1)`,
      [selfHostedInbox.rows[0].inbox_id],
    )
    await pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, user_id, event_type, audience, payload)
       VALUES ($1, 'user-cascade', $2, $3, 'agent_event', 'user', '{}'::jsonb)`,
      [selfHostedInbox.rows[0].inbox_id, directDeleteEvent.rows[0].id, outboxUser.rows[0].id],
    )
    await pool.query(`DELETE FROM users WHERE id = $1`, [outboxUser.rows[0].id])
    const userOutboxCascade = await pool.query<{ inbox: number; outbox: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox WHERE inbox_id = $1) AS inbox,
        (SELECT COUNT(*)::int FROM realtime_outbox WHERE inbox_id = $1) AS outbox
    `, [selfHostedInbox.rows[0].inbox_id])
    expect(userOutboxCascade.rows[0]).toEqual({ inbox: 1, outbox: 0 })

    await pool.query(
      `INSERT INTO realtime_outbox
         (inbox_id, delivery_key, event_id, event_type, audience, payload)
       VALUES ($1, 'inbox-cascade', $2, 'agent_event', 'user', '{}'::jsonb)`,
      [selfHostedInbox.rows[0].inbox_id, directDeleteEvent.rows[0].id],
    )
    await pool.query(`DELETE FROM event_inbox WHERE inbox_id = $1`, [selfHostedInbox.rows[0].inbox_id])
    const inboxCascade = await pool.query<{ receipts: number; outbox: number; events: number }>(`
      SELECT
        (SELECT COUNT(*)::int FROM event_inbox_receipt WHERE inbox_id = $1) AS receipts,
        (SELECT COUNT(*)::int FROM realtime_outbox WHERE inbox_id = $1) AS outbox,
        (SELECT COUNT(*)::int FROM events WHERE id = $2) AS events
    `, [selfHostedInbox.rows[0].inbox_id, directDeleteEvent.rows[0].id])
    expect(inboxCascade.rows[0]).toEqual({ receipts: 0, outbox: 0, events: 1 })
  })

  test('deduplicates self-hosted canonical rows while retaining independent transport receipts', async () => {
    const canonical = await pool.query<{ inbox_id: string }>(
      `INSERT INTO event_inbox
         (user_id, daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       VALUES (NULL, 'self-hosted', 1, 1, 'stable-event', 'agent_event', 1, $1)
       RETURNING inbox_id`,
      [{ agent: 'opencode', untouched: { field: true } }],
    )

    await expect(pool.query(
      `INSERT INTO event_inbox
         (user_id, daemon_id, daemon_generation, seq, dedup_key, event_type, priority_class, payload)
       VALUES (NULL, 'self-hosted', 2, 8, 'stable-event', 'agent_event', 1, '{}'::jsonb)`,
    )).rejects.toMatchObject({ code: '23505' })

    await pool.query(
      `INSERT INTO event_inbox_receipt (inbox_id, daemon_id, daemon_generation, seq)
       VALUES ($1, 'self-hosted', 1, 1), ($1, 'self-hosted', 2, 8)`,
      [canonical.rows[0].inbox_id],
    )
    const receiptCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM event_inbox_receipt WHERE inbox_id = $1`,
      [canonical.rows[0].inbox_id],
    )
    expect(receiptCount.rows[0].count).toBe(2)
  })
})
