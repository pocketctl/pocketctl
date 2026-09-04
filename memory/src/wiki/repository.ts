import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import { JOB_PRIORITIES } from '../jobs/types.js'
import type { WikiSourceBindingKind } from './types.js'

export interface ScheduledWikiBuild {
  wikiId: string
  runId: string
  generation: number
  snapshotId: string
  graphVersionId: string
}

export interface WikiBuildSource {
  sourceToken: string
  ordinal: number
  sourceKind: WikiSourceBindingKind
  stableKey: string
  sourceRefId: string
  sourceSnapshotId: string
  commitSha: string
  path: string | null
  contentHash: string
  excerpt: string | null
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Persistence boundary for serialized Wiki builds and their captured inputs. */
export function createWikiRepository(pool: pg.Pool) {
  return {
    async scheduleBuild(input: {
      installationId: string
      repositoryId: string
      expectedGeneration?: number
    }): Promise<ScheduledWikiBuild> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const repository = await client.query<{ repository_id: string }>(`
          SELECT repository_id::text FROM repositories r
          WHERE installation_id = $1 AND repository_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM memory_repository_tombstones t
              WHERE t.installation_id = r.installation_id
                AND t.repository_id = r.repository_id
            )
        `, [input.installationId, input.repositoryId])
        if (!repository.rows[0]) throw new Error('wiki_repository_not_found')

        const proposedWikiId = randomUUID()
        await client.query(`
          INSERT INTO memory_wikis (wiki_id, installation_id, repository_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (installation_id, repository_id) DO NOTHING
        `, [proposedWikiId, input.installationId, input.repositoryId])
        const wikiResult = await client.query<{ wiki_id: string; generation: string }>(`
          SELECT wiki_id::text, generation::text FROM memory_wikis
          WHERE installation_id = $1 AND repository_id = $2
          FOR UPDATE
        `, [input.installationId, input.repositoryId])
        const wiki = wikiResult.rows[0]
        if (!wiki) throw new Error('wiki_not_found')
        if (input.expectedGeneration !== undefined
          && Number(wiki.generation) !== input.expectedGeneration) {
          throw new Error('wiki_generation_conflict')
        }

        const existing = await client.query<{
          run_id: string
          generation: string
          source_snapshot_id: string
          graph_version_id: string
        }>(`
          SELECT run_id::text, generation::text, source_snapshot_id::text,
                 graph_version_id::text
          FROM memory_wiki_build_runs
          WHERE installation_id = $1 AND wiki_id = $2
            AND state IN ('queued','running','validating')
          ORDER BY generation DESC LIMIT 1
        `, [input.installationId, wiki.wiki_id])
        if (existing.rows[0]) {
          const row = existing.rows[0]
          await client.query('COMMIT')
          return {
            wikiId: wiki.wiki_id,
            runId: row.run_id,
            generation: Number(row.generation),
            snapshotId: row.source_snapshot_id,
            graphVersionId: row.graph_version_id,
          }
        }

        const headResult = await client.query<{
          graph_version_id: string
          snapshot_id: string
          commit_sha: string
          graph_hash: string
          snapshot_hash: string
        }>(`
          SELECT g.graph_version_id::text, g.snapshot_id::text, s.commit_sha,
                 g.content_hash AS graph_hash, s.manifest_hash AS snapshot_hash
          FROM memory_code_graph_heads h
          JOIN memory_code_graph_versions g
            ON g.installation_id = h.installation_id
           AND g.graph_version_id = h.active_graph_version_id
          JOIN memory_source_snapshots s
            ON s.installation_id = g.installation_id AND s.snapshot_id = g.snapshot_id
          WHERE h.installation_id = $1 AND h.repository_id = $2
            AND g.state = 'active' AND s.state = 'active'
            AND NOT EXISTS (
              SELECT 1 FROM memory_source_snapshot_tombstones t
              WHERE t.installation_id = s.installation_id AND t.snapshot_id = s.snapshot_id
            )
          FOR SHARE OF h, g, s
        `, [input.installationId, input.repositoryId])
        const head = headResult.rows[0]
        if (!head) throw new Error('wiki_active_graph_not_found')

        const generation = Number(wiki.generation) + 1
        const inputDigest = digest([
          input.installationId,
          input.repositoryId,
          head.snapshot_id,
          head.graph_version_id,
          head.snapshot_hash,
          head.graph_hash,
          String(generation),
        ].join('\n'))
        const runId = randomUUID()
        const generationRunId = randomUUID()
        const subjectHash = Buffer.from(digest(`wiki:${wiki.wiki_id}`), 'hex')
        const policyHash = Buffer.from(digest('wiki-build-policy:v1'), 'hex')
        await client.query(`
          INSERT INTO memory_generation_runs
            (run_id, installation_id, operation, subject_kind, subject_key_hash,
             input_digest, effective_policy_hash, state)
          VALUES ($1, $2, 'build_wiki', 'wiki', $3, $4, $5, 'queued')
        `, [generationRunId, input.installationId, subjectHash,
          Buffer.from(inputDigest, 'hex'), policyHash])
        await client.query(`
          INSERT INTO memory_wiki_build_runs
            (run_id, installation_id, wiki_id, generation, source_snapshot_id,
             graph_version_id, state, input_digest, parser_version, policy_version,
             generation_run_id)
          VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7,
                  'typescript-5.7-phase4-v1', 'wiki-build-policy:v1', $8)
        `, [runId, input.installationId, wiki.wiki_id, generation,
          head.snapshot_id, head.graph_version_id, inputDigest, generationRunId])
        await client.query(`
          UPDATE memory_wikis SET generation = $3, updated_at = NOW()
          WHERE installation_id = $1 AND wiki_id = $2
        `, [input.installationId, wiki.wiki_id, generation])
        await client.query(`
          INSERT INTO memory_jobs
            (job_id, installation_id, job_type, idempotency_key, priority, payload)
          VALUES ($1, $2, 'build_wiki', $3, $4, $5::jsonb)
        `, [randomUUID(), input.installationId,
          `build_wiki:${wiki.wiki_id}:${generation}`,
          JOB_PRIORITIES.build_wiki,
          JSON.stringify({ run_id: runId, wiki_id: wiki.wiki_id, generation })])
        await client.query('COMMIT')
        return {
          wikiId: wiki.wiki_id,
          runId,
          generation,
          snapshotId: head.snapshot_id,
          graphVersionId: head.graph_version_id,
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async captureSources(input: {
      installationId: string
      graphVersionId: string
      snapshotId: string
    }): Promise<WikiBuildSource[]> {
      const result = await pool.query<{
        node_id: string
        kind: 'file' | 'symbol'
        stable_key: string
        path: string | null
        start_line: number | null
        end_line: number | null
        commit_sha: string
        blob_hash: string | null
        utf8_content: string | null
      }>(`
        SELECT n.node_id::text, n.kind, n.stable_key, n.path,
               n.start_line, n.end_line, s.commit_sha,
               e.blob_hash, b.utf8_content
        FROM memory_code_nodes n
        JOIN memory_source_snapshots s
          ON s.installation_id = n.installation_id AND s.snapshot_id = $3
        LEFT JOIN memory_source_snapshot_entries e
          ON e.installation_id = n.installation_id
         AND e.snapshot_id = s.snapshot_id AND e.path = n.path
        LEFT JOIN memory_source_blobs b
          ON b.installation_id = e.installation_id AND b.blob_hash = e.blob_hash
        WHERE n.installation_id = $1 AND n.graph_version_id = $2
          AND n.kind IN ('file','symbol')
        ORDER BY CASE n.kind WHEN 'file' THEN 0 ELSE 1 END, n.stable_key
      `, [input.installationId, input.graphVersionId, input.snapshotId])
      return result.rows.map((row, ordinal) => {
        const signature = row.kind === 'file' && row.blob_hash
          ? row.blob_hash
          : digest([row.blob_hash ?? '', row.stable_key,
            String(row.start_line ?? ''), String(row.end_line ?? '')].join('\n'))
        return {
          sourceToken: `src_${digest(`${input.graphVersionId}\n${row.node_id}\n${row.stable_key}`).slice(0, 32)}`,
          ordinal,
          sourceKind: row.kind,
          stableKey: row.stable_key,
          sourceRefId: row.node_id,
          sourceSnapshotId: input.snapshotId,
          commitSha: row.commit_sha,
          path: row.path,
          contentHash: signature,
          excerpt: row.utf8_content?.slice(0, 4_000) ?? null,
        }
      })
    },
  }
}

export type WikiRepository = ReturnType<typeof createWikiRepository>
