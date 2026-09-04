import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import type { V2GrantFacts } from '../governance/authorization.js'
import { requireGitPermission, type GitAuthorizationStamp, type GitPermission } from './authorization.js'
import { ASSET_KINDS, DigestSchema, PortableAssetSchema, RevisionSchema, type AssetKey, type PortableAsset } from './types.js'
import type { GitSyncMode, GitWriteMode } from './config.js'
import { validateAssetPaths, validateRepositoryPath } from './paths.js'
import { assetContentHash } from './codec.js'

export interface GitTargetRegistry {
  resolve(input: { installationId: string; repositoryId: string; targetId: string }): Promise<{
    provider: 'github' | 'gitlab' | 'gitee'; providerRepositoryId: string; branch: string; credentialRef: string
  } | null>
}
const id = z.uuid()
const modeFields = { syncMode: z.enum(['off','shadow','enabled']), writeMode: z.enum(['off','shadow']) }
const targetKey = { installationId: id, connectionId: id }
const CreateConnection = z.object({ installationId: id, repositoryId: id, targetId: z.string().min(1).max(256), ...modeFields }).strict()
const ReadConnection = z.object(targetKey).strict()
const ReadSnapshot = z.object({ ...targetKey, exportId: id }).strict()
const UpdateConnection = z.object({ ...targetKey, expectedGeneration: RevisionSchema.refine(value => value !== '0'),
  ...modeFields, state: z.enum(['active','disabled']) }).strict()
const MapActor = z.object({ ...targetKey, expectedGeneration: RevisionSchema.refine(value => value !== '0'),
  providerActorId: z.string().min(1).max(256), membershipId: id }).strict()
const RegisteredTarget = z.object({ provider: z.enum(['github','gitlab','gitee']), providerRepositoryId: z.string().min(1).max(256),
  branch: z.string().min(1).max(255), credentialRef: z.string().min(1).max(512) }).strict()
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error('git_invalid_request')
  return result.data
}

/** Safe for read responses: never carries credentials or raw registry configuration. */
export interface GitConnection {
  connectionId: string; installationId: string; repositoryId: string
  ownerScopeKind: 'team' | 'organization'; ownerScopeId: string
  provider: 'github' | 'gitlab' | 'gitee'; providerRepositoryId: string; targetBranch: string
  rootPath: string; syncMode: GitSyncMode; writeMode: GitWriteMode; state: 'active' | 'disabled'; generation: string
}
const connectionColumns = `connection_id AS "connectionId",installation_id AS "installationId",repository_id AS "repositoryId",
  owner_scope_kind AS "ownerScopeKind",owner_scope_id AS "ownerScopeId",provider,provider_repository_id AS "providerRepositoryId",
  target_branch AS "targetBranch",root_path AS "rootPath",sync_mode AS "syncMode",write_mode AS "writeMode",state,generation::text`

/** Caller holds Scope and source locks. Connection is last in the lifecycle lock order. */
export async function lockGitConnection(client: pg.PoolClient, installationId: string, connectionId: string, expectedGeneration?: string) {
  const result = await client.query<GitConnection>(`SELECT ${connectionColumns} FROM memory_git_connections
    WHERE installation_id=$1 AND connection_id=$2 FOR UPDATE`, [installationId, connectionId])
  const connection = result.rows[0]
  if (!connection) throw new Error('git_not_found')
  if (expectedGeneration !== undefined && connection.generation !== expectedGeneration) throw new Error('git_generation_conflict')
  return connection
}

const typedIds = (key: AssetKey) => [key.kind === 'claim' || key.kind === 'rule' ? key.id : null,
  key.kind === 'wiki' ? key.id : null, key.kind === 'skill' ? key.id : null]

