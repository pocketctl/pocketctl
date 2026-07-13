import type pg from 'pg'
import type { SupportedLanguage } from './config/language.js'
import { getWelcomeTemplateId, sendWelcomeEmail } from './config/email.js'
import {
  claimWelcomeEmails,
  markWelcomeEmailSent,
  rescheduleWelcomeEmail,
  type WelcomeEmailJob,
} from './db.js'

const RETRY_DELAYS_MS = [
  60_000,
  300_000,
  1_800_000,
  7_200_000,
  43_200_000,
  86_400_000,
]

export function retryDelayMs(attemptCount: number): number {
  const index = Math.max(0, Math.min(Math.trunc(attemptCount) - 1, RETRY_DELAYS_MS.length - 1))
  return RETRY_DELAYS_MS[index]
}

type Logger = Pick<Console, 'info' | 'error'>
const MAX_ERROR_LENGTH = 1_000
const REDACTED = '[REDACTED]'

function safeError(error: unknown): string {
  let message: string
  try {
    message = error instanceof Error ? error.message : String(error)
  } catch {
    message = 'Unknown error'
  }
  return message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]}>"']+/gi, REDACTED)
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(authorization|token|(?:access|refresh|id)[_-]?token|client[_-]?secret|secret(?:[_-]?access[_-]?key)?|password|credential|(?:api|access)[_-]?key(?:[_-]?id)?)[\s"']*[:=][\s"']*[^\s,;}"']+/gi, (_match, key) => `${key}=${REDACTED}`)
    .slice(0, MAX_ERROR_LENGTH)
}

export interface WelcomeEmailWorkerOptions {
  pool: pg.Pool
  send?: (recipientEmail: string, locale: SupportedLanguage) => Promise<string>
  now?: () => Date
  intervalMs?: number
  leaseMs?: number
  drainTimeoutMs?: number
  claim?: (pool: pg.Pool, limit: number, leaseCutoff: Date) => Promise<WelcomeEmailJob[]>
  markSent?: (pool: pg.Pool, id: string, attemptCount: number, messageId: string) => Promise<void>
  reschedule?: (pool: pg.Pool, id: string, attemptCount: number, nextAttemptAt: Date, error: string) => Promise<void>
  logger?: Logger
}

export function createWelcomeEmailWorker(options: WelcomeEmailWorkerOptions) {
  const send = options.send ?? sendWelcomeEmail
  const now = options.now ?? (() => new Date())
  const intervalMs = options.intervalMs ?? 30_000
  const leaseMs = options.leaseMs ?? 10 * 60_000
  const drainTimeoutMs = options.drainTimeoutMs ?? 500
  const claim = options.claim ?? claimWelcomeEmails
  const markSent = options.markSent ?? markWelcomeEmailSent
  const reschedule = options.reschedule ?? rescheduleWelcomeEmail
  const logger = options.logger ?? console
  let timer: ReturnType<typeof setInterval> | undefined
  let activeRun: Promise<void> | undefined

  function safeLog(level: keyof Logger, message: string, detail: unknown): void {
    try {
      logger[level](message, detail)
    } catch {
      // Logging must never affect durable outbox processing.
    }
  }

  async function runOnce(): Promise<void> {
    if (activeRun) return
    const run = processBatch()
    activeRun = run
    try {
      await run
    } finally {
      if (activeRun === run) activeRun = undefined
    }
  }

  async function processBatch(): Promise<void> {
    const leaseCutoff = new Date(now().getTime() - leaseMs)
    const jobs = await claim(options.pool, 1, leaseCutoff)
    for (const job of jobs) {
      const templateId = getWelcomeTemplateId(job.locale)
      try {
        const messageId = await send(job.recipientEmail, job.locale)
        await markSent(options.pool, job.id, job.attemptCount, messageId)
        safeLog('info', '[welcome-email] processed', {
          jobId: job.id, userId: job.userId, locale: job.locale, attempt: job.attemptCount,
          templateId, templateOutcome: 'sent', messageId,
        })
      } catch (error) {
        const message = safeError(error)
        const nextAttemptAt = new Date(now().getTime() + retryDelayMs(job.attemptCount))
        try {
          await reschedule(options.pool, job.id, job.attemptCount, nextAttemptAt, message)
          safeLog('error', '[welcome-email] processed', {
            jobId: job.id, userId: job.userId, locale: job.locale, attempt: job.attemptCount,
            templateId, templateOutcome: 'failed', messageId: undefined, error: message,
          })
        } catch (rescheduleError) {
          safeLog('error', '[welcome-email] processed', {
            jobId: job.id, userId: job.userId, locale: job.locale, attempt: job.attemptCount,
            templateId, templateOutcome: 'reschedule_failed', messageId: undefined,
            error: safeError(rescheduleError),
          })
        }
      }
    }
  }

  function runScheduled(): void {
    void runOnce().catch(error => safeLog('error', '[welcome-email] worker run failed', safeError(error)))
  }

  return {
    start(): void {
      if (timer) return
      runScheduled()
      timer = setInterval(runScheduled, intervalMs)
    },
    runOnce,
    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      const draining = activeRun
      if (!draining) return
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        draining.catch(() => {}),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, drainTimeoutMs) }),
      ])
      if (timeout) clearTimeout(timeout)
    },
  }
}
