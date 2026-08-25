import type pg from 'pg'
import type { JobClaim } from '../jobs/types.js'
import { compileEpisode, summarizeEvents, type TerminalOutcome } from './compiler.js'
import {
  buildEpisodePacket,
  canonicalPacketJson,
  DEFAULT_PACKET_BUDGET,
  EPISODE_PACKET_COMPILER_VERSION,
  type PacketRepositoryFact,
  type PacketSourceArtifact,
  type PacketSourceEvent,
} from './packet.js'
import { PACKET_POLICY_VERSION } from './content-policy.js'

/**
 * compile_episode job handler: gathers the terminal turn's source events and
 * artifacts, compiles the deterministic episode, and (when the source digest
 * or packet compiler version changed) the bounded Episode Packet. Re-runs are
 * idempotent — same facts, same episode row, same packet bytes, and never a
 * duplicate extraction job for identical input.
 */
export function createEpisodeRepository(
  pool: pg.Pool,
  options: { stabilizationMs?: number; extractionMaxChars?: number } = {},
) {
  const stabilizationMs = options.stabilizationMs ?? 30_000

  const repository = {
    async compileTurn(installationId: string, turnId: string): Promise<void> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          // Cheap early fence: skip work for installations already fenced by
          // a purge (or missing from the registry).
          const status = await client.query<{ local_status: string }>(`
            SELECT local_status FROM memory_installations
            WHERE installation_id = $1
          `, [installationId])
          const localStatus = status.rows[0]?.local_status
          if (!localStatus || FENCED_STATUSES.has(localStatus)) {
            await client.query('COMMIT')
            return
          }

          const turn = await client.query<{
            session_id: string
            state: string
            reason: string | null
            started_at: Date | null
            terminal_at: Date | null
            event_count: string
          }>(`
            SELECT session_id, state, reason, started_at, terminal_at, event_count::text
            FROM source_turns
            WHERE installation_id = $1 AND turn_id = $2
          `, [installationId, turnId])
          const row = turn.rows[0]
          if (!row || !row.terminal_at || !isTerminal(row.state)) {
            await client.query('COMMIT')
            return
          }

          const events = await client.query<{
            source_event_id: string
            event_type: string
            occurred_at: Date
            payload_hash: Buffer
            classification: Record<string, unknown>
            payload: Record<string, unknown>
          }>(`
            SELECT source_event_id::text, event_type, occurred_at, payload_hash,
                   classification, payload
            FROM source_events
            WHERE installation_id = $1 AND turn_id = $2
            ORDER BY occurred_at, source_event_id
          `, [installationId, turnId])
          const counts = summarizeEvents(events.rows.map(eventRow => ({
            event_type: eventRow.event_type,
            classification: eventRow.classification ?? {},
            data: eventRow.payload ?? {},
          })))

          const artifacts = await client.query<{
            artifact_id: string
            source_event_id: string
            artifact_type: string
            identity_key: string
            path: string | null
            status: string | null
            details: Record<string, unknown>
          }>(`
            SELECT artifact_id::text, source_event_id::text, artifact_type,
                   identity_key, path, status, details
            FROM source_artifacts
            WHERE installation_id = $1 AND turn_id = $2
          `, [installationId, turnId])
          const artifactCounts: Record<string, number> = {}
          let artifactTotal = 0
          for (const artifact of artifacts.rows) {
            artifactCounts[artifact.artifact_type] = (artifactCounts[artifact.artifact_type] ?? 0) + 1
            artifactTotal++
          }

          const episode = compileEpisode({
            installationId,
            sessionId: row.session_id,
            turnId,
            outcome: row.state as TerminalOutcome,
            reason: row.reason,
            startedAt: row.started_at ?? row.terminal_at,
            terminalAt: row.terminal_at,
            eventCount: Number(row.event_count),
            artifactCounts,
            eventTypeCounts: counts.eventTypeCounts,
            classificationDistribution: counts.classificationDistribution,
            toolErrorCount: counts.toolErrorCount,
            retryCount: counts.retryCount,
            correctionCount: counts.correctionCount,
            stabilizationMs,
          })

          // Repository identity reuses only Phase 0 facts recorded for this
          // turn's events — never cwd or absolute-path guesses.
          const repositoryFact = await client.query<{
            repository_id: string
            repo_snapshot_id: string | null
            commit_sha: string | null
            branch: string | null
            worktree_identity: string | null
          }>(`
            SELECT r.repository_id::text, rs.repo_snapshot_id::text, rs.commit_sha,
                   rs.branch, rs.worktree_identity
            FROM repositories r
            LEFT JOIN LATERAL (
              SELECT s.repo_snapshot_id, s.commit_sha, s.branch, s.worktree_identity
              FROM repo_snapshots s
              WHERE s.installation_id = r.installation_id
                AND s.repository_id = r.repository_id
                AND s.observed_at <= $3
              ORDER BY s.observed_at DESC, s.repo_snapshot_id DESC
              LIMIT 1
            ) rs ON TRUE
            WHERE r.installation_id = $1
              AND EXISTS (
                SELECT 1 FROM source_events e
                WHERE e.installation_id = $1 AND e.turn_id = $2
                  AND e.payload->>'repository_id' = r.repository_key
              )
            ORDER BY r.last_observed_at DESC, r.repository_id DESC
            LIMIT 1
          `, [installationId, turnId, row.terminal_at])
          const packetRepository: PacketRepositoryFact | null = repositoryFact.rows[0]
            ? {
              repository_id: repositoryFact.rows[0].repository_id,
              repo_snapshot_id: repositoryFact.rows[0].repo_snapshot_id,
              commit_sha: repositoryFact.rows[0].commit_sha,
              branch: repositoryFact.rows[0].branch,
              worktree_identity: repositoryFact.rows[0].worktree_identity,
            }
            : null

          const packet = buildEpisodePacket({
            installationId,
            sessionId: row.session_id,
            turnId,
            outcome: row.state,
            reason: row.reason,
            events: events.rows.map((eventRow): PacketSourceEvent => ({
              source_event_id: eventRow.source_event_id,
              event_type: eventRow.event_type,
              occurred_at: eventRow.occurred_at,
              payload_hash: eventRow.payload_hash,
              payload: eventRow.payload ?? {},
              classification: eventRow.classification ?? {},
            })),
            artifacts: artifacts.rows.map((artifact): PacketSourceArtifact => ({
              artifact_id: artifact.artifact_id,
              artifact_type: artifact.artifact_type,
              identity_key: artifact.identity_key,
              path: artifact.path,
              status: artifact.status,
              details: artifact.details ?? {},
              source_event_id: artifact.source_event_id,
            })),
            repository: packetRepository,
            budget: {
              ...DEFAULT_PACKET_BUDGET,
              totalDocumentChars: options.extractionMaxChars ?? DEFAULT_PACKET_BUDGET.totalDocumentChars,
            },
          })
          const digestHex = packet.sourceDigest.toString('hex')

          // Take the purge advisory locks BEFORE touching any row. This
          // compile and every own-transaction purge then share one order —
          // advisory → rows — so a re-compile cannot hold an episode row
          // lock while waiting for a purge that is blocked on that same row
          // (the 40P01 this ordering excludes). The projector path is the
          // exception: it already holds inbox/turn row locks when
          // purgeSessionRows takes the advisory key, but that cannot cycle
          // with a compile — a waiting compile holds no row locks at all
          // (everything above is a plain SELECT), and a lock-holding compile
          // owns only its own episode row, which the projector's purge can
          // reach only after winning the advisory key.
          await client.query(`
            SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0)),
                   pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
          `, [installationId, row.session_id])

          await client.query(`
            INSERT INTO work_episodes
              (installation_id, episode_id, session_id, turn_id, state, outcome,
               started_at, terminal_at, ready_at, event_count, artifact_count,
               correction_count, retry_count, tool_error_count, summary, compiler_version)
            VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9, $10,
                    $11, $12, $13, $14::jsonb, $15)
            ON CONFLICT (installation_id, turn_id) DO UPDATE SET
              state = EXCLUDED.state,
              outcome = EXCLUDED.outcome,
              terminal_at = EXCLUDED.terminal_at,
              ready_at = EXCLUDED.ready_at,
              event_count = EXCLUDED.event_count,
              artifact_count = EXCLUDED.artifact_count,
              correction_count = EXCLUDED.correction_count,
              retry_count = EXCLUDED.retry_count,
              tool_error_count = EXCLUDED.tool_error_count,
              summary = EXCLUDED.summary,
              compiler_version = EXCLUDED.compiler_version,
              updated_at = NOW()
          `, [
            episode.installation_id, episode.session_id, episode.turn_id,
            episode.state, episode.outcome, episode.started_at, episode.terminal_at,
            episode.ready_at, episode.event_count, artifactTotal,
            episode.correction_count, episode.retry_count, episode.tool_error_count,
            JSON.stringify(episode.summary), episode.compiler_version,
          ])

          // The packet is rewritten only when the source digest or packet
          // compiler version moved; identical input keeps the stored bytes.
          const packetWrite = await client.query<{ episode_id: string }>(`
            UPDATE work_episodes SET
              repository_id = $3,
              repo_snapshot_id = $4,
              branch = $5,
              source_digest = $6,
              document = $7::jsonb,
              evidence_manifest = $8::jsonb,
              document_compiler_version = $9,
              compiled_at = NOW()
            WHERE installation_id = $1 AND turn_id = $2
              AND (source_digest IS DISTINCT FROM $6
                   OR document_compiler_version IS DISTINCT FROM $9)
            RETURNING episode_id::text
          `, [
            installationId, turnId,
            packetRepository?.repository_id ?? null,
            packetRepository?.repo_snapshot_id ?? null,
            packetRepository?.branch ?? null,
            packet.sourceDigest,
            canonicalPacketJson(packet.document),
            JSON.stringify(packet.manifest),
            packet.compilerVersion,
          ])
          const settings = await client.query<{ extraction_mode: string | null }>(`
            SELECT extraction_mode FROM memory_feature_settings WHERE installation_id = $1
          `, [installationId])
          const extractionMode = settings.rows[0]?.extraction_mode ?? 'off'

          // Extraction jobs exist only for stable, changed packets and only
          // when the installation opted in; the digest-keyed idempotency key
          // makes identical input structurally incapable of duplicating.
          if (packetWrite.rows[0] && extractionMode !== 'off') {
            await client.query(`
              INSERT INTO memory_jobs
                (job_id, installation_id, job_type, idempotency_key, priority, payload)
              VALUES (gen_random_uuid(), $1, 'extract_candidates', $2, 85, $3::jsonb)
              ON CONFLICT DO NOTHING
            `, [
              installationId,
              `extract:${turnId}:${digestHex}`,
              JSON.stringify({
                turn_id: turnId,
                source_digest: digestHex,
                compiler_version: packet.compilerVersion,
                policy_version: PACKET_POLICY_VERSION,
              }),
            ])
          }

          // Resurrection guard. Each statement here takes a fresh READ
          // COMMITTED snapshot, so a purge that committed while this compile
          // waited for (or held) the advisory locks is visible now and rolls
          // the whole compile back; if this compile won the locks instead,
          // its episode landed before the purge's deletes, which remove it.
          const fenced = await client.query<{ tombstones: number; fenced: number }>(`
            SELECT
              (SELECT COUNT(*) FROM memory_session_tombstones
                WHERE installation_id = $1 AND session_id = $2)::int AS tombstones,
              (SELECT COUNT(*) FROM memory_installations
                WHERE installation_id = $1 AND local_status = ANY($3))::int AS fenced
          `, [installationId, row.session_id, [...FENCED_STATUSES]])
          if ((fenced.rows[0]?.tombstones ?? 0) > 0 || (fenced.rows[0]?.fenced ?? 0) > 0) {
            await client.query('ROLLBACK')
            return
          }
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async handleCompileEpisode(job: JobClaim, signal: AbortSignal): Promise<void> {
      if (!job.installation_id) return
      if (signal.aborted) throw new Error('compile_episode aborted')
      await repository.compileTurn(job.installation_id, job.idempotency_key.replace(/^compile_episode:/, ''))
    },
  }
  return repository
}

function isTerminal(state: string): boolean {
  return ['completed', 'interrupted', 'failed', 'abandoned'].includes(state)
}

/** Installation states under which no episode may be written or kept. */
const FENCED_STATUSES: ReadonlySet<string> = new Set(['purging', 'purged', 'integrity_error'])

export type EpisodeRepository = ReturnType<typeof createEpisodeRepository>
