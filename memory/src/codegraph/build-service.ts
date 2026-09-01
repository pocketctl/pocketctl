import type pg from 'pg'

import type { JobClaim, JobFence } from '../jobs/types.js'
import { createSourceRepository } from './source-repository.js'
import { createGraphRepository } from './graph-repository.js'
import {
  assembleIncrementalGraph,
  parseCodeSnapshot,
  PARSER_VERSION,
  type ParsedGraph,
} from './typescript-parser.js'
import { canonicalGraphHash } from './typescript-parser.js'
import { validateGraphCandidate } from './validator.js'
import { createWikiStaleService } from '../wiki/stale-service.js'
import type { Phase4Metrics } from '../metrics.js'

/**
 * Phase 4 parse job service (ADR-0006 §4): `parse_code_snapshot` builds the
 * deterministic graph candidate, validates it, and activates the head inside
 * one fenced transaction. A lost lease, tombstone, non-ready snapshot, or
 * validator failure keeps the previous active graph untouched.
 */

async function graphPoolQueryOne(pool: pg.Pool, sql: string, params: unknown[]): Promise<Record<string, unknown> | null> {
  const result = await pool.query(sql, params)
  return result.rows[0] ?? null
}

async function graphPoolQuery(pool: pg.Pool, sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const result = await pool.query(sql, params)
  return result.rows
}

export class GraphBuildFenceError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export interface CodeGraphBuildDeps {
  pool: pg.Pool
  parse?: (input: { files: Array<{ path: string; content: string }> }) => ParsedGraph
  metrics?: Phase4Metrics
  mode?: 'shadow' | 'enabled'
}

