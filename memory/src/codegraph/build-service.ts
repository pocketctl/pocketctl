import { createHash } from 'node:crypto'
import {assertJobFence,StaleJobFenceError} from '../generation/fence.js'
import type pg from 'pg'
import {requireSourceAuthority,lockSourceSnapshot,SourceLifecycleFenceError} from './lifecycle.js'

import { JobTerminalError, type JobClaim, type JobFence } from '../jobs/types.js'
import { computeManifestHash, createSourceRepository } from './source-repository.js'
import { createGraphRepository } from './graph-repository.js'
import {
  PARSER_VERSION,
  type ParsedGraph,
} from './typescript-parser.js'
import { validateGraphCandidate } from './validator.js'
import { createWikiStaleService } from '../wiki/stale-service.js'
import type { Phase4Metrics } from '../metrics.js'
import { CodeGraphParseError, parseCodeSnapshotIsolated } from './isolated-parser.js'

/**
 * Phase 4 parse job service (ADR-0006 §4): `parse_code_snapshot` builds the
 * deterministic graph candidate, validates it, and activates the head inside
 * one fenced transaction. A lost lease, tombstone, non-ready snapshot, or
 * validator failure keeps the previous active graph untouched.
 */

export class GraphBuildFenceError extends JobTerminalError {
  constructor(readonly code: string) {
    super(`codegraph_${code.startsWith('validation_failed:') ? 'validation_failed' : code}`)
    this.name = 'GraphBuildFenceError'
  }
}

export interface CodeGraphBuildDeps {
  pool: pg.Pool
  parse?: (input: { files: Array<{ path: string; content: string }> }) => ParsedGraph | Promise<ParsedGraph>
  metrics?: Phase4Metrics
  mode?: 'shadow' | 'enabled'
}

