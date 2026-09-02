import { createHash } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { createScopeAuthorization, type V2GrantFacts } from '../governance/authorization.js'
import { createTransactionBoundPool } from '../api/transaction-bound-pool.js'
import { resolvePacketEvidence } from '../claims/evidence-resolver.js'
import { redactSecrets } from '../episodes/content-policy.js'
import { canonicalJsonString, canonicalPayloadHash } from '../inbox/canonical-json.js'
import { skillModeForScope, type SkillConfig } from './config.js'
import type { MemoryMode } from '../config.js'

export const SKILL_EXTRACTION_POLICY_VERSION = 'skill-extraction.v1'
export class SkillWorkError extends Error {
  constructor(readonly code: string, readonly kind: 'transient' | 'permanent' | 'cancelled' | 'lost_lease' = 'permanent') {
    super(code); this.name = 'SkillWorkError'
  }
}
export const SkillSourceRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('episode'), episodeId: z.uuid() }).strict(),
  z.object({ kind: z.literal('claim_version'), versionId: z.uuid(), repositoryId: z.uuid(), repoSnapshotId: z.uuid() }).strict(),
])
export type SkillSourceRequest = z.infer<typeof SkillSourceRequestSchema>
export interface SkillSourcePacket {
  token: string; handle: string; excerpt: string; excerptHash: string
  kind: 'episode' | 'event' | 'artifact'
  eventId: string | null; artifactId: string | null; evidenceId: string | null
}
export interface ResolvedSkillInput {
  installationId: string; repositoryId: string; repoSnapshotId: string
  kind: 'episode' | 'claim_version'; episodeId: string | null; versionId: string | null
  sessionId: string | null; sourceDigest: string; inputDigest: string
  ownerKind: 'personal' | 'team' | 'organization'; authorizationEpoch: string
  mode: 'shadow' | 'enabled'; sources: SkillSourcePacket[]
}
export interface SkillPrelockedLifecycle { sessionIds: readonly string[]; repositoryIds: readonly string[] }
export interface SkillSourceContext {
  globalMode: MemoryMode; sharedMode: MemoryMode; config: SkillConfig
}

