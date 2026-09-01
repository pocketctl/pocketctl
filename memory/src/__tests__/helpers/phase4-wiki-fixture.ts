import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'

import type { ValidatedV2Grant } from '../../governance/authorization.js'
import type { WikiCandidateDocumentV1 } from '../../wiki/types.js'
import { wikiCandidateContentHash } from '../../wiki/skeleton-builder.js'

export interface WikiCandidateFixture {
  installationId: string
  repositoryId: string
  snapshotId: string
  graphVersionId: string
  wikiId: string
  runId: string
  nodeId: string
  commitSha: string
  sourceToken: string
  grant: ValidatedV2Grant
  document: WikiCandidateDocumentV1
}

export async function insertWikiCandidateFixture(
  pool: pg.Pool,
  suffix: string,
): Promise<WikiCandidateFixture> {
  const installationId = randomUUID()
  const repositoryId = randomUUID()
  const snapshotId = randomUUID()
  const graphVersionId = randomUUID()
  const wikiId = randomUUID()
  const runId = randomUUID()
  const nodeId = randomUUID()
  const commitSha = createHash('sha1').update(`wiki:${suffix}`).digest('hex')
  const blobHash = createHash('sha256').update(`source:${suffix}`).digest('hex')
  const graphHash = createHash('sha256').update(`graph:${suffix}`).digest('hex')
  const sourceToken = `src_${createHash('sha256').update(suffix).digest('hex').slice(0, 24)}`
  await pool.query(`
    INSERT INTO memory_installations
      (installation_id, provider_id, relay_status, local_status, config_version,
       granted_scopes, subscriptions, enabled_services, event_filter)
    VALUES ($1, 'pocketctl-memory', 'active', 'ready', 1,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
  `, [installationId])
  await pool.query(`
    INSERT INTO memory_owner_scopes
      (installation_id, owner_scope_kind, owner_scope_id, state, authorization_epoch)
    VALUES ($1, 'personal', $1, 'active', 1)
  `, [installationId])
  await pool.query(`
    INSERT INTO repositories
      (repository_id, installation_id, repository_key, first_observed_at, last_observed_at)
    VALUES ($1, $2, $3, NOW(), NOW())
  `, [repositoryId, installationId, `fixture/${suffix}`])
  await pool.query(`
    INSERT INTO memory_source_snapshots
      (snapshot_id, installation_id, repository_id, commit_sha, git_object_format,
       manifest_hash, state, generation, parser_matrix_version, file_count, byte_count, completed_at)
    VALUES ($1, $2, $3, $4, 'sha1', $5, 'active', 1, 'phase4-v1', 1, 32, NOW())
  `, [snapshotId, installationId, repositoryId, commitSha, 'c'.repeat(64)])
  await pool.query(`
    INSERT INTO memory_source_blobs (installation_id, blob_hash, byte_count, utf8_content)
    VALUES ($1, $2, 32, 'export const fixture = true')
  `, [installationId, blobHash])
  await pool.query(`
    INSERT INTO memory_source_snapshot_entries
      (snapshot_id, installation_id, path, blob_hash, language, capability, byte_count, mode)
    VALUES ($1, $2, 'src/index.ts', $3, 'typescript', 'symbols_and_edges', 32, '100644')
  `, [snapshotId, installationId, blobHash])
  await pool.query(`
    INSERT INTO memory_code_graph_versions
      (graph_version_id, installation_id, repository_id, snapshot_id, generation,
       parser_version, state, coverage, content_hash, activated_at)
    VALUES ($1, $2, $3, $4, 1, 'typescript-5.7-phase4-v1', 'active', 'partial', $5, NOW())
  `, [graphVersionId, installationId, repositoryId, snapshotId, graphHash])
  await pool.query(`
    INSERT INTO memory_code_graph_heads
      (installation_id, repository_id, active_graph_version_id, revision)
    VALUES ($1, $2, $3, 1)
  `, [installationId, repositoryId, graphVersionId])
  await pool.query(`
    INSERT INTO memory_code_nodes
      (graph_version_id, installation_id, node_id, kind, stable_key, path, name, metadata)
    VALUES ($1, $2, $3, 'file', 'file:src/index.ts', 'src/index.ts', 'src/index.ts', '{}'::jsonb)
  `, [graphVersionId, installationId, nodeId])
  await pool.query(`
    INSERT INTO memory_wikis (wiki_id, installation_id, repository_id, generation)
    VALUES ($1, $2, $3, 1)
  `, [wikiId, installationId, repositoryId])
  await pool.query(`
    INSERT INTO memory_wiki_build_runs
      (run_id, installation_id, wiki_id, generation, source_snapshot_id,
       graph_version_id, state, input_digest, completed_at)
    VALUES ($1, $2, $3, 1, $4, $5, 'candidate', $6, NOW())
  `, [runId, installationId, wikiId, snapshotId, graphVersionId, graphHash])
  await pool.query(`
    INSERT INTO memory_wiki_build_sources
      (run_id, installation_id, source_token, ordinal, source_kind, stable_key,
       source_ref_id, source_snapshot_id, commit_sha, path, content_hash, excerpt)
    VALUES ($1, $2, $3, 0, 'file', 'file:src/index.ts', $4, $5, $6,
            'src/index.ts', $7, 'export const fixture = true')
  `, [runId, installationId, sourceToken, nodeId, snapshotId, commitSha, blobHash])
  const document: WikiCandidateDocumentV1 = {
    schema_version: 'wiki-candidate.v1',
    pages: [{ page_key: 'repository-overview', title: 'Repository overview', sections: [{
      section_key: 'generated-overview', heading: 'Generated overview',
      markdown: 'Generated content.', source_tokens: [sourceToken], coverage: 'partial',
    }] }],
  }
  await pool.query(`
    INSERT INTO memory_wiki_build_candidates
      (run_id, installation_id, wiki_id, document, content_hash, validated_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
  `, [runId, installationId, wikiId, JSON.stringify(document),
    wikiCandidateContentHash(document)])
  const grant: ValidatedV2Grant = {
    primaryInstallationId: installationId,
    configVersion: '1',
    scopeBindings: [{
      installation_id: installationId,
      owner_scope_kind: 'personal',
      owner_scope_id: installationId,
      membership_id: null,
      membership_revision: '0',
      authorization_epoch: '1',
      permissions: ['read', 'contribute', 'publish'],
    }],
  }
  return {
    installationId, repositoryId, snapshotId, graphVersionId, wikiId, runId,
    nodeId, commitSha, sourceToken, grant, document,
  }
}
