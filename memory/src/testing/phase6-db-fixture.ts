import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { V2GrantFacts } from '../governance/authorization.js'

export async function gitDbFixture(pool: pg.Pool, roles = ['scope_administrator']) {
  const installationId = randomUUID(), repositoryId = randomUUID(), scopeId = randomUUID(), membershipId = randomUUID()
  await pool.query(`INSERT INTO memory_installations(installation_id,provider_id,relay_status,local_status,config_version)
    VALUES($1,'pocketctl-memory','active','ready',1)`, [installationId])
  await pool.query(`INSERT INTO memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id)
    VALUES($1,'team',$2)`, [installationId, scopeId])
  await pool.query(`INSERT INTO memory_scope_memberships(installation_id,membership_id,roles)
    VALUES($1,$2,$3)`, [installationId, membershipId, roles])
  await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,first_observed_at,last_observed_at)
    VALUES($1,$2,$3,NOW(),NOW())`, [installationId, repositoryId, `repo-${repositoryId}`])
  const permissions: Record<string, string[]> = { reader: ['read'], contributor: ['read','contribute'],
    scope_administrator: ['read','contribute','review','publish','policy_admin','scope_admin'] }
  const grant: V2GrantFacts = { primaryInstallationId: installationId, configVersion: '1', scopeBindings: [{
    installation_id: installationId, owner_scope_kind: 'team', owner_scope_id: scopeId,
    membership_id: membershipId, membership_revision: '1', authorization_epoch: '1',
    permissions: [...new Set(roles.flatMap(role => permissions[role] ?? []))],
  }] }
  return { installationId, repositoryId, scopeId, membershipId, grant }
}

export async function gitClaimFixture(pool: pg.Pool, f: Awaited<ReturnType<typeof gitDbFixture>>,
  options: { repositoryId?: string; noVersionRepository?: boolean; scopeKey?: string; claimType?: string } = {}) {
  const claimId = randomUUID(), versionId = randomUUID(), repositoryId = options.repositoryId ?? f.repositoryId
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`INSERT INTO knowledge_claims(claim_id,installation_id,claim_type,scope_kind,scope_key,normalized_key,
      state,current_version_id,owner_scope_kind,owner_scope_id) VALUES($1,$2,$3,'repository',$4,$1::uuid::text,'active',$5,'team',$6)`,
    [claimId, f.installationId, options.claimType ?? 'architecture_decision', options.scopeKey ?? repositoryId, versionId, f.scopeId])
    await client.query(`INSERT INTO knowledge_versions(version_id,installation_id,claim_id,version_number,statement,authority,confidence,repository_id)
      VALUES($1,$2,$3,1,'Synthetic statement','team_published',1,$4)`,
    [versionId, f.installationId, claimId, options.noVersionRepository ? null : repositoryId])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  return { claimId, versionId }
}

export async function insertGitConnection(pool: pg.Pool, f: Awaited<ReturnType<typeof gitDbFixture>>) {
  const connectionId = randomUUID()
  await pool.query(`INSERT INTO memory_git_connections(connection_id,installation_id,repository_id,owner_scope_kind,owner_scope_id,
    provider,provider_repository_id,target_id,target_branch,credential_ref,sync_mode,write_mode)
    VALUES($1,$2,$3,'team',$4,'github','123','fixture-target','main','server-only-secret-ref','shadow','off')`,
  [connectionId, f.installationId, f.repositoryId, f.scopeId])
  return connectionId
}

export async function gitWikiFixture(pool: pg.Pool, f: Awaited<ReturnType<typeof gitDbFixture>>) {
  const wikiId = randomUUID(), versionId = randomUUID(), sourceId = randomUUID(), graphId = randomUUID()
  await pool.query(`INSERT INTO memory_source_snapshots(snapshot_id,installation_id,repository_id,commit_sha,git_object_format,
    manifest_hash,state,generation,parser_matrix_version,file_count,byte_count) VALUES($1,$2,$3,$4,'sha1',$5,'active',1,'fixture',0,0)`,
  [sourceId, f.installationId, f.repositoryId, 'a'.repeat(40), 'b'.repeat(64)])
  await pool.query(`INSERT INTO memory_code_graph_versions(graph_version_id,installation_id,repository_id,snapshot_id,generation,parser_version,state,coverage,content_hash)
    VALUES($1,$2,$3,$4,1,'fixture','active','complete',$5)`, [graphId, f.installationId, f.repositoryId, sourceId, 'a'.repeat(64)])
  await pool.query('INSERT INTO memory_wikis(wiki_id,installation_id,repository_id) VALUES($1,$2,$3)', [wikiId, f.installationId, f.repositoryId])
  await pool.query(`INSERT INTO memory_wiki_versions(wiki_version_id,installation_id,wiki_id,revision,source_snapshot_id,graph_version_id,content_hash)
    VALUES($1,$2,$3,1,$4,$5,$6)`, [versionId, f.installationId, wikiId, sourceId, graphId, 'a'.repeat(64)])
  return { wikiId, versionId }
}