export function createCodeGraphBuildService(deps: CodeGraphBuildDeps) {
  const pool = deps.pool
  const sources = createSourceRepository(pool)
  const graphs = createGraphRepository(pool)
  const wikiStale = createWikiStaleService(pool)
  const parse = (input: { files: Array<{ path: string; content: string }> }, signal: AbortSignal) =>
    deps.parse ? deps.parse(input) : parseCodeSnapshotIsolated({ ...input, parserVersion: PARSER_VERSION }, { signal })

  async function recheckFence(client: pg.PoolClient, fence: JobFence): Promise<void> {
    try{await assertJobFence(client,fence)}catch(error){
      if(error instanceof StaleJobFenceError)throw new GraphBuildFenceError('job_fence_lost')
      throw error
    }
  }

  return {
    async handleParseCodeSnapshot(
      claim: JobClaim,
      signal: AbortSignal,
      ctx?: { fence: JobFence },
    ): Promise<void> {
      const incremental = 'false'
      const mode = deps.mode ?? 'shadow'
      try {
        const fence = ctx?.fence
        if (!fence) throw new GraphBuildFenceError('job_fence_missing')

        const snapshotId = typeof claim.payload?.snapshot_id === 'string'
          ? claim.payload.snapshot_id : claim.idempotency_key.split(':')[1]
        if(!snapshotId){
          // Malformed payloads cannot write. Preserve the lost-job result for stale replays.
          const current=await pool.query(`SELECT 1 FROM memory_jobs WHERE job_id=$1 AND state='running' AND claimed_by=$2 AND claim_epoch=$3`,[fence.jobId,fence.claimedBy,fence.claimEpoch])
          if(!current.rows[0])throw new GraphBuildFenceError('job_fence_lost')
          throw new GraphBuildFenceError('payload_missing')
        }
        const withSource = async <T>(work:(client:pg.PoolClient,snapshot:NonNullable<Awaited<ReturnType<typeof sources.getSnapshot>>>)=>Promise<T>):Promise<T> => {
          signal.throwIfAborted()
          const client=await pool.connect()
          try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
            await requireSourceAuthority(client,{installationId:claim.installation_id!})
            // Serialize repository activation before the source/job/head row families.
            await lockSourceSnapshot(client,{installationId:claim.installation_id!,snapshotId},true)
            await recheckFence(client,fence)
            const snapshot=await sources.getSnapshot({installationId:claim.installation_id!,snapshotId},client)
            if(!snapshot)throw new GraphBuildFenceError('not_found')
            if(!['ready','parsing','active'].includes(snapshot.state))throw new GraphBuildFenceError(snapshot.state === 'failed' ? 'snapshot_failed' : 'not_ready')
            const result=await work(client,snapshot)
            signal.throwIfAborted()
            await recheckFence(client,fence)
            await client.query('COMMIT')
            return result
          }catch(error){await client.query('ROLLBACK');if(error instanceof SourceLifecycleFenceError)throw new GraphBuildFenceError(error.code);throw error}
          finally{client.release()}
        }
        const admission=await withSource(async(client,snapshot)=>{
          const existing=await client.query('SELECT 1 FROM memory_code_graph_versions WHERE installation_id=$1 AND snapshot_id=$2 AND parser_version=$3',[claim.installation_id!,snapshotId,PARSER_VERSION])
          if(existing.rows[0])return {snapshot,skipped:true}
          await graphs.markSnapshotState({installationId:claim.installation_id!,snapshotId,state:'parsing',client})
          return {snapshot,skipped:false}
        })
        if(admission.skipped){deps.metrics?.codegraphRuns.inc({mode,result:'skipped',incremental:'false'});return}
        const snapshot=admission.snapshot

        // Parsing happens outside the transaction: it is pure computation
        // over committed snapshot blobs.
        const entries = await sources.listEntries({
          installationId: claim.installation_id!,
          snapshotId,
        })
        const files: Array<{ path: string; content: string }> = []
        if (entries.length !== snapshot.fileCount
          || entries.reduce((total, entry) => total + entry.byteCount, 0) !== snapshot.byteCount
          || computeManifestHash(entries) !== snapshot.manifestHash) {
          throw new GraphBuildFenceError('source_integrity_mismatch')
        }
        // Bound each read to 64 files (at most 16 MiB), rather than one
        // round trip per file or an unbounded repository-wide result.
        for (let offset = 0; offset < entries.length; offset += 64) {
          signal.throwIfAborted()
          const batch = entries.slice(offset, offset + 64)
          const blobs = await sources.getBlobs({
            installationId: claim.installation_id!,
            blobHashes: [...new Set(batch.map(entry => entry.blobSha256))],
          })
          for (const entry of batch) {
            const content = blobs.get(entry.blobSha256)
            if (content === undefined || Buffer.byteLength(content) !== entry.byteCount
              || createHash('sha256').update(content).digest('hex') !== entry.blobSha256) {
              throw new GraphBuildFenceError('source_integrity_mismatch')
            }
            files.push({ path: entry.path, content })
          }
        }
        // One deterministic full parse is sufficient. The previous online
        // incremental path parsed the whole tree twice, then loaded the
        // previous graph only to compare against the full result.
        const graph = await Promise.resolve().then(() => parse({ files }, signal)).catch(async error => {
          if (error instanceof CodeGraphParseError && error.code !== 'aborted') {
            await withSource(async (client, current) => {
              if (current.state !== 'active') await graphs.markSnapshotState({
                installationId: claim.installation_id!, snapshotId, state: 'failed', client,
              })
            })
          }
          throw error
        })
        signal.throwIfAborted()

        const verdict = validateGraphCandidate(graph)
        if (!verdict.ok) {
          throw new GraphBuildFenceError(`validation_failed:${verdict.errors[0] ?? 'unknown'}`)
        }

        const coverage = snapshot.selection === null || snapshot.selection?.partial === true || graph.coverage.summary.unsupported > 0 || graph.edges.some(edge => edge.resolution !== 'resolved')
          ? 'partial' as const
          : 'complete' as const

        await withSource(async(activation,current)=>{
          if(current.repositoryId!==snapshot.repositoryId)throw new GraphBuildFenceError('source_changed')
          const existing=await activation.query('SELECT 1 FROM memory_code_graph_versions WHERE installation_id=$1 AND snapshot_id=$2 AND parser_version=$3',[claim.installation_id!,snapshotId,PARSER_VERSION])
          if(existing.rows[0])return
          const generation=await graphs.nextGeneration({installationId:claim.installation_id!,repositoryId:snapshot.repositoryId,client:activation})
          const candidate=await graphs.persistCandidate({installationId:claim.installation_id!,repositoryId:snapshot.repositoryId,snapshotId,generation,graph,coverage,client:activation,signal})
          await wikiStale.markForGraphActivation({installationId:claim.installation_id!,repositoryId:snapshot.repositoryId,graphVersionId:candidate.graphVersionId,snapshotId,client:activation})
          await graphs.activateHead({installationId:claim.installation_id!,repositoryId:snapshot.repositoryId,graphVersionId:candidate.graphVersionId,client:activation})
          await graphs.markSnapshotState({installationId:claim.installation_id!,snapshotId,state:'active',client:activation})
        })
        deps.metrics?.codegraphRuns.inc({mode,result:'succeeded',incremental})
      } catch (error) {
        deps.metrics?.codegraphRuns.inc({ mode, result: 'failed', incremental })
        throw error
      }
    },
  }
}

export type CodeGraphBuildService = ReturnType<typeof createCodeGraphBuildService>
