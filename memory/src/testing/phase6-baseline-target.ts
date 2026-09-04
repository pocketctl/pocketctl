import pg from 'pg'
import { assertMemoryTestDatabase, memoryTestDatabaseConfig } from './test-db.js'

export interface BaselineTestTarget { host: string; port: string; database: string; user: string }
type GuardPool = Parameters<typeof assertMemoryTestDatabase>[0]

/** Both callers place all schema/data work inside this callback. Shared policy
 * validates before any query; live identity and target agreement precede work.
 * The expected identity contains no URL, password or other credential. */
export async function withBaselineTestTarget<T>(pool: GuardPool, url: string, expected: BaselineTestTarget | undefined,
  run: (target: BaselineTestTarget) => Promise<T>): Promise<T> {
  const config = memoryTestDatabaseConfig(url)
  let target: BaselineTestTarget
  try {
    // Client construction does not connect. Use pg's actual parsing/defaults
    // (including PGPORT/query parameters), not a second invented URL policy.
    const parsed = new pg.Client({ connectionString: url })
    const host = parsed.host.includes(':') ? `[${parsed.host.replace(/^\[|\]$/g, '')}]` : parsed.host
    const effective = new URL(`postgresql://${encodeURIComponent(parsed.user!)}@${host}:${parsed.port}/${encodeURIComponent(parsed.database!)}`)
    const actual = memoryTestDatabaseConfig(effective.href)
    if (actual.database !== config.database || actual.user !== config.user) throw new Error()
    target = { host: effective.hostname, port: String(parsed.port), ...actual }
  } catch { throw new Error('baseline_test_target_mismatch') }
  if (expected && (Object.keys(target) as (keyof BaselineTestTarget)[]).some(key => target[key] !== expected[key])) {
    throw new Error('baseline_test_target_mismatch')
  }
  await assertMemoryTestDatabase(pool, url)
  return run(target)
}
