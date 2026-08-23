import type pg from 'pg'
import type { TokenUsageFeatures } from '../config/token-usage.js'
import {
  closeEligibleTokenUsageDays,
  type TokenDayCloseResult,
} from './day-closer.js'
import {
  migrateTokenUsageAccounting,
  type TokenUsageMigrationResult,
} from './migration.js'

type Migrate = (pool: pg.Pool, now?: Date) => Promise<TokenUsageMigrationResult>
type Close = (pool: pg.Pool, now?: Date) => Promise<TokenDayCloseResult[]>

/** Once the baseline exists, fact writing is a one-way accounting contract. */
export async function assertTokenUsageWriteContinuity(
  pool: Pick<pg.Pool, 'query'>,
  features: TokenUsageFeatures,
): Promise<void> {
  if (features.writeFacts) return
  const activated = await pool.query(
    `SELECT 1 FROM token_usage_accounting_state WHERE key = 'baseline-v1' LIMIT 1`,
  )
  if ((activated.rowCount ?? activated.rows.length) > 0) {
    throw new Error(
      'TOKEN_USAGE_FACTS_WRITE cannot be disabled after the accounting baseline is activated',
    )
  }
}

export async function initializeTokenUsageAccounting(
  pool: pg.Pool,
  features: TokenUsageFeatures,
  now: Date = new Date(),
  dependencies: { migrate?: Migrate; close?: Close } = {},
): Promise<{ migration: TokenUsageMigrationResult; closures: TokenDayCloseResult[] } | null> {
  if (!features.writeFacts) return null
  const migrate = dependencies.migrate ?? migrateTokenUsageAccounting
  const close = dependencies.close ?? closeEligibleTokenUsageDays
  const migration = await migrate(pool, now)
  const closures = await close(pool, now)
  return { migration, closures }
}

export async function runTokenUsageCloseSweep(
  pool: pg.Pool,
  now: Date = new Date(),
  observe: (status: TokenDayCloseResult['status']) => void = () => {},
  close: Close = closeEligibleTokenUsageDays,
): Promise<TokenDayCloseResult[]> {
  const results = await close(pool, now)
  for (const result of results) observe(result.status)
  return results
}
