import {rollupFeedbackBeforeInstallationPurge,minimizeSessionFeedback} from '../claims/feedback-policy.js'
import {cleanupRevokedSharedClaims} from '../governance/retention-service.js'
import { createHash, createHmac } from 'crypto'
import type pg from 'pg'
import {ZodError} from 'zod'
import {assertSourceGrantClock,requireSourceAuthority,lockSourceInstallation,lockSourceRepository,lockSourceSnapshotId,SourceLifecycleFenceError,type SourceMutationGrant} from '../codegraph/lifecycle.js'
import type { TombstoneHmacKey } from '../config.js'
import {claimIdentityV2,ClaimIdentityUnavailableError} from '../claims/identity.js'
import {assertClaimIdentityAvailable,projectClaimIdentity,resolveClaimApplicability,ClaimIdentityWriteError,type ClaimIdentityProjection} from '../claims/identity-writer.js'
import {captureSourceApplicability} from '../governance/applicability.js'
import type {ClaimApplicability} from '../governance/revision-bundle.js'
import type {ScopeKind} from '../claims/types.js'
import { findTombstonedNormalizedKeys, insertKnowledgeTombstones } from '../claims/tombstones.js'
import { normalizedClaimKey } from '../retrieval/query-normalizer.js'

type QueryClient = Pick<pg.PoolClient, 'query'>

interface SessionPurgeInput {
  installationId: string
  sessionId: string
  reason: string
  sourceFeedId: string | number | null
}

/**
 * Session tombstones and installation purges. Deletion order is frozen by the
 * plan (section 9): clear bodies and derived content first, record the
 * minimal fence last; installation purges commit a content-free receipt
 * locally BEFORE the Relay ack, and ack retries never restore data.
 */