export function createCodeGraphBuildService(deps: CodeGraphBuildDeps) {
  const pool = deps.pool
  const sources = createSourceRepository(pool)
  const graphs = createGraphRepository(pool)
  const wikiStale = createWikiStaleService(pool)
  const parse = deps.parse ?? ((input: { files: Array<{ path: string; content: string }> }) =>
    parseCodeSnapshot({ files: input.files, parserVersion: PARSER_VERSION }))

  async function recheckFence(client: pg.PoolClient, fence: JobFence): Promise<void> {
    const row = await client.query<{ state: string; claimed_by: string | null; claim_epoch: string }>(`
      SELECT state, claimed_by, claim_epoch::text FROM memory_jobs WHERE job_id = $1
    `, [fence.jobId])
    const job = row.rows[0]
    if (!job
      || job.state !== 'running'
      || job.claimed_by !== fence.claimedBy
      || Number(job.claim_epoch) !== fence.claimEpoch) {
      throw new GraphBuildFenceError('job_fence_lost')
    }
  }

  return {
    async handleParseCodeSnapshot(
      claim: JobClaim,
      _signal: AbortSignal,
      ctx?: { fence: JobFence },
    ): Promise<void> {
      let incremental: 'true' | 'false' = 'false'
      const mode = deps.mode ?? 'shadow'
      try {
        const fence = ctx?.fence
        if (!fence) throw new GraphBuildFenceError('job_fence_missing')

        const client = await pool.connect()
        try {
        await client.query('BEGIN')

        // Fence rechecks happen first and inside every transaction: a late
        // worker, tombstone, or stale state can never publish.
        await recheckFence(client, fence)
        const snapshotId = typeof claim.payload?.snapshot_id === 'string'
          ? claim.payload.snapshot_id
          : claim.idempotency_key.split(':')[1]
        if (!snapshotId) throw new GraphBuildFenceError('payload_missing')
        const snapshot = await sources.getSnapshot({
          installationId: claim.installation_id!,
          snapshotId,
        }, client)
        if (!snapshot) throw new GraphBuildFenceError('not_found')
        const repoTombstone = await client.query(`
          SELECT 1 FROM memory_repository_tombstones
          WHERE installation_id = $1 AND repository_id = $2
        `, [claim.installation_id!, snapshot.repositoryId])
        if ((repoTombstone.rowCount ?? 0) > 0) {
          throw new GraphBuildFenceError('repository_tombstoned')
        }
        const snapshotTombstone = await client.query(`
          SELECT 1 FROM memory_source_snapshot_tombstones
          WHERE installation_id = $1 AND snapshot_id = $2
        `, [claim.installation_id!, snapshotId])
        if ((snapshotTombstone.rowCount ?? 0) > 0) {
          throw new GraphBuildFenceError('snapshot_tombstoned')
        }
        if (snapshot.state !== 'ready' && snapshot.state !== 'parsing' && snapshot.state !== 'active') {
          throw new GraphBuildFenceError('not_ready')
        }

        // Idempotent replay: an existing active version for this generation
        // means the work already committed.
        const existing = await client.query<{ graph_version_id: string }>(`
          SELECT graph_version_id::text FROM memory_code_graph_versions
          WHERE installation_id = $1 AND snapshot_id = $2 AND parser_version = $3
        `, [claim.installation_id!, snapshotId, PARSER_VERSION])
        if ((existing.rowCount ?? 0) > 0) {
          await client.query('COMMIT')
          deps.metrics?.codegraphRuns.inc({ mode, result: 'skipped', incremental: 'false' })
          return
        }

        await graphs.markSnapshotState({
          installationId: claim.installation_id!,
          snapshotId,
          state: 'parsing',
          client,
        })
        await client.query('COMMIT')

        // Parsing happens outside the transaction: it is pure computation
        // over committed snapshot blobs.
        const entries = await sources.listEntries({
          installationId: claim.installation_id!,
          snapshotId,
        })
        const files: Array<{ path: string; content: string }> = []
        for (const entry of entries) {
          const content = await sources.getBlob({
            installationId: claim.installation_id!,
            blobHash: entry.blobSha256,
          })
          files.push({ path: entry.path, content: content ?? '' })
        }
        const built = await buildGraphIncrementalOrFull({
          pool,
          installationId: claim.installation_id!,
          repositoryId: snapshot.repositoryId,
          currentSnapshotId: snapshotId,
          entries,
          files,
          parse,
        })
        const graph = built.graph
        incremental = built.incremental ? 'true' : 'false'

        const verdict = validateGraphCandidate(graph)
        if (!verdict.ok) {
          throw new GraphBuildFenceError(`validation_failed:${verdict.errors[0] ?? 'unknown'}`)
        }

        const coverage = graph.coverage.summary.unsupported > 0 || graph.edges.some(edge => edge.resolution !== 'resolved')
          ? 'partial' as const
          : 'complete' as const

        const activation = await pool.connect()
        try {
          await activation.query('BEGIN')
          await recheckFence(activation, fence)
          const generation = await graphs.nextGeneration({
            installationId: claim.installation_id!,
            repositoryId: snapshot.repositoryId,
            client: activation,
          })
          const candidate = await graphs.persistCandidate({
            installationId: claim.installation_id!,
            repositoryId: snapshot.repositoryId,
            snapshotId,
            generation,
            graph,
            coverage,
            client: activation,
          })
          await wikiStale.markForGraphActivation({
            installationId: claim.installation_id!,
            repositoryId: snapshot.repositoryId,
            graphVersionId: candidate.graphVersionId,
            snapshotId,
            client: activation,
          })
          await graphs.activateHead({
            installationId: claim.installation_id!,
            repositoryId: snapshot.repositoryId,
            graphVersionId: candidate.graphVersionId,
            client: activation,
          })
          await graphs.markSnapshotState({
            installationId: claim.installation_id!,
            snapshotId,
            state: 'active',
            client: activation,
          })
          await activation.query('COMMIT')
        } catch (error) {
          await activation.query('ROLLBACK')
          throw error
        } finally {
          activation.release()
        }
        deps.metrics?.codegraphRuns.inc({ mode, result: 'succeeded', incremental })
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          client.release()
        }
      } catch (error) {
        deps.metrics?.codegraphRuns.inc({ mode, result: 'failed', incremental })
        throw error
      }
    },
  }
}

export type CodeGraphBuildService = ReturnType<typeof createCodeGraphBuildService>

/**
 * Incremental assembly with a fail-closed equivalence check (plan §3.6):
 * unchanged nodes/edges are copied from the repository's active graph for
 * the same parser version, changed blobs are collected fresh, and the merged
 * result must hash identically to a clean full rebuild — otherwise the
 * incremental publication fails closed and the full parse is used.
 */
