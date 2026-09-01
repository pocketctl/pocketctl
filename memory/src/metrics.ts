import { Registry, Counter, Gauge, Histogram } from 'prom-client'
import type pg from 'pg'

export async function updateFeedLagGauge(
  pool: Pick<pg.Pool, 'query'>,
  gauge: Pick<Gauge, 'set'>,
): Promise<void> {
  const lag = await pool.query<{ lag_seconds: string | null }>(`
    SELECT EXTRACT(EPOCH FROM (NOW() - MIN(COALESCE(last_pull_at, created_at))))::text AS lag_seconds
    FROM memory_installations
    WHERE relay_status IN ('pending', 'active')
      AND local_status IN ('discovering', 'syncing', 'ready', 'degraded')
      AND snapshot_required = FALSE
  `)
  gauge.set(Number(lag.rows[0]?.lag_seconds ?? 0))
}

/**
 * Bounded Prometheus metrics for the Memory service. Label names are frozen
 * low-cardinality allowlists (plan section 12): installation, session,
 * provider URL and error message labels are forbidden.
 */
export function createMemoryMetrics() {
  const registry = new Registry()
  const phase1 = createPhase1Metrics(registry)
  const phase4 = createPhase4Metrics(registry)

  const installations = new Gauge({
    name: 'pocketctl_memory_installations',
    help: 'Local installations by local state',
    labelNames: ['state'] as const,
    registers: [registry],
  })

  const feedPulls = new Counter({
    name: 'pocketctl_memory_feed_pulls_total',
    help: 'Relay feed pulls by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const feedAcks = new Counter({
    name: 'pocketctl_memory_feed_acks_total',
    help: 'Relay feed acks by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const feedLag = new Gauge({
    name: 'pocketctl_memory_feed_lag_seconds',
    help: 'Seconds between the newest relay feed row and its durable commit',
    registers: [registry],
  })

  const inboxRows = new Gauge({
    name: 'pocketctl_memory_inbox_rows',
    help: 'Durable inbox rows by projection state',
    labelNames: ['state'] as const,
    registers: [registry],
  })

  const projection = new Counter({
    name: 'pocketctl_memory_projection_total',
    help: 'Source projections by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const jobs = new Gauge({
    name: 'pocketctl_memory_jobs',
    help: 'Background jobs by type and state; completed/dead reflect their retention windows (24h/7d)',
    labelNames: ['type', 'state'] as const,
    registers: [registry],
  })

  const snapshot = new Counter({
    name: 'pocketctl_memory_snapshot_total',
    help: 'Snapshot reconcile runs by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const purge = new Counter({
    name: 'pocketctl_memory_purge_total',
    help: 'Purge operations by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })

  const relayRequests = new Counter({
    name: 'pocketctl_memory_relay_requests_total',
    help: 'Relay HTTP requests by operation and result',
    labelNames: ['operation', 'result'] as const,
    registers: [registry],
  })

  const relayDuration = new Histogram({
    name: 'pocketctl_memory_relay_request_duration_seconds',
    help: 'Relay HTTP request duration by operation',
    labelNames: ['operation'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  })

  const usageOutboxRows = new Gauge({
    name: 'pocketctl_memory_usage_outbox_rows',
    help: 'Usage outbox rows by state',
    labelNames: ['state'] as const,
    registers: [registry],
  })

  return {
    registry,
    installations,
    feedPulls,
    feedAcks,
    feedLag,
    inboxRows,
    projection,
    jobs,
    snapshot,
    purge,
    relayRequests,
    relayDuration,
    usageOutboxRows,
    phase1,
    phase4,
  }
}

export type MemoryMetrics = ReturnType<typeof createMemoryMetrics>


const EXTRACTION_RESULTS = new Set(['succeeded', 'failed', 'quarantined', 'skipped'])
const EXTRACTION_MODES = new Set(['shadow', 'enabled'])
const TOKEN_DIRECTIONS = new Set(['input', 'output'])
const CANDIDATE_STATUSES = new Set([
  'shadow', 'validated', 'duplicate', 'conflict',
  'rejected_by_validator', 'rejected', 'accepted',
])
const REVIEW_DECISIONS = new Set([
  'accepted_as_is', 'light_edit', 'major_edit', 'rejected',
])
const INDEX_RESULTS = new Set(['success', 'failed', 'skipped', 'degraded'])
const SEARCH_DEGRADED = new Set(['none', 'embedding'])
const FEEDBACK_ACTIONS = new Set([
  'candidate_accepted', 'candidate_corrected', 'candidate_rejected',
  'claim_corrected', 'claim_expired', 'claim_revoked', 'claim_deleted',
  'recall_used', 'recall_incorrect', 'recall_not_useful',
])
const PURGE_SCOPES = new Set(['session', 'installation', 'claim'])

function labelAllowed(set: Set<string>, value: string): boolean {
  return set.has(value)
}

/**
 * Phase 1 bounded metrics: extraction outcome/latency/tokens/cost, candidate
 * status, review decisions, indexing, search latency/results/degraded mode,
 * recall feedback, and purge invalidations. Labels come from the frozen
 * allowlists above — never query/claim/evidence text, session ids, paths,
 * grants or model output.
 */
export function createPhase1Metrics(registry = new Registry()) {

  const extractionRuns = new Counter({
    name: 'pocketctl_memory_extraction_runs_total',
    help: 'Candidate extraction runs by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const extractionLatency = new Histogram({
    name: 'pocketctl_memory_extraction_latency_seconds',
    help: 'Candidate extraction wall latency by mode',
    labelNames: ['mode'] as const,
    buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [registry],
  })
  const extractionTokens = new Counter({
    name: 'pocketctl_memory_extraction_tokens_total',
    help: 'Extraction model tokens by direction',
    labelNames: ['direction'] as const,
    registers: [registry],
  })
  const extractionCostMicros = new Counter({
    name: 'pocketctl_memory_extraction_cost_micros_total',
    help: 'Extraction model cost in micros when reported by the adapter',
    registers: [registry],
  })
  const candidateStatus = new Counter({
    name: 'pocketctl_memory_candidate_status_total',
    help: 'Candidates by deterministic status',
    labelNames: ['status'] as const,
    registers: [registry],
  })
  const reviewDecisions = new Counter({
    name: 'pocketctl_memory_review_decisions_total',
    help: 'Human review decisions',
    labelNames: ['decision'] as const,
    registers: [registry],
  })
  const indexJobs = new Counter({
    name: 'pocketctl_memory_index_jobs_total',
    help: 'Claim index jobs by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const searchLatency = new Histogram({
    name: 'pocketctl_memory_search_latency_seconds',
    help: 'Claim search latency by degraded mode',
    labelNames: ['degraded'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 1.5, 3, 5],
    registers: [registry],
  })
  const searchResults = new Histogram({
    name: 'pocketctl_memory_search_results',
    help: 'Claim search hit counts by degraded mode',
    labelNames: ['degraded'] as const,
    buckets: [0, 1, 3, 5, 10, 20],
    registers: [registry],
  })
  const recallFeedback = new Counter({
    name: 'pocketctl_memory_recall_feedback_total',
    help: 'Recall feedback actions',
    labelNames: ['action'] as const,
    registers: [registry],
  })
  const purgeInvalidations = new Counter({
    name: 'pocketctl_memory_purge_invalidations_total',
    help: 'Purge-driven content invalidations by scope',
    labelNames: ['scope'] as const,
    registers: [registry],
  })

  return {
    registry,
    extractionRuns,
    extractionLatency,
    extractionTokens,
    extractionCostMicros,
    candidateStatus,
    reviewDecisions,
    indexJobs,
    searchLatency,
    searchResults,
    recallFeedback,
    purgeInvalidations,
    extractionLabelAllowed(name: string, value: string): boolean {
      if (name === 'result') return labelAllowed(EXTRACTION_RESULTS, value)
      if (name === 'mode') return labelAllowed(EXTRACTION_MODES, value)
      if (name === 'direction') return labelAllowed(TOKEN_DIRECTIONS, value)
      if (name === 'status') return labelAllowed(CANDIDATE_STATUSES, value)
      return false
    },
    searchLabelAllowed(name: string, value: string): boolean {
      if (name === 'degraded') return labelAllowed(SEARCH_DEGRADED, value)
      return false
    },
    reviewLabelAllowed(name: string, value: string): boolean {
      if (name === 'decision') return labelAllowed(REVIEW_DECISIONS, value)
      return false
    },
    feedbackLabelAllowed(name: string, value: string): boolean {
      if (name === 'action') return labelAllowed(FEEDBACK_ACTIONS, value)
      return false
    },
  }
}

export type Phase1Metrics = ReturnType<typeof createPhase1Metrics>

const PHASE4_LABELS: Readonly<Record<string, Readonly<Record<string, ReadonlySet<string>>>>> = {
  code_snapshots: {
    result: new Set(['accepted', 'rejected', 'aborted', 'purged']),
    source_kind: new Set(['personal', 'shared']),
  },
  code_snapshot_bytes: {
    language_class: new Set(['typescript', 'javascript', 'file_only', 'unsupported', 'excluded']),
  },
  codegraph_runs: {
    mode: new Set(['shadow', 'enabled']),
    result: new Set(['succeeded', 'failed', 'cancelled', 'stale_generation', 'skipped']),
    incremental: new Set(['true', 'false']),
  },
  codegraph_nodes: { kind: new Set(['file', 'symbol', 'external']) },
  codegraph_edges: {
    kind: new Set(['definition', 'import', 'dependency', 'reference', 'call', 'test']),
    resolution: new Set(['resolved', 'unresolved', 'dynamic']),
  },
  codegraph_impact: {
    result: new Set(['complete', 'partial', 'unsupported', 'degraded', 'not_found']),
  },
  wiki_builds: {
    mode: new Set(['shadow', 'enabled']),
    result: new Set(['succeeded', 'failed', 'cancelled', 'stale_generation', 'skipped']),
  },
  wiki_stale_sections: {
    reason: new Set(['source_file_changed', 'source_symbol_changed', 'binding_removed', 'graph_rebuilt']),
  },
  wiki_publications: {
    result: new Set(['published', 'rejected', 'conflict', 'unauthorized', 'stale_generation']),
  },
  wiki_manual_actions: {
    action: new Set(['edit', 'lock', 'unlock']),
    result: new Set(['succeeded', 'rejected', 'conflict', 'unauthorized']),
  },
}

const PHASE4_LOG_FIELDS = new Set([
  'request_id', 'job_id', 'run_id', 'result', 'error_code',
  'count', 'duration_ms', 'mode', 'content_hash',
])

/** Names are checked before structured fields reach the logger. */
export function phase4LogFieldAllowed(name: string): boolean {
  return PHASE4_LOG_FIELDS.has(name)
}

/** Phase 4 CodeGraph/Wiki metrics with only frozen, low-cardinality labels. */
export function createPhase4Metrics(registry = new Registry()) {
  const codeSnapshots = new Counter({
    name: 'pocketctl_memory_code_snapshot_total',
    help: 'Immutable code snapshot lifecycle outcomes',
    labelNames: ['result', 'source_kind'] as const,
    registers: [registry],
  })
  const codeSnapshotBytes = new Counter({
    name: 'pocketctl_memory_code_snapshot_bytes',
    help: 'Accepted immutable source bytes by bounded language class',
    labelNames: ['language_class'] as const,
    registers: [registry],
  })
  const codegraphRuns = new Counter({
    name: 'pocketctl_memory_codegraph_runs_total',
    help: 'CodeGraph build runs by mode, result, and incremental strategy',
    labelNames: ['mode', 'result', 'incremental'] as const,
    registers: [registry],
  })
  const codegraphNodes = new Gauge({
    name: 'pocketctl_memory_codegraph_nodes',
    help: 'Active CodeGraph nodes by bounded kind',
    labelNames: ['kind'] as const,
    registers: [registry],
  })
  const codegraphEdges = new Gauge({
    name: 'pocketctl_memory_codegraph_edges',
    help: 'Active CodeGraph edges by bounded kind and resolution',
    labelNames: ['kind', 'resolution'] as const,
    registers: [registry],
  })
  const codegraphImpact = new Counter({
    name: 'pocketctl_memory_codegraph_impact_total',
    help: 'Bounded impact analysis requests by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const wikiBuilds = new Counter({
    name: 'pocketctl_memory_wiki_builds_total',
    help: 'Wiki candidate builds by mode and result',
    labelNames: ['mode', 'result'] as const,
    registers: [registry],
  })
  const wikiStaleSections = new Gauge({
    name: 'pocketctl_memory_wiki_stale_sections',
    help: 'Active Wiki stale sections by bounded reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  })
  const wikiPublications = new Counter({
    name: 'pocketctl_memory_wiki_publications_total',
    help: 'Atomic Wiki publication attempts by result',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const wikiManualActions = new Counter({
    name: 'pocketctl_memory_wiki_manual_actions_total',
    help: 'Manual and locked Wiki actions by action and result',
    labelNames: ['action', 'result'] as const,
    registers: [registry],
  })

  return {
    registry,
    codeSnapshots,
    codeSnapshotBytes,
    codegraphRuns,
    codegraphNodes,
    codegraphEdges,
    codegraphImpact,
    wikiBuilds,
    wikiStaleSections,
    wikiPublications,
    wikiManualActions,
    labelAllowed(metric: string, label: string, value: string): boolean {
      return PHASE4_LABELS[metric]?.[label]?.has(value) ?? false
    },
  }
}

export type Phase4Metrics = ReturnType<typeof createPhase4Metrics>

const PHASE4_NODE_KINDS = ['file', 'symbol', 'external'] as const
const PHASE4_EDGE_KINDS = ['definition', 'import', 'dependency', 'reference', 'call', 'test'] as const
const PHASE4_EDGE_RESOLUTIONS = ['resolved', 'unresolved', 'dynamic'] as const
const PHASE4_STALE_REASONS = [
  'source_file_changed', 'source_symbol_changed', 'binding_removed', 'graph_rebuilt',
] as const

/** Refresh Phase 4 gauges from active heads/projections only. */
export async function updatePhase4Gauges(
  pool: Pick<pg.Pool, 'query'>,
  metrics: Phase4Metrics,
): Promise<void> {
  const nodes = await pool.query<{ kind: string; count: string }>(`
    SELECT n.kind, COUNT(*)::text AS count
    FROM memory_code_nodes n
    JOIN memory_code_graph_heads h
      ON h.installation_id = n.installation_id
     AND h.active_graph_version_id = n.graph_version_id
    GROUP BY n.kind
  `)
  const nodeCounts = new Map(nodes.rows.map(row => [row.kind, Number(row.count)]))
  for (const kind of PHASE4_NODE_KINDS) {
    metrics.codegraphNodes.set({ kind }, nodeCounts.get(kind) ?? 0)
  }

  const edges = await pool.query<{ kind: string; resolution: string; count: string }>(`
    SELECT e.kind, e.resolution, COUNT(*)::text AS count
    FROM memory_code_edges e
    JOIN memory_code_graph_heads h
      ON h.installation_id = e.installation_id
     AND h.active_graph_version_id = e.graph_version_id
    GROUP BY e.kind, e.resolution
  `)
  const edgeCounts = new Map(edges.rows.map(row => [
    `${row.kind}:${row.resolution}`, Number(row.count),
  ]))
  for (const kind of PHASE4_EDGE_KINDS) {
    for (const resolution of PHASE4_EDGE_RESOLUTIONS) {
      metrics.codegraphEdges.set({ kind, resolution }, edgeCounts.get(`${kind}:${resolution}`) ?? 0)
    }
  }

  const stale = await pool.query<{ reason: string; count: string }>(`
    SELECT reason, COUNT(*)::text AS count
    FROM memory_wiki_stale_marks
    WHERE cleared_at IS NULL
    GROUP BY reason
  `)
  const staleCounts = new Map(stale.rows.map(row => [row.reason, Number(row.count)]))
  for (const reason of PHASE4_STALE_REASONS) {
    metrics.wikiStaleSections.set({ reason }, staleCounts.get(reason) ?? 0)
  }
}

// ---- Phase 2 context observability (plan 17): bounded outcome codes only —
// never query text, pack content, grants, paths or high-cardinality labels.

export interface Phase2ContextMetrics {
  contextCompiles: { inc(labels: { outcome: string; mode: string }): void }
  contextAdmissions: { inc(labels: { result: string }): void }
  contextDeliveries: { inc(labels: { state: string; adapter: string }): void }
  contextLatency: { observe(labels: { stage: string }, seconds: number): void }
  contextInvalidations: { inc(labels: { reason: string }): void }
}

export function createPhase2ContextMetrics(): Phase2ContextMetrics {
  const counters = new Map<string, number>()
  const histograms = new Map<string, number[]>()
  const bump = (map: Map<string, number>, key: string) => {
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return {
    contextCompiles: { inc: (labels) => bump(counters, `compile:${labels.outcome}:${labels.mode}`) },
    contextAdmissions: { inc: (labels) => bump(counters, `admit:${labels.result}`) },
    contextDeliveries: { inc: (labels) => bump(counters, `deliver:${labels.state}:${labels.adapter}`) },
    contextLatency: {
      observe: (labels, seconds) => {
        const key = `latency:${labels.stage}`
        const list = histograms.get(key) ?? []
        list.push(seconds)
        histograms.set(key, list)
      },
    },
    contextInvalidations: { inc: (labels) => bump(counters, `invalidate:${labels.reason}`) },
  }
}