export function createPurgeRepository(
  pool: pg.Pool,
  options: {
    hmacKey: string
    tombstoneHmacKeys?: readonly TombstoneHmacKey[]
    codeSnapshotRetentionDays?: number
    onInvalidated?: (scope: 'session' | 'installation', count: number) => void
  },
) {
  const tombstoneHmacKeys = options.tombstoneHmacKeys?.length
    ? options.tombstoneHmacKeys
    : [{ version: 'legacy', key: options.hmacKey }]
  const codeSnapshotRetentionDays = options.codeSnapshotRetentionDays ?? 30
  return {
    cleanupRevokedSharedClaims:(input:{limit:number})=>cleanupRevokedSharedClaims(pool,input),
    async purgeRepository(input: {
      installationId: string
      repositoryId: string
      reasonCode: string
      grant?: SourceMutationGrant
    }): Promise<{ purged: boolean }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        if(input.grant)await requireSourceAuthority(client,input,'publish')
        else await lockSourceInstallation(client,input.installationId)
        await client.query(`
          SELECT pg_advisory_xact_lock(hashtextextended('purge:repository:' || $1 || ':' || $2, 0))
        `, [input.installationId, input.repositoryId])
        const already = await client.query(`
          SELECT 1 FROM memory_repository_tombstones
          WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryId])
        if (already.rows[0]) {
          await assertSourceGrantClock(client,input)
          await client.query('COMMIT')
          return { purged: false }
        }
        const repository = await client.query(`
          SELECT 1 FROM repositories
          WHERE installation_id = $1 AND repository_id = $2 FOR UPDATE
        `, [input.installationId, input.repositoryId])
        if (!repository.rows[0]) {
          await assertSourceGrantClock(client,input)
          await client.query('COMMIT')
          return { purged: false }
        }
        await client.query(`
          INSERT INTO memory_repository_tombstones
            (installation_id, repository_id, reason_code)
          VALUES ($1, $2, $3)
        `, [input.installationId, input.repositoryId, input.reasonCode])
        await client.query(`
          UPDATE memory_generation_runs gr
          SET state = 'cancelled', error_code = 'repository_purged', completed_at = NOW()
          WHERE gr.installation_id = $1 AND gr.state IN ('queued','running')
            AND EXISTS (
              SELECT 1 FROM memory_wiki_build_runs br
              JOIN memory_wikis w
                ON w.installation_id = br.installation_id AND w.wiki_id = br.wiki_id
              WHERE br.generation_run_id = gr.run_id AND w.repository_id = $2
            )
        `, [input.installationId, input.repositoryId])
        await client.query(`
          UPDATE memory_wiki_build_runs br
          SET state = 'cancelled', error_code = 'repository_purged', completed_at = NOW()
          FROM memory_wikis w
          WHERE br.installation_id = $1 AND w.repository_id = $2
            AND w.installation_id = br.installation_id AND w.wiki_id = br.wiki_id
            AND br.state IN ('queued','running','validating','candidate')
        `, [input.installationId, input.repositoryId])
        await client.query(`
          DELETE FROM memory_jobs j
          WHERE j.installation_id = $1 AND (
            (j.job_type = 'parse_code_snapshot' AND EXISTS (
              SELECT 1 FROM memory_source_snapshots s
              WHERE s.installation_id = $1 AND s.repository_id = $2
                AND s.snapshot_id::text = j.payload->>'snapshot_id'
            )) OR
            (j.job_type = 'build_wiki' AND EXISTS (
              SELECT 1 FROM memory_wiki_build_runs br
              JOIN memory_wikis w
                ON w.installation_id = br.installation_id AND w.wiki_id = br.wiki_id
              WHERE w.repository_id = $2 AND br.run_id::text = j.payload->>'run_id'
            )))
        `, [input.installationId, input.repositoryId])
        await client.query(`
          DELETE FROM memory_wikis WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryId])
        await client.query(`
          DELETE FROM memory_source_snapshots
          WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryId])
        await deleteOrphanSourceBlobs(client,[input.installationId])
        await client.query(`
          UPDATE repositories SET canonical_remote = NULL, last_observed_at = NOW()
          WHERE installation_id = $1 AND repository_id = $2
        `, [input.installationId, input.repositoryId])
        await assertSourceGrantClock(client,input)
        await client.query('COMMIT')
        return { purged: true }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async purgeSourceSnapshot(input: {
      installationId: string
      snapshotId: string
      reasonCode: string
    }): Promise<{ purged: boolean }> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await lockSourceInstallation(client,input.installationId)
        // Skill sources use the repository fence for their exact commit snapshot.
        // Acquire it before the snapshot row so purge and Skill completion share one order.
        const observed = await client.query<{ repository_id: string }>(`SELECT repository_id FROM memory_source_snapshots WHERE installation_id=$1 AND snapshot_id=$2`, [input.installationId,input.snapshotId])
        if (observed.rows[0]) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:repository:' || $1 || ':' || $2,0))`, [input.installationId,observed.rows[0].repository_id])
        await client.query(`
          SELECT pg_advisory_xact_lock(hashtextextended('purge:snapshot:' || $1 || ':' || $2, 0))
        `, [input.installationId, input.snapshotId])
        const tombstone = await client.query(`
          SELECT 1 FROM memory_source_snapshot_tombstones
          WHERE installation_id = $1 AND snapshot_id = $2
        `, [input.installationId, input.snapshotId])
        if (tombstone.rows[0]) {
          await client.query('COMMIT')
          return { purged: false }
        }
        const snapshot = await client.query<{
          repository_id: string
          commit_sha: string
        }>(`
          SELECT repository_id::text, commit_sha FROM memory_source_snapshots
          WHERE installation_id = $1 AND snapshot_id = $2 FOR UPDATE
        `, [input.installationId, input.snapshotId])
        const row = snapshot.rows[0]
        if (!row) {
          await client.query('COMMIT')
          return { purged: false }
        }
        if(row.repository_id!==observed.rows[0]?.repository_id)throw new SourceLifecycleFenceError('source_changed')
        await client.query(`
          INSERT INTO memory_source_snapshot_tombstones
            (installation_id, snapshot_id, repository_id, commit_sha, reason_code)
          VALUES ($1, $2, $3, $4, $5)
        `, [input.installationId, input.snapshotId, row.repository_id,
          row.commit_sha, input.reasonCode])
        await client.query(`
          UPDATE memory_generation_runs gr
          SET state = 'cancelled', error_code = 'snapshot_purged', completed_at = NOW()
          WHERE gr.installation_id = $1 AND gr.state IN ('queued','running')
            AND EXISTS (
              SELECT 1 FROM memory_wiki_build_runs br
              WHERE br.generation_run_id = gr.run_id AND br.source_snapshot_id = $2
            )
        `, [input.installationId, input.snapshotId])
        await client.query(`
          DELETE FROM memory_jobs
          WHERE installation_id = $1 AND (
            payload->>'snapshot_id' = $2::text OR payload->>'run_id' IN (
              SELECT run_id::text FROM memory_wiki_build_runs
              WHERE installation_id = $1 AND source_snapshot_id = $2::uuid
            ))
        `, [input.installationId, input.snapshotId])
        await client.query(`
          DELETE FROM memory_source_snapshots
          WHERE installation_id = $1 AND snapshot_id = $2
        `, [input.installationId, input.snapshotId])
        await deleteOrphanSourceBlobs(client,[input.installationId])
        await client.query('COMMIT')
        return { purged: true }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },

    async cleanupSupersededSnapshots(input:{limit:number;now?:Date}):Promise<{snapshots:number;blobs:number}>{
      const limit=Math.max(1,Math.min(1_000,Math.floor(input.limit)))
      const client=await pool.connect()
      try{
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        // Discovery does not authorize deletion. All scopes precede repository and snapshot fences.
        const observed=await client.query<{installation_id:string;repository_id:string;snapshot_id:string}>(`
          SELECT s.installation_id,s.repository_id,s.snapshot_id FROM memory_source_snapshots s
          WHERE s.state='superseded' AND s.created_at<COALESCE($1::timestamptz,NOW())-($3*INTERVAL '1 day')
            AND NOT EXISTS(SELECT 1 FROM memory_code_graph_versions g WHERE g.installation_id=s.installation_id AND g.snapshot_id=s.snapshot_id AND g.state IN ('candidate','active'))
            AND NOT EXISTS(SELECT 1 FROM memory_wiki_versions v WHERE v.installation_id=s.installation_id AND v.source_snapshot_id=s.snapshot_id AND v.state<>'purged')
            AND NOT EXISTS(SELECT 1 FROM memory_wiki_build_runs r WHERE r.installation_id=s.installation_id AND r.source_snapshot_id=s.snapshot_id AND r.state IN ('queued','running','validating','candidate','published'))
          ORDER BY s.created_at,s.snapshot_id LIMIT $2
        `,[input.now??null,limit,codeSnapshotRetentionDays])
        const blobScopes=await client.query<{installation_id:string}>('SELECT DISTINCT installation_id FROM memory_source_blobs ORDER BY installation_id')
        const installations=[...new Set([...observed.rows.map(row=>row.installation_id),...blobScopes.rows.map(row=>row.installation_id)])].sort()
        for(const id of installations)await lockSourceInstallation(client,id)
        const repositories=[...new Map(observed.rows.map(row=>[`${row.installation_id}:${row.repository_id}`,row])).values()].sort((a,b)=>`${a.installation_id}:${a.repository_id}`.localeCompare(`${b.installation_id}:${b.repository_id}`))
        for(const row of repositories)await lockSourceRepository(client,row.installation_id,row.repository_id,true)
        const snapshots=[...observed.rows].sort((a,b)=>`${a.installation_id}:${a.snapshot_id}`.localeCompare(`${b.installation_id}:${b.snapshot_id}`))
        for(const row of snapshots)await lockSourceSnapshotId(client,row.installation_id,row.snapshot_id)
        const ids=snapshots.map(row=>row.snapshot_id)
        // Lock rows in one command; recheck all pins in a fresh READ COMMITTED command.
        const locked=await client.query<{installation_id:string;repository_id:string;snapshot_id:string}>('SELECT installation_id,repository_id,snapshot_id FROM memory_source_snapshots WHERE snapshot_id=ANY($1::uuid[]) ORDER BY installation_id,snapshot_id FOR UPDATE',[ids])
        const expected=new Map(snapshots.map(row=>[row.snapshot_id,row]))
        for(const row of locked.rows){
          const source=expected.get(row.snapshot_id)
          if(row.installation_id!==source?.installation_id||row.repository_id!==source?.repository_id)throw new SourceLifecycleFenceError('source_changed')
        }
        const deleted=await client.query(`
          DELETE FROM memory_source_snapshots s WHERE s.snapshot_id=ANY($1::uuid[])
            AND s.state='superseded' AND s.created_at<COALESCE($2::timestamptz,NOW())-($3*INTERVAL '1 day')
            AND NOT EXISTS(SELECT 1 FROM memory_code_graph_versions g WHERE g.installation_id=s.installation_id AND g.snapshot_id=s.snapshot_id AND g.state IN ('candidate','active'))
            AND NOT EXISTS(SELECT 1 FROM memory_wiki_versions v WHERE v.installation_id=s.installation_id AND v.source_snapshot_id=s.snapshot_id AND v.state<>'purged')
            AND NOT EXISTS(SELECT 1 FROM memory_wiki_build_runs r WHERE r.installation_id=s.installation_id AND r.source_snapshot_id=s.snapshot_id AND r.state IN ('queued','running','validating','candidate','published'))
          RETURNING s.snapshot_id
        `,[ids,input.now??null,codeSnapshotRetentionDays])
        const blobs=await deleteOrphanSourceBlobs(client,installations)
        await client.query('COMMIT')
        return {snapshots:deleted.rowCount??0,blobs}
      }catch(error){await client.query('ROLLBACK');throw error}
      finally{client.release()}
    },

    async purgeSession(input: SessionPurgeInput, transactionClient?: QueryClient): Promise<number> {
      if (transactionClient) {
        // The caller owns the transaction and must publish metrics only after
        // its outer COMMIT succeeds.
        return purgeSessionRows(transactionClient, input, tombstoneHmacKeys)
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const count = await purgeSessionRows(client, input, tombstoneHmacKeys)
          await client.query('COMMIT')
          options.onInvalidated?.('session', count)
          return count
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    /**
     * Purge one installation inside a single transaction: delete every
     * scoped row, keep the installation row as a `purged` fence (discovery
     * can never resurrect it), and write the receipt. Returns the receipt.
     */
    async purgeInstallation(input: {
      installationId: string
      requestId: string
      reason: string
    }, transactionClient?: QueryClient): Promise<string> {
      if (transactionClient) {
        const result = await purgeInstallationRows(transactionClient, input, options.hmacKey)
        // No callback here: the owner has not committed its outer transaction.
        return result.receipt
      }
      const existing = await pool.query<{ receipt: string }>(
        `SELECT receipt FROM memory_purge_receipts WHERE request_id = $1`,
        [input.requestId],
      )
      if (existing.rows[0]) return existing.rows[0].receipt

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          const result = await purgeInstallationRows(client, input, options.hmacKey)
          await client.query('COMMIT')
          options.onInvalidated?.('installation', result.invalidatedClaims)
          return result.receipt
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      } finally {
        client.release()
      }
    },

    async markPurgeAcked(requestId: string): Promise<void> {
      await pool.query(
        `UPDATE memory_purge_receipts SET relay_acked_at = NOW() WHERE request_id = $1`,
        [requestId],
      )
    },

    async receiptFor(requestId: string): Promise<string | null> {
      const result = await pool.query<{ receipt: string }>(
        `SELECT receipt FROM memory_purge_receipts WHERE request_id = $1`,
        [requestId],
      )
      return result.rows[0]?.receipt ?? null
    },
  }
}