async function buildGraphIncrementalOrFull(input: {
  pool: pg.Pool
  installationId: string
  repositoryId: string
  currentSnapshotId: string
  entries: Array<{ path: string; blobSha256: string }>
  files: Array<{ path: string; content: string }>
  parse: (input: { files: Array<{ path: string; content: string }> }) => ParsedGraph
}): Promise<{ graph: ParsedGraph; incremental: boolean }> {
  const full = input.parse({ files: input.files })
  const previous = await loadActiveGraphContext(input.pool, input.installationId, input.repositoryId, input.currentSnapshotId)
  if (!previous) return { graph: full, incremental: false }

  const changed = new Set<string>()
  const previousHashes = new Map(previous.entries.map(entry => [entry.path, entry.blobHash]))
  for (const entry of input.entries) {
    if (previousHashes.get(entry.path) !== entry.blobSha256) changed.add(entry.path)
  }
  for (const path of previousHashes.keys()) {
    if (!input.entries.some(entry => entry.path === path)) changed.add(path)
  }

  const collected = parseCodeSnapshot({
    files: input.files,
    parserVersion: PARSER_VERSION,
    collectPaths: changed,
  })
  const merged = assembleIncrementalGraph({
    previousNodes: previous.nodes,
    previousEdges: previous.edges,
    changedPaths: changed,
    collected,
  })
  const incrementalHash = canonicalGraphHash(merged.nodes, merged.edges)
  if (incrementalHash === canonicalGraphHash(full.nodes, full.edges)) {
    // Incremental output is byte-identical to the full rebuild: persist the
    // full projection so coverage metadata stays complete.
    return { graph: full, incremental: true }
  }
  // Divergence (e.g. a tampered previous graph) fails closed: publish only
  // the deterministic full rebuild.
  return { graph: full, incremental: false }
}

interface ActiveGraphContext {
  parserVersion: string
  nodes: import('./typescript-parser.js').ParsedNode[]
  edges: import('./typescript-parser.js').ParsedEdge[]
  entries: Array<{ path: string; blobHash: string }>
}

async function loadActiveGraphContext(
  pool: pg.Pool,
  installationId: string,
  repositoryId: string,
  excludeSnapshotId: string,
): Promise<ActiveGraphContext | null> {
  const version = await graphPoolQueryOne(pool, `
    SELECT v.graph_version_id::text, v.parser_version, v.snapshot_id::text
    FROM memory_code_graph_versions v
    JOIN memory_code_graph_heads h
      ON h.installation_id = v.installation_id
     AND h.active_graph_version_id = v.graph_version_id
    WHERE v.installation_id = $1 AND v.repository_id = $2 AND v.snapshot_id <> $3
  `, [installationId, repositoryId, excludeSnapshotId])
  if (!version) return null
  if (version.parser_version !== PARSER_VERSION) return null

  const nodes = await graphPoolQuery(pool, `
    SELECT node_id, kind, stable_key, path, name, symbol_kind,
           start_line, start_column, end_line, end_column, metadata
    FROM memory_code_nodes WHERE graph_version_id = $1
  `, [version.graph_version_id])
  const edges = await graphPoolQuery(pool, `
    SELECT e.edge_id, e.kind, n1.stable_key AS from_stable_key, n2.stable_key AS to_stable_key,
           e.source_path, e.source_line, e.resolution, e.metadata
    FROM memory_code_edges e
    JOIN memory_code_nodes n1 ON n1.graph_version_id = e.graph_version_id AND n1.node_id = e.from_node_id
    JOIN memory_code_nodes n2 ON n2.graph_version_id = e.graph_version_id AND n2.node_id = e.to_node_id
    WHERE e.graph_version_id = $1
  `, [version.graph_version_id])
  const entries = await graphPoolQuery(pool, `
    SELECT path, blob_hash FROM memory_source_snapshot_entries WHERE snapshot_id = $1
  `, [version.snapshot_id])

  return {
    parserVersion: version.parser_version,
    nodes: nodes.map((node: Record<string, unknown>) => ({
      nodeId: String(node.node_id),
      kind: node.kind as never,
      stableKey: node.stable_key as string,
      path: (node.path ?? null) as string | null,
      name: node.name as string,
      ...(node.symbol_kind ? { symbolKind: node.symbol_kind as string } : {}),
      ...(node.start_line ? { startLine: Number(node.start_line) } : {}),
      ...(node.start_column ? { startColumn: Number(node.start_column) } : {}),
      ...(node.end_line ? { endLine: Number(node.end_line) } : {}),
      ...(node.end_column ? { endColumn: Number(node.end_column) } : {}),
      metadata: (node.metadata ?? {}) as Record<string, unknown>,
    })),
    edges: edges.map((edge: Record<string, unknown>) => ({
      edgeId: String(edge.edge_id),
      kind: edge.kind as never,
      fromStableKey: edge.from_stable_key as string,
      toStableKey: edge.to_stable_key as string,
      sourcePath: edge.source_path as string,
      ...(edge.source_line ? { sourceLine: Number(edge.source_line) } : {}),
      resolution: edge.resolution as never,
      metadata: (edge.metadata ?? {}) as Record<string, unknown>,
    })),
    entries: entries.map((entry: Record<string, unknown>) => ({
      path: entry.path as string,
      blobHash: entry.blob_hash as string,
    })),
  }
}
