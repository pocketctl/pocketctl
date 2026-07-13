import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  claimWelcomeEmails,
  createUserWithWelcomeEmail,
  getUserByEmail,
  initDB,
  markWelcomeEmailSent,
} from '../db.js'
import { createWelcomeEmailWorker } from '../welcome-email-worker.js'
import type { SupportedLanguage } from '../config/language.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const integrationEnabled = Boolean(databaseUrl && process.env.RUN_POSTGRES_INTEGRATION === '1')
const describeWithDatabase = integrationEnabled ? describe : describe.skip

describeWithDatabase('welcome email PostgreSQL integration', () => {
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
    await pool.query('TRUNCATE email_outbox, users RESTART IDENTITY CASCADE')
  })

  test('persists one localized intent, retries failures, and fences stale workers', async () => {
    const sent: Array<{ recipient: string; locale: SupportedLanguage }> = []
    let failingRecipient: string | undefined
    const send = async (recipient: string, locale: SupportedLanguage): Promise<string> => {
      sent.push({ recipient, locale })
      if (recipient === failingRecipient) throw new Error('injected SES failure')
      return `fake-message-${locale}-${sent.length}`
    }
    const worker = createWelcomeEmailWorker({ pool, send, logger: { info() {}, error() {} } })

    const zh = await createUserWithWelcomeEmail(pool, ' ZH@Example.test ', 'hash', 'ZH', 'zh')
    const en = await createUserWithWelcomeEmail(pool, 'en@example.test', 'hash', 'EN', 'en')
    await worker.runOnce()
    await worker.runOnce()

    const localized = await pool.query(
      `SELECT user_id, locale, status, message_id
       FROM email_outbox WHERE user_id = ANY($1::int[]) ORDER BY user_id`,
      [[zh.id, en.id]],
    )
    expect(localized.rows).toEqual([
      { user_id: zh.id, locale: 'zh', status: 'sent', message_id: 'fake-message-zh-1' },
      { user_id: en.id, locale: 'en', status: 'sent', message_id: 'fake-message-en-2' },
    ])

    const loginOrCreate = async (email: string, locale: SupportedLanguage) => {
      const normalized = email.trim().toLowerCase()
      return await getUserByEmail(pool, normalized)
        ?? createUserWithWelcomeEmail(pool, normalized, 'hash', undefined, locale)
    }
    expect((await loginOrCreate('ZH@example.test', 'en')).id).toBe(zh.id)
    await worker.runOnce()
    const repeatCount = await pool.query(
      `SELECT COUNT(*)::int AS count FROM email_outbox WHERE user_id = $1 AND email_type = 'welcome'`,
      [zh.id],
    )
    expect(repeatCount.rows[0].count).toBe(1)

    const failed = await createUserWithWelcomeEmail(pool, 'failure@example.test', 'hash', 'Failure', 'en')
    failingRecipient = failed.email
    await worker.runOnce()
    const failedUser = await getUserByEmail(pool, failed.email)
    const pending = await pool.query(
      `SELECT id, status, attempt_count, last_error, next_attempt_at
       FROM email_outbox WHERE user_id = $1`,
      [failed.id],
    )
    expect(failedUser?.id).toBe(failed.id)
    expect(pending.rows[0]).toMatchObject({
      status: 'pending', attempt_count: 1, last_error: 'injected SES failure',
    })
    expect(new Date(pending.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now())

    failingRecipient = undefined
    await pool.query(`UPDATE email_outbox SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [pending.rows[0].id])
    await worker.runOnce()
    const retried = await pool.query(
      `SELECT id, status, attempt_count, message_id, last_error FROM email_outbox WHERE user_id = $1`,
      [failed.id],
    )
    expect(retried.rows[0]).toMatchObject({
      id: pending.rows[0].id,
      status: 'sent',
      attempt_count: 2,
      message_id: 'fake-message-en-4',
      last_error: null,
    })

    const fenced = await createUserWithWelcomeEmail(pool, 'fenced@example.test', 'hash', 'Fenced', 'en')
    const firstClaim = await claimWelcomeEmails(pool, 1, new Date(0))
    expect(firstClaim).toHaveLength(1)
    await pool.query(
      `UPDATE email_outbox SET locked_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`,
      [firstClaim[0].id],
    )
    const secondClaim = await claimWelcomeEmails(pool, 1, new Date())
    expect(secondClaim[0]).toMatchObject({ id: firstClaim[0].id, userId: fenced.id, attemptCount: 2 })

    await markWelcomeEmailSent(pool, firstClaim[0].id, firstClaim[0].attemptCount, 'stale-message')
    let fencedRow = await pool.query(`SELECT status, attempt_count, message_id FROM email_outbox WHERE id = $1`, [firstClaim[0].id])
    expect(fencedRow.rows[0]).toEqual({ status: 'processing', attempt_count: 2, message_id: null })

    await markWelcomeEmailSent(pool, secondClaim[0].id, secondClaim[0].attemptCount, 'current-message')
    fencedRow = await pool.query(`SELECT status, attempt_count, message_id FROM email_outbox WHERE id = $1`, [firstClaim[0].id])
    expect(fencedRow.rows[0]).toEqual({ status: 'sent', attempt_count: 2, message_id: 'current-message' })
  }, 30_000)
})