/** Blob FK locks and deletes share a stable order. A fresh command after the
 * locks sees uploads committed during a wait; a losing upload rolls back its
 * receipt and retries admission, never leaving an entry pointing at missing bytes. */
async function deleteOrphanSourceBlobs(client:pg.PoolClient,installationIds:readonly string[]):Promise<number>{
  const candidates=await client.query<{installation_id:string;blob_hash:string}>(`
    SELECT b.installation_id,b.blob_hash FROM memory_source_blobs b
    WHERE b.installation_id=ANY($1::uuid[]) AND NOT EXISTS(
      SELECT 1 FROM memory_source_snapshot_entries e WHERE e.installation_id=b.installation_id AND e.blob_hash=b.blob_hash)
    ORDER BY b.installation_id,b.blob_hash
  `,[installationIds])
  for(const row of candidates.rows)await client.query('SELECT 1 FROM memory_source_blobs WHERE installation_id=$1 AND blob_hash=$2 FOR UPDATE',[row.installation_id,row.blob_hash])
  const removed=await client.query(`
    DELETE FROM memory_source_blobs b USING jsonb_to_recordset($1::jsonb) AS selected(installation_id UUID,blob_hash TEXT)
    WHERE b.installation_id=selected.installation_id AND b.blob_hash=selected.blob_hash AND NOT EXISTS(
      SELECT 1 FROM memory_source_snapshot_entries e WHERE e.installation_id=b.installation_id AND e.blob_hash=b.blob_hash)
  `,[JSON.stringify(candidates.rows)])
  return removed.rowCount??0
}

