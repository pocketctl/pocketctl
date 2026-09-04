import { randomUUID } from 'crypto'
import type pg from 'pg'

import type { ParsedEdge, ParsedGraph, ParsedNode } from './typescript-parser.js'

/**
 * Phase 4 graph version repository (ADR-0006 §4): immutable candidate
 * persistence and the fenced active-head switch. All queries carry
 * installation_id; versions are never mutated after creation.
 */

export interface GraphVersionRecord {
  graphVersionId: string
  installationId: string
  repositoryId: string
  snapshotId: string
  generation: number
  parserVersion: string
  state: string
  coverage: string
  contentHash: string
}

export function createGraphRepository(pool: pg.Pool) {
  return {
    /** Serialize repository activations and derive the next monotonic generation. */
    async nextGeneration(input: {
      installationId: string
      repositoryId: string
      client: pg.PoolClient
    }): Promise<number> {
      await input.client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`codegraph-generation:${input.installationId}:${input.repositoryId}`],
      )
      const head = await input.client.query<{ revision: string }>(`
        SELECT revision::text FROM memory_code_graph_heads
        WHERE installation_id = $1 AND repository_id = $2
        FOR UPDATE
      `, [input.installationId, input.repositoryId])
      return Number(head.rows[0]?.revision ?? 0) + 1
    },

    /** Insert the immutable candidate; the generation tuple is idempotent. */
    async persistCandidate(input: {
      installationId: string
      repositoryId: string
      snapshotId: string
      generation: number
      graph: ParsedGraph
      coverage: 'complete' | 'partial' | 'unsupported' | 'degraded'
      client?: pg.PoolClient
    }): Promise<GraphVersionRecord> {
      const run = async (queryable: pg.PoolClient): Promise<GraphVersionRecord> => {
        const version = await queryable.query<GraphVersionRow>(`
          INSERT INTO memory_code_graph_versions
            (graph_version_id, installation_id, repository_id, snapshot_id, generation,
             parser_version, state, coverage, content_hash)
          VALUES ($1, $2, $3, $4, $5, $6, 'candidate', $7, $8)
          ON CONFLICT (installation_id, snapshot_id, parser_version, generation)
            DO UPDATE SET created_at = memory_code_graph_versions.created_at
          RETURNING graph_version_id::text, installation_id::text, repository_id::text,
                    snapshot_id::text, generation, parser_version, state, coverage, content_hash
        `, [
          randomUUID(), input.installationId, input.repositoryId, input.snapshotId,
          input.generation, input.graph.parserVersion, input.coverage, input.graph.contentHash,
        ])
        const record = toRecord(version.rows[0]!)

        const existingNodes = await queryable.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count FROM memory_code_nodes WHERE graph_version_id = $1
        `, [record.graphVersionId])
        if (Number(existingNodes.rows[0]!.count) === 0) {
          for (const node of input.graph.nodes) {
            await queryable.query(`
              INSERT INTO memory_code_nodes
                (graph_version_id, installation_id, node_id, kind, stable_key, path, name,
                 symbol_kind, start_line, start_column, end_line, end_column, signature_hash, metadata)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
              ON CONFLICT DO NOTHING
            `, [
              record.graphVersionId, input.installationId, node.nodeId, node.kind,
              node.stableKey, node.path, node.name, node.symbolKind ?? null,
              node.startLine ?? null, node.startColumn ?? null,
              node.endLine ?? null, node.endColumn ?? null,
              node.signatureHash ?? null, JSON.stringify(node.metadata ?? {}),
            ])
          }
          for (const edge of input.graph.edges) {
            const fromId = input.graph.nodes.find(candidate => candidate.stableKey === edge.fromStableKey)?.nodeId
            const toId = input.graph.nodes.find(candidate => candidate.stableKey === edge.toStableKey)?.nodeId
            if (!fromId || !toId) continue
            await queryable.query(`
              INSERT INTO memory_code_edges
                (graph_version_id, installation_id, edge_id, kind, from_node_id, to_node_id,
                 source_path, source_line, resolution, metadata)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
              ON CONFLICT DO NOTHING
            `, [
              record.graphVersionId, input.installationId, edge.edgeId, edge.kind,
              fromId, toId, edge.sourcePath, edge.sourceLine ?? null,
              edge.resolution, JSON.stringify(edge.metadata ?? {}),
            ])
          }
        }
        return record
      }
      if (input.client) return run(input.client)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const record = await run(client)
        await client.query('COMMIT')
        return record
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },

    async getActiveHead(input: {
      installationId: string
      repositoryId: string
    }): Promise<{ graphVersionId: string; revision: number } | null> {
      const result = await pool.query<{ active_graph_version_id: string; revision: string }>(`
        SELECT active_graph_version_id::text, revision::text
        FROM memory_code_graph_heads
        WHERE installation_id = $1 AND repository_id = $2
      `, [input.installationId, input.repositoryId])
      if (!result.rows[0]) return null
      return {
        graphVersionId: result.rows[0]!.active_graph_version_id,
        revision: Number(result.rows[0]!.revision),
      }
    },

    /**
     * Fenced activation: supersede the previous active version, activate the
     * candidate, and advance the head revision — all inside the caller's
     * transaction after every fence recheck has passed.
     */
    async activateHead(input: {
      installationId: string
      repositoryId: string
      graphVersionId: string
      client: pg.PoolClient
    }): Promise<number> {
      await input.client.query(`
        UPDATE memory_source_snapshots s
        SET state = 'superseded'
        WHERE s.installation_id = $1 AND s.state = 'active'
          AND s.snapshot_id IN (
            SELECT snapshot_id FROM memory_code_graph_versions
            WHERE installation_id = $1 AND repository_id = $2 AND state = 'active'
          )
      `, [input.installationId, input.repositoryId])
      await input.client.query(`
        UPDATE memory_code_graph_versions
        SET state = 'superseded'
        WHERE installation_id = $1 AND repository_id = $2 AND state = 'active'
      `, [input.installationId, input.repositoryId])
      await input.client.query(`
        UPDATE memory_code_graph_versions
        SET state = 'active', activated_at = NOW()
        WHERE installation_id = $1 AND graph_version_id = $2 AND state = 'candidate'
      `, [input.installationId, input.graphVersionId])
      const head = await input.client.query<{ revision: string }>(`
        INSERT INTO memory_code_graph_heads
          (installation_id, repository_id, active_graph_version_id, revision)
        VALUES ($1, $2, $3, 1)
        ON CONFLICT (installation_id, repository_id) DO UPDATE SET
          active_graph_version_id = EXCLUDED.active_graph_version_id,
          revision = memory_code_graph_heads.revision + 1,
          updated_at = NOW()
        RETURNING revision::text
      `, [input.installationId, input.repositoryId, input.graphVersionId])
      return Number(head.rows[0]!.revision)
    },

    async markSnapshotState(input: {
      installationId: string
      snapshotId: string
      state: 'parsing' | 'active' | 'failed'
      client: pg.PoolClient
    }): Promise<void> {
      await input.client.query(`
        UPDATE memory_source_snapshots
        SET state = $3
        WHERE installation_id = $1 AND snapshot_id = $2
      `, [input.installationId, input.snapshotId, input.state])
    },
  }
}

export type GraphRepository = ReturnType<typeof createGraphRepository>

interface GraphVersionRow {
  graph_version_id: string
  installation_id: string
  repository_id: string
  snapshot_id: string
  generation: string | number
  parser_version: string
  state: string
  coverage: string
  content_hash: string
}

function toRecord(row: GraphVersionRow): GraphVersionRecord {
  return {
    graphVersionId: row.graph_version_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    snapshotId: row.snapshot_id,
    generation: Number(row.generation),
    parserVersion: row.parser_version,
    state: row.state,
    coverage: row.coverage,
    contentHash: row.content_hash,
  }
}

export type { ParsedEdge, ParsedNode, ParsedGraph }