/** Internal transaction primitive. The caller authorizes and locks lifecycle sources first. */
export async function bindGitAsset(client: pg.PoolClient, input: {
  installationId: string; connectionId: string; repositoryId: string; key: AssetKey; path: string
}): Promise<string> {
  validateRepositoryPath(input.path)
  parse(z.object({ kind: z.enum(ASSET_KINDS), id }).strict(), input.key)
  const existing = await client.query<{ binding_id: string; kind: string; path: string; repository_id: string }>(`SELECT binding_id,kind,path,repository_id
    FROM memory_git_asset_bindings WHERE installation_id=$1 AND connection_id=$2 AND asset_id=$3 FOR SHARE`,
  [input.installationId, input.connectionId, input.key.id])
  const row = existing.rows[0]
  if (row) {
    if (row.kind !== input.key.kind || row.path !== input.path || row.repository_id !== input.repositoryId) throw new Error('git_binding_conflict')
    return row.binding_id
  }
  const bindingId = randomUUID()
  await client.query(`INSERT INTO memory_git_asset_bindings(binding_id,installation_id,connection_id,repository_id,kind,claim_id,wiki_id,skill_id,path)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [bindingId, input.installationId, input.connectionId, input.repositoryId, input.key.kind, ...typedIds(input.key), input.path])
  return bindingId
}

export interface GitSnapshotAsset {
  asset: PortableAsset; contentHash: string; fileHash: string; fieldMap: Record<string, unknown>
}
export interface GitSnapshot {
  installationId: string; connectionId: string; exportId: string; generation: string; baseCommit: string
  sourceDigest: string; manifestHash: string; attestation: Uint8Array; assets: GitSnapshotAsset[]
}
export type GitRevisionLink = {
  installationId: string; connectionId: string; bindingId: string; key: AssetKey; versionId: string
  path: string; commitSha: string; treeSha: string
} & ({ direction: 'export'; exportId: string } | { direction: 'import'; proposalId: string })

/** Write alongside the corresponding domain version in the caller's transaction. */
export async function insertGitRevisionLink(client: pg.PoolClient, input: GitRevisionLink): Promise<string> {
  validateRepositoryPath(input.path)
  const linkId = randomUUID()
  await client.query(`INSERT INTO memory_git_revision_links(link_id,installation_id,connection_id,binding_id,kind,
    claim_id,wiki_id,skill_id,claim_version_id,wiki_version_id,skill_version_id,path,commit_sha,tree_sha,direction,export_id,proposal_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  [linkId, input.installationId, input.connectionId, input.bindingId, input.key.kind, ...typedIds(input.key),
    ...typedIds({ kind: input.key.kind, id: input.versionId }), input.path, input.commitSha, input.treeSha, input.direction,
    input.direction === 'export' ? input.exportId : null, input.direction === 'import' ? input.proposalId : null])
  return linkId
}

/** Verify real current domain heads, never a caller's claimed repository/version. */
async function requireSnapshotSource(client: pg.PoolClient, repositoryId: string, asset: PortableAsset) {
  const args = [asset.immutable.installationId, asset.key.id, asset.baseVersionId, asset.baseRevision, repositoryId]
  let result: pg.QueryResult
  if (asset.key.kind === 'claim' || asset.key.kind === 'rule') {
    result = await client.query(`SELECT 1 FROM knowledge_claims c JOIN knowledge_versions v
      ON v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id=c.current_version_id
      JOIN repositories r ON r.installation_id=c.installation_id AND r.repository_id=$5
      WHERE c.installation_id=$1 AND c.claim_id=$2 AND v.version_id=$3 AND c.revision=$4 AND c.state='active'
        AND (v.repository_id=r.repository_id OR (v.repository_id IS NULL AND c.scope_kind='repository' AND c.scope_key IN(r.repository_id::text,r.repository_key)))
      FOR SHARE OF c,v,r`, args)
  } else if (asset.key.kind === 'wiki') {
    result = await client.query(`SELECT 1 FROM memory_wikis w JOIN memory_wiki_heads h USING(installation_id,wiki_id,repository_id)
      JOIN memory_wiki_versions v ON v.installation_id=w.installation_id AND v.wiki_id=w.wiki_id AND v.wiki_version_id=h.active_version_id
      WHERE w.installation_id=$1 AND w.wiki_id=$2 AND h.active_version_id=$3 AND h.revision=$4 AND w.repository_id=$5 AND v.state='active'
      FOR SHARE OF w,h,v`, args)
  } else {
    result = await client.query(`SELECT 1 FROM memory_skills s JOIN memory_skill_heads h USING(installation_id,skill_id)
      JOIN memory_skill_tasks t USING(installation_id,task_id)
      JOIN memory_skill_versions v ON v.installation_id=s.installation_id AND v.skill_id=s.skill_id AND v.version_id=$3
      WHERE s.installation_id=$1 AND s.skill_id=$2 AND h.revision=$4 AND t.repository_id=$5 AND h.state IN('draft','reviewed')
        AND (h.current_version_id=v.version_id OR EXISTS(SELECT 1 FROM memory_skill_publication_heads p
          WHERE p.installation_id=s.installation_id AND p.skill_id=s.skill_id AND p.current_version_id=v.version_id AND p.state='active'))
      FOR SHARE OF s,h,t,v`, args)
  }
  if (!result.rowCount) throw new Error('git_source_stale')
}

/** Internal atomic writer, not an HTTP input: Task 3 readers supply authorized, signed source packets.
 * The caller holds Session/Scope/repository locks; this acquires source heads then connection.
 * Deliberately no content-only dedupe: export identity includes versions/source digest/generation.
 */
export async function insertGitSnapshot(client: pg.PoolClient, input: GitSnapshot): Promise<void> {
  parse(RevisionSchema.refine(value => value !== '0'), input.generation)
  parse(DigestSchema, input.sourceDigest); parse(DigestSchema, input.manifestHash)
  if (input.assets.length === 0 || input.assets.length > 256) throw new Error('git_snapshot_identity')
  const before = await client.query<GitConnection>(`SELECT ${connectionColumns} FROM memory_git_connections
    WHERE installation_id=$1 AND connection_id=$2`, [input.installationId, input.connectionId])
  const initial = before.rows[0]
  if (!initial) throw new Error('git_not_found')
  if (initial.generation !== input.generation) throw new Error('git_generation_conflict')
  validateAssetPaths(input.assets.map(entry => entry.asset))
  const bindings: string[] = []
  for (const { entry, index } of input.assets.map((entry, index) => ({ entry, index })).sort((a,b) => a.entry.asset.key.id.localeCompare(b.entry.asset.key.id))) {
    const asset = parse(PortableAssetSchema, entry.asset)
    if (asset.connectionId !== input.connectionId || asset.exportId !== input.exportId || asset.immutable.installationId !== input.installationId
      || asset.immutable.ownerScopeKind !== initial.ownerScopeKind || asset.immutable.ownerScopeId !== initial.ownerScopeId) throw new Error('git_snapshot_identity')
    if (assetContentHash(asset) !== entry.contentHash) throw new Error('git_snapshot_hash_mismatch')
    parse(DigestSchema, entry.fileHash)
    await requireSnapshotSource(client, initial.repositoryId, asset)
    bindings[index] = await bindGitAsset(client, { installationId: input.installationId, connectionId: input.connectionId,
      repositoryId: initial.repositoryId, key: asset.key, path: asset.path })
  }
  const connection = await lockGitConnection(client, input.installationId, input.connectionId, input.generation)
  if (connection.state !== 'active' || connection.syncMode === 'off' || connection.repositoryId !== initial.repositoryId) throw new Error('git_connection_disabled')
  await client.query(`INSERT INTO memory_git_snapshots(export_id,installation_id,connection_id,generation,base_commit,source_digest,manifest_hash,attestation,asset_count)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.exportId, input.installationId, input.connectionId, input.generation,
    input.baseCommit, input.sourceDigest, input.manifestHash, Buffer.from(input.attestation), input.assets.length])
  for (const [index, entry] of input.assets.entries()) {
    const asset = entry.asset
    await client.query(`INSERT INTO memory_git_snapshot_assets(installation_id,connection_id,export_id,binding_id,kind,claim_id,wiki_id,skill_id,
      claim_version_id,wiki_version_id,skill_version_id,path,base_revision,source_digest,content_hash,file_hash,base_document,field_map)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [input.installationId, input.connectionId, input.exportId, bindings[index], asset.key.kind, ...typedIds(asset.key),
      ...typedIds({ kind: asset.key.kind, id: asset.baseVersionId }), asset.path, asset.baseRevision, asset.sourceDigest,
      entry.contentHash, entry.fileHash, asset, entry.fieldMap])
  }
}