async function purgeSessionRows(
  client: QueryClient,
  input: SessionPurgeInput,
  tombstoneHmacKeys: readonly TombstoneHmacKey[],
): Promise<number> {
  // Serialize against episode compilation on this session: a compile that
  // wins the lock lands before the deletes (and is removed by them); one
  // that loses waits for this commit and observes the tombstone fence.
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2, 0))
  `, [input.installationId, input.sessionId])
  // Session invalidation writes the shared consumption generation and Git
  // connection before deleting Claims. Serialize with all installation
  // writers at the existing session -> installation boundary, before triggers.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1,0))`, [input.installationId])
  await client.query(`
    INSERT INTO memory_session_tombstones
      (installation_id, session_id, reason, source_feed_id, purged_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (installation_id, session_id) DO NOTHING
  `, [input.installationId, input.sessionId, input.reason, input.sourceFeedId])

  await minimizeSessionFeedback(client,input.installationId,input.sessionId)
  // Phase 2 purge order: stop session-scoped context generation and remove
  // every pack whose turn or Evidence source belongs to the purged Session
  // before deleting the Evidence/Version joins that make that dependency
  // discoverable. This applies to delivered history too: privacy deletion
  // wins over audit-content retention.
  await client.query(`
    UPDATE memory_generation_runs
    SET state = 'cancelled', error_code = 'source_purged', completed_at = NOW()
    WHERE installation_id = $1 AND operation = 'compile_context'
      AND subject_kind = 'session'
      AND subject_key_hash = decode(md5($2), 'hex')
      AND state IN ('queued','running')
  `, [input.installationId, input.sessionId])
  await client.query(`
    DELETE FROM memory_context_packs p
    WHERE p.installation_id = $1
      AND (p.session_id = $2 OR EXISTS (
        SELECT 1
        FROM memory_context_pack_evidence pe
        JOIN knowledge_evidence e
          ON e.installation_id = pe.installation_id AND e.evidence_id = pe.evidence_id
        JOIN work_episodes w
          ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
        WHERE pe.pack_id = p.pack_id AND w.session_id = $2))
  `, [input.installationId, input.sessionId])

  // Remove only immutable Versions whose complete evidence set belongs to
  // this session. A Version with evidence from another session survives; the
  // episode delete below removes only the purged evidence rows. If the
  // current Version is deleted, retain the newest independently evidenced
  // Version; delete the Claim only when no such Version remains.
  const impacted = await client.query<{
    claim_id: string
    claim_type: string
    scope_key: string
  }>(`
      SELECT DISTINCT c.claim_id::text, c.claim_type, c.scope_key
      FROM knowledge_claims c
      JOIN knowledge_versions v
        ON v.installation_id = c.installation_id AND v.claim_id = c.claim_id
      JOIN knowledge_evidence e
        ON e.installation_id = v.installation_id AND e.version_id = v.version_id
      JOIN work_episodes w
        ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
      WHERE c.installation_id = $1 AND w.session_id = $2
      ORDER BY c.claim_id::text
  `, [input.installationId, input.sessionId])
  for (const claim of impacted.rows) {
    const locked = await client.query<{ current_version_id: string | null; scope_kind: ScopeKind;
      canonical_repository_key: string | null; normalized_key_v2: string | null }>(`
      SELECT current_version_id::text,scope_kind,canonical_repository_key,normalized_key_v2 FROM knowledge_claims
      WHERE installation_id = $1 AND claim_id = $2 FOR UPDATE
    `, [input.installationId, claim.claim_id])
    const currentVersionId = locked.rows[0]?.current_version_id ?? null
    const dependent = await client.query<{
      version_id: string; statement: string; valid_from: Date | null; valid_until: Date | null; branch: string | null; repo_snapshot_id: string | null;
      repository_id:string|null;applicability:unknown
    }>(`
      SELECT v.version_id::text, v.statement, v.valid_from, v.valid_until,v.branch,v.repo_snapshot_id::text,v.repository_id::text,v.applicability
      FROM knowledge_versions v
      WHERE v.installation_id = $1 AND v.claim_id = $2
        AND EXISTS (
          SELECT 1 FROM knowledge_evidence e
          JOIN work_episodes w
            ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
          WHERE e.installation_id = v.installation_id AND e.version_id = v.version_id
            AND w.session_id = $3
        )
        AND NOT EXISTS (
          SELECT 1 FROM knowledge_evidence e
          JOIN work_episodes w
            ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
          WHERE e.installation_id = v.installation_id AND e.version_id = v.version_id
            AND w.session_id <> $3
        )
    `, [input.installationId, claim.claim_id, input.sessionId])
    const versionIds = dependent.rows.map(row => row.version_id)
    if (versionIds.length === 0) {
      await client.query(`
        UPDATE knowledge_claims SET revision = revision + 1, updated_at = NOW()
        WHERE installation_id = $1 AND claim_id = $2
      `, [input.installationId, claim.claim_id])
      continue
    }
    const frame = locked.rows[0]
    const removedIdentities = dependent.rows.flatMap(version => {
      if (!frame) return []
      try {
        let historical:ClaimApplicability
        if(version.applicability==null){
          // Null legacy metadata alone permits the current Claim descriptor.
          // Explicit unknown/review metadata must never be silently guessed.
          historical={scopeKind:frame.scope_kind,scopeKey:claim.scope_key,canonicalRepositoryKey:frame.canonical_repository_key,
            repositoryId:version.repository_id,snapshotId:version.repo_snapshot_id,branch:version.branch,status:'verified'}
        }else{
          const frozen=version.applicability as ClaimApplicability
          historical=captureSourceApplicability({scopeKind:frozen.scopeKind,scopeKey:frozen.scopeKey,canonicalRepositoryKey:frozen.canonicalRepositoryKey,
            repositoryId:version.repository_id,snapshotId:version.repo_snapshot_id,branch:version.branch,applicability:version.applicability})
        }
        const keyV2=claimIdentityV2({...historical,claimType:claim.claim_type,statement:version.statement}).key
        return [{keyV2,legacyKey:normalizedClaimKey({claimType:claim.claim_type,scopeKey:historical.scopeKey,statement:version.statement})}]
      }
      catch(error) {if(error instanceof ClaimIdentityUnavailableError||error instanceof ZodError)return [];throw error}
    })
    const removedIdentityKeysV2=removedIdentities.map(identity=>identity.keyV2)
    // Retain the persisted current alias as well as every provable removed version's alias.
    if(currentVersionId && versionIds.includes(currentVersionId) && frame?.normalized_key_v2
      && /^[a-f0-9]{64}$/.test(frame.normalized_key_v2)) removedIdentityKeysV2.push(frame.normalized_key_v2)
    await insertKnowledgeTombstones(client, {
      installationId: input.installationId,
      normalizedKeysV2: removedIdentityKeysV2,
      normalizedKeys: [...removedIdentities.map(identity=>identity.legacyKey),...dependent.rows.map(row => normalizedClaimKey({
        claimType: claim.claim_type,
        scopeKey: claim.scope_key,
        statement: row.statement,
      }))],
      reason: 'source_purge',
      keys: tombstoneHmacKeys,
    })
    const replacement = await client.query<{
      version_id: string; statement: string; valid_until: Date | null
    }>(`
      SELECT v.version_id::text, v.statement, v.valid_until
      FROM knowledge_versions v
      WHERE v.installation_id = $1 AND v.claim_id = $2
        AND NOT (v.version_id = ANY($3::uuid[]))
        AND EXISTS (
          SELECT 1 FROM knowledge_evidence e
          JOIN work_episodes w
            ON w.installation_id = e.installation_id AND w.episode_id = e.episode_id
          WHERE e.installation_id = v.installation_id AND e.version_id = v.version_id
            AND w.session_id <> $4
        )
      ORDER BY v.version_number DESC
      LIMIT 1
    `, [input.installationId, claim.claim_id, versionIds, input.sessionId])
    if (currentVersionId && versionIds.includes(currentVersionId)) {
      if (replacement.rows[0]) {
        const removedCurrent = dependent.rows.find(row => row.version_id === currentVersionId)
        const correctionBoundaryClosedReplacement = Boolean(
          replacement.rows[0].valid_until
          && removedCurrent?.valid_from
          && replacement.rows[0].valid_until.getTime() === removedCurrent.valid_from.getTime(),
        )
        await repointClaimAfterPurge(client, {
          installationId: input.installationId,
          claimId: claim.claim_id,
          claimType: claim.claim_type,
          scopeKey: claim.scope_key,
          versionId: replacement.rows[0].version_id,
          statement: replacement.rows[0].statement,
          tombstoneHmacKeys,
          reopenValidity: correctionBoundaryClosedReplacement,
          reindex: true,
        })
      } else {
        await client.query(`
          DELETE FROM knowledge_claims WHERE installation_id = $1 AND claim_id = $2
        `, [input.installationId, claim.claim_id])
        continue
      }
    } else {
      const current = currentVersionId
        ? await client.query<{ statement: string }>(`
            SELECT statement FROM knowledge_versions
            WHERE installation_id = $1 AND version_id = $2
          `, [input.installationId, currentVersionId])
        : { rows: [] as { statement: string }[] }
      if (currentVersionId && current.rows[0]) {
        await repointClaimAfterPurge(client, {
          installationId: input.installationId,
          claimId: claim.claim_id,
          claimType: claim.claim_type,
          scopeKey: claim.scope_key,
          versionId: currentVersionId,
          statement: current.rows[0].statement,
          tombstoneHmacKeys,
          reopenValidity: false,
          reindex: false,
        })
      } else {
        await client.query(`
          UPDATE knowledge_claims SET revision = revision + 1, updated_at = NOW()
          WHERE installation_id = $1 AND claim_id = $2
        `, [input.installationId, claim.claim_id])
      }
    }
    await client.query(`
      DELETE FROM knowledge_versions
      WHERE installation_id = $1 AND claim_id = $2 AND version_id = ANY($3::uuid[])
    `, [input.installationId, claim.claim_id, versionIds])
  }
  await client.query(`
    DELETE FROM memory_candidates WHERE installation_id = $1 AND episode_id IN (
      SELECT episode_id FROM work_episodes WHERE installation_id = $1 AND session_id = $2
    )
  `, [input.installationId, input.sessionId])
  await client.query(`
    DELETE FROM memory_extraction_runs WHERE installation_id = $1 AND episode_id IN (
      SELECT episode_id FROM work_episodes WHERE installation_id = $1 AND session_id = $2
    )
  `, [input.installationId, input.sessionId])

  for (const table of [
    'work_episodes', 'source_artifacts', 'source_turns', 'source_events',
    'memory_snapshot_events',
  ]) {
    await client.query(
      `DELETE FROM ${table} WHERE installation_id = $1 AND session_id = $2`,
      [input.installationId, input.sessionId],
    )
  }
  await client.query(
    `DELETE FROM memory_feed_inbox WHERE installation_id = $1 AND session_id = $2`,
    [input.installationId, input.sessionId],
  )
  await client.query(`
    UPDATE source_sessions SET
      agent_type = NULL, daemon_id = NULL, status = NULL, cwd_observation = NULL,
      worktree_path = NULL, worktree_branch = NULL, deleted_at = NOW(),
      delete_reason = $3
    WHERE installation_id = $1 AND session_id = $2
  `, [input.installationId, input.sessionId, input.reason])
  await client.query(`
    UPDATE memory_feed_inbox SET projection_state = 'projected', projected_at = NOW()
    WHERE installation_id = $1 AND feed_id = $2
  `, [input.installationId, input.sourceFeedId ?? 0])
  return impacted.rows.length
}

