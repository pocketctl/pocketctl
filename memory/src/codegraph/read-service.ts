import { createHmac, timingSafeEqual } from 'node:crypto'
import type pg from 'pg'

import { analyzeImpact } from './impact-service.js'
import type { ParsedEdge, ParsedGraph, ParsedNode } from './typescript-parser.js'

function encodeCursor(repositoryId: string, stableKey: string, key: string): string {
  const payload = Buffer.from(JSON.stringify({ r: repositoryId, k: stableKey }), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function decodeCursor(cursor: string | null, repositoryId: string, key: string): string | null {
  if (!cursor) return null
  const [payload, signature, extra] = cursor.split('.')
  if (!payload || !signature || extra) throw new Error('invalid_cursor')
  const expected = createHmac('sha256', key).update(payload).digest()
  let actual: Buffer
  try { actual = Buffer.from(signature, 'base64url') } catch { throw new Error('invalid_cursor') }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid_cursor')
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { r?: unknown; k?: unknown }
    if (parsed.r !== repositoryId || typeof parsed.k !== 'string') throw new Error('invalid_cursor')
    return parsed.k
  } catch {
    throw new Error('invalid_cursor')
  }
}

export function createCodeGraphReadService(pool: pg.Pool, cursorKey: string) {
  async function metadata(installationId: string, repositoryId: string) {
    const result = await pool.query<{
      repository_id: string
      snapshot_id: string
      commit_sha: string
      graph_version_id: string
      parser_version: string
      coverage: string
      content_hash: string
      owner_scope_kind: string | null
      owner_scope_id: string | null
    }>(`
      SELECT r.repository_id::text, s.snapshot_id::text, s.commit_sha,
             g.graph_version_id::text, g.parser_version, g.coverage,
             g.content_hash, os.owner_scope_kind, os.owner_scope_id::text
      FROM repositories r
      JOIN memory_code_graph_heads h
        ON h.installation_id = r.installation_id AND h.repository_id = r.repository_id
      JOIN memory_code_graph_versions g
        ON g.installation_id = h.installation_id
       AND g.graph_version_id = h.active_graph_version_id AND g.state = 'active'
      JOIN memory_source_snapshots s
        ON s.installation_id = g.installation_id AND s.snapshot_id = g.snapshot_id
      LEFT JOIN memory_owner_scopes os ON os.installation_id = r.installation_id
      WHERE r.installation_id = $1 AND r.repository_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM memory_repository_tombstones t
          WHERE t.installation_id = r.installation_id AND t.repository_id = r.repository_id
        )
    `, [installationId, repositoryId])
    return result.rows[0] ?? null
  }

  return {
    async getGraph(input: {
      installationId: string
      repositoryId: string
      limit?: number
      cursor?: string | null
    }) {
      const head = await metadata(input.installationId, input.repositoryId)
      if (!head) return null
      const limit = Math.max(1, Math.min(100, input.limit ?? 50))
      const after = decodeCursor(input.cursor ?? null, input.repositoryId, cursorKey)
      const nodes = await pool.query(`
        SELECT node_id::text, kind, stable_key, path, name, symbol_kind,
               start_line, start_column, end_line, end_column, metadata
        FROM memory_code_nodes
        WHERE installation_id = $1 AND graph_version_id = $2
          AND ($3::text IS NULL OR stable_key > $3)
        ORDER BY stable_key LIMIT $4
      `, [input.installationId, head.graph_version_id, after, limit + 1])
      const hasMore = nodes.rows.length > limit
      const page = hasMore ? nodes.rows.slice(0, limit) : nodes.rows
      const keys = page.map(row => row.node_id)
      const edges = keys.length === 0 ? { rows: [] as Record<string, unknown>[] } : await pool.query(`
        SELECT e.edge_id::text, e.kind,
               f.stable_key AS from_stable_key, t.stable_key AS to_stable_key,
               e.source_path, e.source_line, e.resolution
        FROM memory_code_edges e
        JOIN memory_code_nodes f
          ON f.graph_version_id = e.graph_version_id AND f.node_id = e.from_node_id
        JOIN memory_code_nodes t
          ON t.graph_version_id = e.graph_version_id AND t.node_id = e.to_node_id
        WHERE e.installation_id = $1 AND e.graph_version_id = $2
          AND (e.from_node_id = ANY($3::uuid[]) OR e.to_node_id = ANY($3::uuid[]))
        ORDER BY e.kind, f.stable_key, t.stable_key LIMIT 200
      `, [input.installationId, head.graph_version_id, keys])
      const last = page.at(-1)
      return {
        repository_id: head.repository_id,
        owner_scope_kind: head.owner_scope_kind,
        owner_scope_id: head.owner_scope_id,
        snapshot_id: head.snapshot_id,
        commit_sha: head.commit_sha,
        graph_version_id: head.graph_version_id,
        parser_version: head.parser_version,
        coverage: head.coverage,
        content_hash: head.content_hash,
        nodes: page,
        edges: edges.rows,
        next_cursor: hasMore && last
          ? encodeCursor(input.repositoryId, String(last.stable_key), cursorKey)
          : null,
      }
    },

    async analyzeImpact(input: {
      installationId: string
      repositoryId: string
      entryPaths: string[]
      depth?: number
      maxNodes?: number
      maxEdges?: number
    }) {
      const head = await metadata(input.installationId, input.repositoryId)
      if (!head) return null
      const [nodes, edges, entries] = await Promise.all([
        pool.query(`
          SELECT node_id::text, kind, stable_key, path, name, symbol_kind,
                 start_line, start_column, end_line, end_column,
                 signature_hash, metadata
          FROM memory_code_nodes WHERE installation_id = $1 AND graph_version_id = $2
          ORDER BY stable_key
        `, [input.installationId, head.graph_version_id]),
        pool.query(`
          SELECT e.edge_id::text, e.kind, f.stable_key AS from_stable_key,
                 t.stable_key AS to_stable_key, e.source_path, e.source_line,
                 e.resolution, e.metadata
          FROM memory_code_edges e
          JOIN memory_code_nodes f
            ON f.graph_version_id = e.graph_version_id AND f.node_id = e.from_node_id
          JOIN memory_code_nodes t
            ON t.graph_version_id = e.graph_version_id AND t.node_id = e.to_node_id
          WHERE e.installation_id = $1 AND e.graph_version_id = $2
          ORDER BY e.kind, f.stable_key, t.stable_key
        `, [input.installationId, head.graph_version_id]),
        pool.query<{ path: string; capability: string }>(`
          SELECT path, capability FROM memory_source_snapshot_entries
          WHERE installation_id = $1 AND snapshot_id = $2
        `, [input.installationId, head.snapshot_id]),
      ])
      const parsedNodes: ParsedNode[] = nodes.rows.map(row => ({
        nodeId: row.node_id, kind: row.kind, stableKey: row.stable_key,
        path: row.path, name: row.name, ...(row.symbol_kind ? { symbolKind: row.symbol_kind } : {}),
        ...(row.start_line ? { startLine: row.start_line } : {}),
        ...(row.start_column ? { startColumn: row.start_column } : {}),
        ...(row.end_line ? { endLine: row.end_line } : {}),
        ...(row.end_column ? { endColumn: row.end_column } : {}),
        ...(row.signature_hash ? { signatureHash: row.signature_hash } : {}),
        metadata: row.metadata ?? {},
      }))
      const parsedEdges: ParsedEdge[] = edges.rows.map(row => ({
        edgeId: row.edge_id, kind: row.kind, fromStableKey: row.from_stable_key,
        toStableKey: row.to_stable_key, sourcePath: row.source_path,
        ...(row.source_line ? { sourceLine: row.source_line } : {}),
        resolution: row.resolution, metadata: row.metadata ?? {},
      }))
      const coverageFiles = Object.fromEntries(entries.rows.map(row => [
        row.path, row.capability === 'symbols_and_edges' ? 'complete' : 'file_only',
      ])) as ParsedGraph['coverage']['files']
      const graph: ParsedGraph = {
        parserVersion: head.parser_version,
        nodes: parsedNodes,
        edges: parsedEdges,
        coverage: {
          files: coverageFiles,
          summary: {
            complete: entries.rows.filter(row => row.capability === 'symbols_and_edges').length,
            fileOnly: entries.rows.filter(row => row.capability === 'file_only').length,
            unsupported: 0,
          },
        },
        contentHash: head.content_hash,
      }
      return {
        repository_id: head.repository_id,
        owner_scope_kind: head.owner_scope_kind,
        owner_scope_id: head.owner_scope_id,
        snapshot_id: head.snapshot_id,
        commit_sha: head.commit_sha,
        graph_version_id: head.graph_version_id,
        ...analyzeImpact({
          graph,
          entryPaths: input.entryPaths,
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
          ...(input.maxEdges !== undefined ? { maxEdges: input.maxEdges } : {}),
        }),
      }
    },
  }
}