export function createGitRepository(options: { pool: pg.Pool; targets: GitTargetRegistry }) {
  async function transaction<T>(grant: V2GrantFacts, installationId: string, permission: GitPermission,
    run: (client: pg.PoolClient, stamp: GitAuthorizationStamp) => Promise<T>): Promise<T> {
    const client = await options.pool.connect()
    try {
      await client.query('BEGIN')
      const stamp = await requireGitPermission(client, grant, installationId, permission)
      const result = await run(client, stamp)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async function lockRepository(client: pg.PoolClient, installationId: string, repositoryId: string) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('purge:repository:' || $1 || ':' || $2,0))`, [installationId, repositoryId])
    const result = await client.query(`SELECT 1 FROM repositories WHERE installation_id=$1 AND repository_id=$2
      AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones WHERE installation_id=$1 AND repository_id=$2) FOR SHARE`, [installationId, repositoryId])
    if (!result.rowCount) throw new Error('git_not_found')
  }
  async function existing(client: pg.PoolClient, input: { installationId: string; connectionId: string; expectedGeneration: string }) {
    const initial = await client.query<{ repository_id: string }>('SELECT repository_id FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2', [input.installationId, input.connectionId])
    if (!initial.rows[0]) throw new Error('git_not_found')
    await lockRepository(client, input.installationId, initial.rows[0].repository_id)
    return lockGitConnection(client, input.installationId, input.connectionId, input.expectedGeneration)
  }
  async function audit(client: pg.PoolClient, stamp: GitAuthorizationStamp, connectionId: string, action: 'connection' | 'mapping') {
    await client.query(`INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,membership_id,membership_revision,
      authorization_epoch,action,outcome,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,'allowed','ok')`,
    [randomUUID(), stamp.installationId, connectionId, stamp.membershipId, stamp.membershipRevision, stamp.authorizationEpoch, action])
  }
  return {
    /** Internal full snapshot reader. API DTOs must project away asset.serverOnly before responding. */
    async getSnapshot(grant: V2GrantFacts, request: unknown): Promise<GitSnapshot | null> {
      const input = parse(ReadSnapshot, request)
      return transaction(grant, input.installationId, 'read', async client => {
        // One MVCC statement prevents returning a partial baseline when a source
        // deletion removes the complete snapshot between separate reads.
        const snapshot = await client.query<GitSnapshot>(`SELECT s.installation_id AS "installationId",s.connection_id AS "connectionId",
          s.export_id AS "exportId",s.generation::text,s.base_commit AS "baseCommit",s.source_digest AS "sourceDigest",s.manifest_hash AS "manifestHash",s.attestation,
          jsonb_agg(jsonb_build_object('asset',a.base_document,'contentHash',a.content_hash,'fileHash',a.file_hash,'fieldMap',a.field_map) ORDER BY a.path) AS assets
          FROM memory_git_snapshots s JOIN memory_git_snapshot_assets a USING(installation_id,connection_id,export_id)
          WHERE s.installation_id=$1 AND s.connection_id=$2 AND s.export_id=$3 GROUP BY s.export_id`,
        [input.installationId, input.connectionId, input.exportId])
        return snapshot.rows[0] ?? null
      })
    },
    async createConnection(grant: V2GrantFacts, request: unknown): Promise<GitConnection> {
      const input = parse(CreateConnection, request)
      return transaction(grant, input.installationId, 'scope_admin', async (client, stamp) => {
        await lockRepository(client, input.installationId, input.repositoryId)
        // An injected local registry is the sole authority over external targets;
        // this lookup must not perform network work while lifecycle locks are held.
        const resolved = await options.targets.resolve({ installationId: input.installationId, repositoryId: input.repositoryId, targetId: input.targetId })
        if (!resolved) throw new Error('git_target_unregistered')
        const target = parse(RegisteredTarget, resolved), connectionId = randomUUID()
        const result = await client.query<GitConnection>(`INSERT INTO memory_git_connections(connection_id,installation_id,repository_id,
          owner_scope_kind,owner_scope_id,provider,provider_repository_id,target_id,target_branch,credential_ref,sync_mode,write_mode)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${connectionColumns}`,
        [connectionId, input.installationId, input.repositoryId, stamp.ownerScopeKind, stamp.ownerScopeId, target.provider,
          target.providerRepositoryId, input.targetId, target.branch, target.credentialRef, input.syncMode, input.writeMode])
        await audit(client, stamp, connectionId, 'connection')
        return result.rows[0]!
      })
    },
    async listConnections(grant: V2GrantFacts, installationId: string): Promise<GitConnection[]> {
      parse(id, installationId)
      return transaction(grant, installationId, 'read', async client => (await client.query<GitConnection>(
        `SELECT ${connectionColumns} FROM memory_git_connections WHERE installation_id=$1 ORDER BY connection_id`, [installationId])).rows)
    },
    async getConnection(grant: V2GrantFacts, request: unknown): Promise<GitConnection | null> {
      const input = parse(ReadConnection, request)
      return transaction(grant, input.installationId, 'read', async client => (await client.query<GitConnection>(
        `SELECT ${connectionColumns} FROM memory_git_connections WHERE installation_id=$1 AND connection_id=$2`,
        [input.installationId, input.connectionId])).rows[0] ?? null)
    },
    async updateConnection(grant: V2GrantFacts, request: unknown): Promise<GitConnection> {
      const input = parse(UpdateConnection, request)
      return transaction(grant, input.installationId, 'scope_admin', async (client, stamp) => {
        await existing(client, input)
        const result = await client.query<GitConnection>(`UPDATE memory_git_connections SET sync_mode=$4,write_mode=$5,state=$6,
          generation=generation+1,updated_at=NOW() WHERE installation_id=$1 AND connection_id=$2 AND generation=$3 RETURNING ${connectionColumns}`,
        [input.installationId, input.connectionId, input.expectedGeneration, input.syncMode, input.writeMode, input.state])
        if (!result.rows[0]) throw new Error('git_generation_conflict')
        await audit(client, stamp, input.connectionId, 'connection')
        return result.rows[0]
      })
    },
    async mapActor(grant: V2GrantFacts, request: unknown): Promise<GitConnection> {
      const input = parse(MapActor, request)
      return transaction(grant, input.installationId, 'scope_admin', async (client, stamp) => {
        // The target membership must be locked before repository/connection.
        const member = await client.query<{ membership_revision: string }>(`SELECT membership_revision::text FROM memory_scope_memberships
          WHERE installation_id=$1 AND membership_id=$2 AND state='active'
            AND (valid_from IS NULL OR valid_from<=NOW()) AND (valid_until IS NULL OR valid_until>NOW()) FOR SHARE`, [input.installationId, input.membershipId])
        if (!member.rows[0]) throw new Error('git_forbidden')
        await existing(client, input)
        await client.query(`INSERT INTO memory_git_actor_mappings(installation_id,connection_id,provider_actor_id,membership_id,membership_revision,authorization_epoch)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(installation_id,connection_id,provider_actor_id) DO UPDATE SET membership_id=EXCLUDED.membership_id,
            membership_revision=EXCLUDED.membership_revision,authorization_epoch=EXCLUDED.authorization_epoch,updated_at=NOW()`,
        [input.installationId, input.connectionId, input.providerActorId, input.membershipId, member.rows[0].membership_revision, stamp.authorizationEpoch])
        const result = await client.query<GitConnection>(`UPDATE memory_git_connections SET generation=generation+1,updated_at=NOW()
          WHERE installation_id=$1 AND connection_id=$2 AND generation=$3 RETURNING ${connectionColumns}`,
        [input.installationId, input.connectionId, input.expectedGeneration])
        if (!result.rows[0]) throw new Error('git_generation_conflict')
        await audit(client, stamp, input.connectionId, 'mapping')
        return result.rows[0]
      })
    },
  }
}