async function repointClaimAfterPurge(
  client: QueryClient,
  input: {
    installationId: string
    claimId: string
    claimType: string
    scopeKey: string
    versionId: string
    statement: string
    tombstoneHmacKeys: readonly TombstoneHmacKey[]
    reopenValidity: boolean
    reindex: boolean
  },
): Promise<void> {
  const normalizedKey = normalizedClaimKey({
    claimType: input.claimType,
    scopeKey: input.scopeKey,
    statement: input.statement,
  })
  const frame = (await client.query<{identity_generation:number;normalized_key_v2:string|null;consumption_hold_reason:string|null;
    scope_kind:ScopeKind;conflict_variant:number;canonical_repository_key:string|null;branch:string|null;repository_id:string|null;repo_snapshot_id:string|null;
    applicability:unknown;structured_content:Record<string,unknown>;valid_from:Date|null;valid_until:Date|null}>(`
    SELECT c.identity_generation,c.normalized_key_v2,c.consumption_hold_reason,c.scope_kind,c.conflict_variant,c.canonical_repository_key,
      v.branch,v.repository_id::text,v.repo_snapshot_id::text,v.applicability,v.structured_content,v.valid_from,v.valid_until
    FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.claim_id=c.claim_id
    WHERE c.installation_id=$1 AND c.claim_id=$2 AND v.version_id=$3
  `,[input.installationId,input.claimId,input.versionId])).rows[0]
  let projection:ClaimIdentityProjection={generation:frame?.identity_generation===2?2:1,legacyKey:normalizedKey,
    keyV2:frame?.normalized_key_v2??null,topicKeyV2:null,duplicateDigestV2:null}
  let identityHold=frame?.consumption_hold_reason??null
  let lookupIdentityV2:string|null=null
  const applicability=frame?await resolveClaimApplicability(client,{installationId:input.installationId,scopeKind:frame.scope_kind,
    scopeKey:input.scopeKey,repositoryId:frame.repository_id,snapshotId:frame.repo_snapshot_id,branch:frame.branch,
    applicability:frame.applicability,canonicalRepositoryKey:frame.canonical_repository_key,consumptionHoldReason:frame.consumption_hold_reason}):null
  if(frame && applicability) {
    try {
      const projected=await projectClaimIdentity(client,{installationId:input.installationId,claimType:input.claimType,statement:input.statement,
        structuredContent:frame.structured_content??{},applicability,validFrom:frame.valid_from,validUntil:frame.valid_until})
      if(projected.keyV2){projection=projected;lookupIdentityV2=projected.keyV2}
      else identityHold??='identity_requires_review'
    }catch(error) {
      if(!(error instanceof ClaimIdentityWriteError)||error.code!=='identity_requires_review')throw error
      // Privacy cleanup proceeds; keep the persisted key only as a held alias.
      // Topic/duplicate mirrors cannot be proven from this historical frame.
      identityHold??='identity_requires_review'
    }
  }else identityHold??='identity_requires_review'
  // A historical pointer move is another admission of this identity. Retain
  // the irreversible v1 fence, and check a provable v2 frame even while the
  // surviving Claim still uses generation 1. Cleanup must finish, but a
  // deleted replacement must not regain an open window or an index job.
  const storedKeyVersions=(await client.query<{key_id:string}>(
    'SELECT DISTINCT key_id FROM knowledge_tombstones WHERE installation_id=$1',[input.installationId])).rows
  if(storedKeyVersions.some(row=>!input.tombstoneHmacKeys.some(key=>key.version===row.key_id))){
    // Startup validation is not a lifetime guarantee: a retained writer may
    // introduce an older key version later. Restrictive cleanup still commits,
    // but incomplete privacy proof cannot reactivate the replacement.
    identityHold='tombstone_hmac_keyring_incomplete'
  }
  const tombstoned=await findTombstonedNormalizedKeys(client,{installationId:input.installationId,normalizedKeys:[normalizedKey],
    identityV2ByNormalizedKey:lookupIdentityV2?{[normalizedKey]:[lookupIdentityV2]}:undefined,keys:input.tombstoneHmacKeys})
  if(tombstoned.has(normalizedKey))identityHold='tombstoned_identity'
  // Validate prospective reopened facts before altering validity. An alias
  // collision is a migration limit, never permission to merge different facts.
  if(input.reopenValidity&&!identityHold)projection=await projectClaimIdentity(client,{installationId:input.installationId,
    claimType:input.claimType,statement:input.statement,structuredContent:frame!.structured_content??{},applicability:applicability!,validFrom:frame!.valid_from,validUntil:null})
  let storedAlias=normalizedKey
  try{
    await assertClaimIdentityAvailable(client,{installationId:input.installationId,claimType:input.claimType,scopeKey:input.scopeKey,
      projection,excludeClaimId:input.claimId,variant:frame?.conflict_variant??0})
  }catch(error){
    if(!(error instanceof ClaimIdentityWriteError)||!['identity_conflict','identity_migration_required','identity_requires_review'].includes(error.code))throw error
    identityHold??=error.code
    storedAlias=`purged-rekey:${input.claimId}:${createHash('sha256').update(normalizedKey).digest('hex')}`
    // Held active rows remain in both staged indexes. Preserve the Version,
    // withholding duplicate mirrors until remediation can admit it.
    projection={...projection,topicKeyV2:null,duplicateDigestV2:null}
  }
  if(input.reopenValidity&&!identityHold)await client.query('UPDATE knowledge_versions SET valid_until=NULL WHERE installation_id=$1 AND version_id=$2',
    [input.installationId,input.versionId])
  await client.query(`
    UPDATE knowledge_claims
    SET current_version_id = $3, normalized_key = $4, normalized_key_v2=$5,
        consumption_hold_reason=COALESCE($6,consumption_hold_reason),
        identity_generation=GREATEST(identity_generation,$7),topic_key_v2=$8,duplicate_digest_v2=$9,
        revision = revision + 1, updated_at = NOW()
    WHERE installation_id = $1 AND claim_id = $2
  `, [input.installationId, input.claimId, input.versionId, storedAlias,projection.keyV2,identityHold,
    projection.generation,projection.topicKeyV2,projection.duplicateDigestV2])
  if (input.reindex && !identityHold) {
    await client.query(`
      INSERT INTO memory_jobs
        (job_id, installation_id, job_type, idempotency_key, priority, payload)
      VALUES (gen_random_uuid(), $1, 'index_claim_version', $2, 90, $3::jsonb)
      ON CONFLICT DO NOTHING
    `, [input.installationId, `purge-reindex:${input.claimId}:${input.versionId}`,
      JSON.stringify({ version_id: input.versionId })])
  }
}