/** Uses the same lifecycle locks as purge/compilation; never takes user identity from the source body. */
export async function resolveSkillSource(client: pg.PoolClient, input: {
  installationId: string; grant: V2GrantFacts; source: SkillSourceRequest
  /** Internal permission selected by the service, never from request/model content. */
  requiredPermission?: 'read' | 'contribute' | 'review' | 'publish'
  /** Internal replay dependencies, acquired together with source sessions in sorted order. */
  additionalSessionIds?: readonly string[]
  /** Internal batch fence: no new lifecycle lock may be acquired after repositories are held. */
  prelockedLifecycle?: SkillPrelockedLifecycle
}, context: SkillSourceContext): Promise<ResolvedSkillInput> {
  const parsed = SkillSourceRequestSchema.safeParse(input.source)
  if (!parsed.success) throw new SkillWorkError('skill_source_invalid')
  const source = parsed.data
  // Match compilation/correction: session(s) -> installation -> repository -> rows.
  // These preliminary reads grant no authority; every fact is checked again under locks below.
  const provenance = await client.query<{ session_id: string; repository_id: string | null }>(source.kind === 'episode'
    ? `SELECT session_id,repository_id FROM work_episodes WHERE installation_id=$1 AND episode_id=$2`
    : `SELECT DISTINCT e.session_id,e.repository_id FROM knowledge_evidence k JOIN work_episodes e
        USING(installation_id,episode_id) WHERE k.installation_id=$1 AND k.version_id=$2`,
  [input.installationId, source.kind === 'episode' ? source.episodeId : source.versionId])
  const sessionIds = [...new Set([...provenance.rows.map(row => row.session_id), ...(input.additionalSessionIds ?? [])])].sort()
  const lockedRepositoryId = source.kind === 'episode' ? provenance.rows[0]?.repository_id : source.repositoryId
  if (input.prelockedLifecycle && (sessionIds.some(id => !input.prelockedLifecycle!.sessionIds.includes(id))
    || (lockedRepositoryId && !input.prelockedLifecycle.repositoryIds.includes(lockedRepositoryId)))) {
    throw new SkillWorkError('skill_source_invalid')
  }
  for (const session of sessionIds) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:session:' || $1 || ':' || $2,0))`,
      [input.installationId, session])
  }
  await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:' || $1,0))`, [input.installationId])
  if (lockedRepositoryId) await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:repository:' || $1 || ':' || $2,0))`,
      [input.installationId, lockedRepositoryId])
  // Lock the scope/membership rows until the caller commits its output.
  await client.query('SELECT 1 FROM memory_owner_scopes WHERE installation_id=ANY($1::uuid[]) FOR SHARE',
    [input.grant.scopeBindings.map(binding => binding.installation_id)])
  await client.query('SELECT 1 FROM memory_scope_memberships WHERE membership_id=ANY($1::uuid[]) FOR SHARE',
    [input.grant.scopeBindings.map(binding => binding.membership_id).filter(Boolean)])
  const authorization = createScopeAuthorization(createTransactionBoundPool(client))
  const grant = await authorization.validateV2Grant(input.grant)
  const binding = grant?.scopeBindings.find(row => row.installation_id === input.installationId)
  if (!binding || !binding.permissions.includes(input.requiredPermission ?? 'contribute')) throw new SkillWorkError('skill_forbidden')
  const installation = await client.query(`SELECT 1 FROM memory_installations
    WHERE installation_id=$1 AND relay_status='active'
      AND local_status NOT IN ('purging','purged','integrity_error') FOR SHARE`, [input.installationId])
  if (!installation.rowCount) throw new SkillWorkError('skill_forbidden')
  const mode = skillModeForScope(context.globalMode, context.config.mode, context.sharedMode, binding.owner_scope_kind)
  if (mode === 'off') throw new SkillWorkError('skill_disabled', 'cancelled')

  let repositoryId: string, repoSnapshotId: string, episodeId: string | null = null
  let sessionId: string | null = null, versionId: string | null = null, sourceDigest: string
  let packets: SkillSourcePacket[]
  if (source.kind === 'episode') {
    // Governance's synthetic episodes are not completed natural Sessions.
    if (binding.owner_scope_kind !== 'personal') throw new SkillWorkError('skill_shared_episode_denied')
    if (!lockedRepositoryId) throw new SkillWorkError('skill_source_invalid')
    const session = await client.query<{ session_id: string }>(`SELECT session_id FROM work_episodes
      WHERE installation_id=$1 AND episode_id=$2`, [input.installationId, source.episodeId])
    if (!session.rows[0]) throw new SkillWorkError('skill_source_invalid')
    sessionId = session.rows[0].session_id
    if (!sessionIds.includes(sessionId)) throw new SkillWorkError('skill_source_invalid')
    const rows = await client.query<{
      repository_id: string; repo_snapshot_id: string; document: Record<string, unknown>
      evidence_manifest: Record<string, Record<string, unknown>>; source_digest: Buffer
    }>(`SELECT e.repository_id, e.repo_snapshot_id, e.document, e.evidence_manifest, e.source_digest
      FROM work_episodes e JOIN source_sessions s USING (installation_id,session_id)
      WHERE e.installation_id=$1 AND e.episode_id=$2 AND e.state='ready' AND e.outcome='completed'
        AND e.compiled_at IS NOT NULL AND e.ready_at <= NOW() AND s.deleted_at IS NULL
        AND e.repository_id IS NOT NULL AND e.repo_snapshot_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM memory_session_tombstones t
          WHERE t.installation_id=e.installation_id AND t.session_id=e.session_id)
      FOR SHARE OF e,s`, [input.installationId, source.episodeId])
    const row = rows.rows[0]
    if (!row || row.source_digest?.length !== 32) throw new SkillWorkError('skill_source_invalid')
    repositoryId = row.repository_id; repoSnapshotId = row.repo_snapshot_id; episodeId = source.episodeId
    if (repositoryId !== lockedRepositoryId) throw new SkillWorkError('skill_source_invalid')
    sourceDigest = row.source_digest.toString('hex')
    const manifest = row.evidence_manifest
    const handles = Object.entries(manifest).filter(([, entry]) => entry && entry.omitted !== true
      && entry.truncated !== true && typeof entry.excerpt_length === 'number' && entry.excerpt_length > 0).map(([handle]) => handle).sort()
    if (!handles.length || handles.length > 64) throw new SkillWorkError('skill_evidence_invalid')
    const evidence = resolvePacketEvidence(row.document, manifest, handles)
    packets = evidence.map((item, index) => {
      const entry = manifest[item.handle]!
      const expectedHash = createHash('sha256').update(item.excerpt).digest('hex').slice(0, 16)
      if (entry.excerpt_hash !== expectedHash || entry.excerpt_length !== item.excerpt.length) {
        throw new SkillWorkError('skill_evidence_invalid')
      }
      return { token: `source-${index + 1}`, handle: item.handle, excerpt: item.excerpt, excerptHash: expectedHash,
        kind: item.manifest.kind, eventId: item.manifest.source_event_id ?? null,
        artifactId: item.manifest.artifact_id ?? null, evidenceId: null }
    })
    if (packets.length !== handles.length) throw new SkillWorkError('skill_evidence_invalid')
    // Value admission uses evidenced test success, not traffic/byte counts or a model flag.
    const tests = Array.isArray(row.document.tests) ? row.document.tests : []
    if (!tests.some(test => test && typeof test === 'object' && test.status === 'passed'
      && packets.some(packet => packet.handle === test.evidence_handle))) throw new SkillWorkError('skill_value_unproven')
  } else {
    repositoryId = source.repositoryId; repoSnapshotId = source.repoSnapshotId; versionId = source.versionId
    const rows = await client.query<{
      statement: string; structured_content: unknown; claim_id: string; repository_id: string | null
      repo_snapshot_id: string | null; scope_kind: string; scope_key: string; repository_key: string
    }>(`SELECT v.statement,v.structured_content,c.claim_id,v.repository_id,v.repo_snapshot_id,
        c.scope_kind,c.scope_key,r.repository_key
      FROM knowledge_versions v JOIN knowledge_claims c USING (installation_id,claim_id)
      JOIN repositories r ON r.installation_id=v.installation_id AND r.repository_id=$3
      WHERE v.installation_id=$1 AND v.version_id=$2 AND c.current_version_id=v.version_id AND c.state='active'
        AND c.owner_scope_kind=$4 AND c.owner_scope_id=$5
        AND c.claim_type IN ('work_method','operational_runbook','reusable_skill_candidate')
        AND c.conflict_group_id IS NULL
        AND (v.valid_until IS NULL OR v.valid_until>NOW()) AND (v.valid_from IS NULL OR v.valid_from<=NOW())
        AND (($4='personal' AND v.authority IN ('user_accepted','user_corrected')) OR
          ($4<>'personal' AND v.source_promotion_candidate_id IS NOT NULL AND EXISTS
            (SELECT 1 FROM memory_authority_records a WHERE a.installation_id=v.installation_id AND a.version_id=v.version_id)))
      FOR SHARE OF c,v`, [input.installationId, versionId, repositoryId, binding.owner_scope_kind, binding.owner_scope_id])
    const row = rows.rows[0]
    if (!row || (row.repository_id ? row.repository_id !== repositoryId
      : row.scope_kind !== 'repository' || ![repositoryId, row.repository_key].includes(row.scope_key))
      || (row.repo_snapshot_id && row.repo_snapshot_id !== repoSnapshotId)) throw new SkillWorkError('skill_claim_scope_invalid')
    const evidence = await client.query<{
      evidence_id: string; evidence_kind: 'event' | 'artifact' | 'episode'; excerpt: string
      excerpt_hash: Buffer; source_event_id: string | null; artifact_id: string | null; session_id: string
    }>(`SELECT k.evidence_id,k.evidence_kind,k.excerpt,k.excerpt_hash,k.source_event_id,k.artifact_id,e.session_id
      FROM knowledge_evidence k JOIN work_episodes e USING(installation_id,episode_id)
      LEFT JOIN source_sessions s USING(installation_id,session_id)
      WHERE k.installation_id=$1 AND k.version_id=$2 AND k.visibility=$3
        AND ($3='shared' OR (s.session_id IS NOT NULL AND s.deleted_at IS NULL))
        AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones t WHERE t.installation_id=k.installation_id AND t.session_id=e.session_id)
      ORDER BY k.ordinal FOR SHARE OF k,e`,
    [input.installationId, versionId, binding.owner_scope_kind === 'personal' ? 'personal' : 'shared'])
    if (!evidence.rows.length || evidence.rows.length > 64) throw new SkillWorkError('skill_evidence_invalid')
    packets = evidence.rows.map((e, index) => {
      if (!sessionIds.includes(e.session_id)) throw new SkillWorkError('skill_source_invalid')
      const hash = createHash('sha256').update(e.excerpt).digest('hex')
      if (hash !== e.excerpt_hash.toString('hex')) throw new SkillWorkError('skill_evidence_invalid')
      return { token: `source-${index + 1}`, handle: `claim:${e.evidence_id}`, excerpt: e.excerpt,
        excerptHash: hash, kind: e.evidence_kind, eventId: e.source_event_id, artifactId: e.artifact_id, evidenceId: e.evidence_id }
    })
    sourceDigest = canonicalPayloadHash({ versionId, statement: row.statement, content: row.structured_content, packets }).toString('hex')
  }
  const snapshot = await client.query(`SELECT 1 FROM repo_snapshots s JOIN repositories r USING (installation_id,repository_id)
    WHERE s.installation_id=$1 AND s.repository_id=$2 AND s.repo_snapshot_id=$3
      AND NOT EXISTS (SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id)
      AND NOT EXISTS (SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha)
    FOR SHARE OF s,r`, [input.installationId, repositoryId, repoSnapshotId])
  if (!snapshot.rowCount) throw new SkillWorkError('skill_snapshot_invalid')
  const serialized = canonicalJsonString(packets)
  if (serialized.length > context.config.maxInputChars) throw new SkillWorkError('skill_input_size_exceeded')
  if (packets.some(packet => redactSecrets(packet.excerpt) !== packet.excerpt)) throw new SkillWorkError('skill_secret_detected')
  const identity = { installationId: input.installationId, repositoryId, repoSnapshotId, kind: source.kind,
    episodeId, versionId, sessionId, sourceDigest, ownerKind: binding.owner_scope_kind,
    authorizationEpoch: binding.authorization_epoch, mode, sources: packets }
  return { ...identity, inputDigest: canonicalPayloadHash({ ...identity, policyVersion: SKILL_EXTRACTION_POLICY_VERSION }).toString('hex') }
}
