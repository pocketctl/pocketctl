import pg from 'pg'
import { createPool, type DBConfig } from './db.js'

export interface RelayPools {
  control: pg.Pool;
  ingest: pg.Pool;
  query: pg.Pool;
  worker: pg.Pool;
}

type PoolEnvironment = Record<string, string | undefined>;

function bounded(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function strictBudget(raw: string | undefined, fallback: number, variable: string): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${variable} must be a positive decimal integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${variable} must be a positive decimal integer`);
  return value;
}

function workloadPool(
  config: DBConfig,
  name: keyof RelayPools,
  max: number,
  connectionTimeoutMillis: number,
  statementTimeoutMillis: number,
): pg.Pool {
  return createPool(config, { name, max, connectionTimeoutMillis, statementTimeoutMillis });
}

export function createRelayPools(config: DBConfig, env: PoolEnvironment = process.env): RelayPools {
  const singleMax = strictBudget(env.DB_POOL_SINGLE_MAX, 16, 'DB_POOL_SINGLE_MAX');
  const totalMax = strictBudget(env.DB_POOL_TOTAL_MAX, 28, 'DB_POOL_TOTAL_MAX');
  const budgets = {
    control: bounded(env.DB_CONTROL_POOL_MAX, 4),
    ingest: bounded(env.DB_INGEST_POOL_MAX, 8),
    query: bounded(env.DB_QUERY_POOL_MAX, 8),
    worker: bounded(env.DB_WORKER_POOL_MAX, 8),
  };
  for (const [name, max] of Object.entries(budgets)) {
    if (max > singleMax) throw new Error(`DB_${name.toUpperCase()}_POOL_MAX exceeds DB_POOL_SINGLE_MAX`);
  }
  const total = Object.values(budgets).reduce((sum, max) => sum + max, 0);
  if (total > totalMax) throw new Error(`pool total ${total} exceeds DB_POOL_TOTAL_MAX ${totalMax}`);
  const pools = {
    // Admission must remain fast under saturation, while an admitted query
    // gets a workload-appropriate execution budget.
    control: workloadPool(config, 'control', budgets.control, 200, 1_000),
    ingest: workloadPool(config, 'ingest', budgets.ingest, 500, 5_000),
    query: workloadPool(config, 'query', budgets.query, 1_000, 15_000),
    worker: workloadPool(config, 'worker', budgets.worker, 1_000, 30_000),
  };
  console.log(`[db] pools control=${pools.control.options.max} ingest=${pools.ingest.options.max} query=${pools.query.options.max} worker=${pools.worker.options.max} total=${total}/${totalMax} single_max=${singleMax} (verify against PostgreSQL max_connections)`);
  return pools;
}

export async function closeRelayPools(pools: RelayPools): Promise<void> {
  await Promise.all([...new Set(Object.values(pools))].map((pool) => pool.end()));
}