async function purgeInstallationRows(
  client: QueryClient,
  input: { installationId: string; requestId: string; reason: string },
  hmacKey: string,
): Promise<{ receipt: string; invalidatedClaims: number }> {
  // Serialize against episode compilation anywhere in this installation
  // (see purgeSessionRows). Taken before any delete so a compile either
  // commits first and is deleted, or observes the purge's terminal state.
  await client.query(`
    SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:' || $1, 0))
  `, [input.installationId])
  await rollupFeedbackBeforeInstallationPurge(client,input.installationId)
  // Phase 4 authoritative/derived content is removed before the generic
  // repository row and before the content-free installation receipt.
  for (const table of [
    'memory_wikis',
    'memory_source_snapshots',
    'memory_repository_tombstones',
    'memory_source_snapshot_tombstones',
    'memory_source_blobs',
  ]) {
    await client.query(
      `DELETE FROM ${table} WHERE installation_id = $1`,
      [input.installationId],
    )
  }
  const invalidated = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count FROM knowledge_claims WHERE installation_id = $1
  `, [input.installationId])
  for (const table of [
    'memory_authority_records','memory_publication_delegations','memory_automation_authority_records','memory_governance_executor_principals',
    'memory_review_automation_runs','memory_review_automation_policy_heads','memory_review_automation_policies',
    'memory_session_tombstones', 'memory_dead_letters', 'memory_jobs', 'memory_usage_outbox',
    'memory_snapshot_runs', 'memory_snapshot_events', 'memory_feed_inbox',
    'knowledge_tombstones', 'memory_idempotency_keys', 'memory_feedback',
    'claim_search_documents', 'knowledge_evidence', 'knowledge_evidence_capsules', 'memory_candidates',
    'memory_extraction_runs', 'knowledge_versions', 'knowledge_claims',
    'memory_feature_settings',
    'work_episodes', 'source_artifacts', 'source_turns', 'source_events',
    'repo_snapshots', 'repositories', 'source_sessions',
    'memory_context_feedback', 'memory_context_injections',
    'memory_context_pack_evidence', 'memory_context_pack_items',
    'memory_context_packs', 'memory_retrieval_candidates',
    'memory_retrieval_trajectories',
    'memory_generation_runs',
    'memory_context_loadout_items', 'memory_context_loadouts',
    'memory_context_settings', 'memory_policy_sets',
  ]) {
    await client.query(
      `DELETE FROM ${table} WHERE installation_id = $1`,
      [input.installationId],
    )
  }
  await client.query(`
    UPDATE memory_installations
    SET local_status = 'purged', poll_owner = NULL, poll_expires_at = NULL,
        last_error_code = NULL, updated_at = NOW()
    WHERE installation_id = $1
  `, [input.installationId])
  const committedAt = new Date()
  const receipt = buildReceipt({
    hmacKey,
    requestId: input.requestId,
    installationId: input.installationId,
    reason: input.reason,
    committedAt,
  })
  const stored = await client.query<{ receipt: string }>(`
    INSERT INTO memory_purge_receipts
      (request_id, installation_id, reason, receipt, local_committed_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (request_id) DO NOTHING
    RETURNING receipt
  `, [input.requestId, input.installationId, input.reason, receipt, committedAt])
  // An existing receipt wins: always return what is actually stored so a
  // Relay ack never references a receipt that was minted but discarded.
  if (stored.rows[0]) return { receipt: stored.rows[0].receipt, invalidatedClaims: Number(invalidated.rows[0]?.count ?? 0) }
  const existing = await client.query<{ receipt: string }>(`
    SELECT receipt FROM memory_purge_receipts WHERE request_id = $1
  `, [input.requestId])
  return { receipt: existing.rows[0]?.receipt ?? receipt, invalidatedClaims: Number(invalidated.rows[0]?.count ?? 0) }
}

function buildReceipt(input: {
  hmacKey: string
  requestId: string
  installationId: string
  reason: string
  committedAt: Date
}): string {
  const digest = createHmac('sha256', input.hmacKey)
    .update(`${input.installationId}|${input.reason}|${input.committedAt.toISOString()}`)
    .digest('hex')
  return `memory-phase0:${input.requestId}:${digest}`
}

export type PurgeRepository = ReturnType<typeof createPurgeRepository>
