import {updateSourceGauges} from './sources/metrics.js'
import type pg from 'pg'
import { updateFeedLagGauge, updatePhase4Gauges, updatePhase5Gauges, updateBusinessHealthGauges, updateJobSchedulingGauges, updateRetrievalIndexGauges, type MemoryMetrics } from './metrics.js'

/** Inbox history is large and immutable enough to sample slowly. Active
 * states use their partial indexes and reset only after a successful query. */
export function createInboxGaugeUpdater(metrics:MemoryMetrics['inboxRows'], options:{now?:()=>number;historyIntervalMs?:number}={}) {
  const now=options.now??Date.now
  const historyIntervalMs=options.historyIntervalMs??15*60_000
  let lastHistory:number|undefined
  return async(pool:Pick<pg.Pool,'query'>):Promise<void>=>{
    const active=await pool.query<{projection_state:string;count:string}>(`
      SELECT projection_state,COUNT(*)::text AS count FROM memory_feed_inbox
      WHERE projection_state IN ('pending','quarantined') GROUP BY projection_state`)
    const counts=new Map(active.rows.map(row=>[row.projection_state,Number(row.count)]))
    for(const state of ['pending','quarantined'])metrics.set({state},counts.get(state)??0)
    const measuredAt=now()
    if(lastHistory!==undefined&&measuredAt-lastHistory<historyIntervalMs)return
    // Bound attempts too: a slow history scan must not recur every active tick.
    lastHistory=measuredAt
    const history=await pool.query<{projection_state:string;count:string}>(`
      SELECT projection_state,COUNT(*)::text AS count FROM memory_feed_inbox
      WHERE projection_state IN ('projected','purged') GROUP BY projection_state`)
    const historyCounts=new Map(history.rows.map(row=>[row.projection_state,Number(row.count)]))
    for(const state of ['projected','purged'])metrics.set({state},historyCounts.get(state)??0)
  }
}

/** Local server-side timeouts cancel work and cannot leak onto pooled clients. */
export function createWorkerGaugeCollector(pool:pg.Pool,metrics:MemoryMetrics,enabled:boolean,lifecycleMode:'off'|'enabled'|'shadow'='off') {
  const updateInbox=createInboxGaugeUpdater(metrics.inboxRows)
  return async()=>{
    const client=await pool.connect()
    try{
      await client.query('BEGIN READ ONLY')
      await client.query(`SET LOCAL statement_timeout='3s'`)
      await updateSourceGauges(client,metrics.source)
      // Pass a query-only adapter: nested health collectors share this timeout
      // and transaction rather than acquiring another pooled connection.
      await updateGauges({query:client.query.bind(client)},metrics,updateInbox,enabled,lifecycleMode)
      await client.query('COMMIT')
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}
    finally{client.release()}
  }
}

const LOCAL_INSTALLATION_STATES = [
  'discovering', 'syncing', 'ready', 'degraded', 'purging', 'purged', 'integrity_error',
] as const
const JOB_TYPES = [
  'git_ingest', 'git_export', 'git_reconcile',
  'project_feed', 'compile_episode', 'snapshot_reconcile', 'session_purge',
  'installation_purge', 'report_status', 'report_usage',
  'extract_candidates', 'index_claim_version', 'rebuild_claim_index', 'expire_claims',
	'index_shared_claim',
	'recompile_extraction_policy', 'compile_context_shadow',
	'record_context_delivery', 'invalidate_context_packs',
	'parse_code_snapshot', 'build_wiki',
	'extract_skill_candidate',
] as const
const JOB_STATES = ['pending', 'running', 'completed', 'dead'] as const

/** Update the DB-backed gauges; absent label values reset to zero. */
async function updateGauges(pool: Pick<pg.Pool, 'query'>, metrics: MemoryMetrics, updateInbox: (pool: Pick<pg.Pool, 'query'>)=>Promise<void>, enabled: boolean, lifecycleMode: 'off' | 'enabled' | 'shadow'): Promise<void> {
  const installations = await pool.query<{ local_status: string; count: string }>(`
    SELECT local_status, COUNT(*)::text AS count FROM memory_installations GROUP BY local_status
  `)
  const installationCounts = new Map(installations.rows.map(row => [row.local_status, Number(row.count)]))
  for (const state of LOCAL_INSTALLATION_STATES) {
    metrics.installations.set({ state }, installationCounts.get(state) ?? 0)
  }

  const jobs = await pool.query<{ job_type: string; state: string; count: string }>(`
    SELECT job_type, state, COUNT(*)::text AS count FROM memory_jobs GROUP BY job_type, state
  `)
  const jobCounts = new Map(jobs.rows.map(row => [`${row.job_type}:${row.state}`, Number(row.count)]))
  for (const type of JOB_TYPES) {
    for (const state of JOB_STATES) {
      metrics.jobs.set({ type, state }, jobCounts.get(`${type}:${state}`) ?? 0)
    }
  }

  await updateBusinessHealthGauges(pool,metrics,enabled,lifecycleMode)
  await updateJobSchedulingGauges(pool,metrics)
  await updateRetrievalIndexGauges(pool,metrics.phase1)

  const outbox = await pool.query<{ pending: string; reported: string; dead_letter: string }>(`
    SELECT COUNT(*) FILTER (WHERE reported_at IS NULL AND dead_lettered_at IS NULL)::text AS pending,
           COUNT(*) FILTER (WHERE reported_at IS NOT NULL)::text AS reported,
           COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::text AS dead_letter
    FROM memory_usage_outbox
  `)
  metrics.usageOutboxRows.set({ state: 'pending' }, Number(outbox.rows[0]?.pending ?? 0))
  metrics.usageOutboxRows.set({ state: 'reported' }, Number(outbox.rows[0]?.reported ?? 0))
  metrics.usageOutboxRows.set({ state: 'dead_letter' }, Number(outbox.rows[0]?.dead_letter ?? 0))

  await updateFeedLagGauge(pool, metrics.feedLag)
  await updatePhase4Gauges(pool, metrics.phase4)
  await updatePhase5Gauges(pool, metrics.phase5)
  await updateInbox(pool)
}
