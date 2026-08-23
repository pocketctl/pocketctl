import { pathToFileURL } from 'node:url'
import type pg from 'pg'
import { createPool, parseDBUrl, type DBConfig } from './db.js'
import {
  inspectTokenUsageMigration,
  type TokenUsagePreflightOptions,
  type TokenUsagePreflightReport,
} from './token-usage/preflight.js'

interface TokenUsagePreflightCommandOptions {
  args?: string[]
  env?: Record<string, string | undefined>
  inspect?: (pool: pg.Pool, options: TokenUsagePreflightOptions) => Promise<TokenUsagePreflightReport>
  createPool?: (config: DBConfig) => pg.Pool
  write?: (line: string) => void
}

function parseArgs(args: string[]): TokenUsagePreflightOptions {
  let acceptLegacyHistory = false
  for (const argument of args) {
    if (argument === '--accept-legacy-history') {
      acceptLegacyHistory = true
      continue
    }
    throw new Error(`unknown token usage preflight option: ${argument}`)
  }
  return { acceptLegacyHistory }
}

export async function runTokenUsagePreflight(
  options: TokenUsagePreflightCommandOptions = {},
): Promise<number> {
  const preflightOptions = parseArgs(options.args ?? process.argv.slice(2))
  const env = options.env ?? process.env
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required for token usage preflight')
  const poolFactory = options.createPool ?? ((config) => createPool(config, {
    name: 'token-usage-preflight',
    max: 1,
    connectionTimeoutMillis: 5_000,
    statementTimeoutMillis: 120_000,
  }))
  const pool = poolFactory(parseDBUrl(databaseUrl))
  try {
    const report = await (options.inspect ?? inspectTokenUsageMigration)(pool, preflightOptions)
    ;(options.write ?? ((line) => process.stdout.write(line)))(`${JSON.stringify(report, null, 2)}\n`)
    return report.ready ? 0 : 2
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTokenUsagePreflight().then(
    (exitCode) => { process.exitCode = exitCode },
    (error) => {
      console.error('[tokens:v2] preflight failed', {
        errorName: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : 'unknown error',
      })
      process.exitCode = 1
    },
  )
}
