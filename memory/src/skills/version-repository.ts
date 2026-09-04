import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { SkillCandidateDocument } from './types.js'
import type { SkillRisk } from './risk-policy.js'
import type { SkillSourceRequest } from './source-resolver.js'

type Client = Pick<pg.PoolClient, 'query'>
export interface SkillArchiveSource {
  task_id: string; candidate_id: string; archive_id: string; source_kind: 'episode' | 'claim_version'
  episode_id: string | null; claim_version_id: string | null; repository_id: string; repo_snapshot_id: string
  source_digest: string; input_digest: string; content_hash: string; document: SkillCandidateDocument
  candidate_state: string; generation: string
}
export interface SkillVersionRow {
  skill_id: string; version_id: string; revision: string; state: 'draft' | 'reviewed' | 'rejected' | 'revoked'
  candidate_id: string; archive_id: string; document: SkillCandidateDocument; document_hash: string
  source_digest: string; policy_hash: string; policy_snapshot: Record<string, unknown>
  author_kind: 'personal' | 'membership'; author_id: string; risk: SkillRisk
}
export async function findSkillArchive(client: Client, installationId: string, candidateId: string): Promise<SkillArchiveSource | null> {
  const result = await client.query<SkillArchiveSource>(`SELECT c.task_id,c.candidate_id,c.archive_id,c.generation::text,c.state AS candidate_state,
    a.source_kind,a.episode_id,a.claim_version_id,a.repository_id,a.repo_snapshot_id,a.source_digest,a.input_digest,a.content_hash,a.document
    FROM memory_skill_candidates c JOIN memory_skill_archives a USING(installation_id,archive_id)
    WHERE c.installation_id=$1 AND c.candidate_id=$2`, [installationId,candidateId])
  return result.rows[0] ?? null
}
export async function findSkillVersion(client: Client, installationId: string, skillId: string, lock = false): Promise<SkillVersionRow | null> {
  const result = await client.query<SkillVersionRow>(`SELECT v.*,h.revision::text,h.state FROM memory_skill_heads h
    JOIN memory_skill_versions v ON v.installation_id=h.installation_id AND v.skill_id=h.skill_id AND v.version_id=h.current_version_id
    WHERE h.installation_id=$1 AND h.skill_id=$2 ${lock ? 'FOR UPDATE OF h' : ''}`, [installationId,skillId])
  return result.rows[0] ?? null
}
export function archiveSourceRequest(row: SkillArchiveSource): SkillSourceRequest {
  return row.source_kind === 'episode' ? { kind: 'episode', episodeId: row.episode_id! }
    : { kind: 'claim_version', versionId: row.claim_version_id!, repositoryId: row.repository_id, repoSnapshotId: row.repo_snapshot_id }
}
export async function appendSkillVersion(client: Client, input: {
  installationId: string; skillId: string; source: SkillArchiveSource; document: SkillCandidateDocument; documentHash: string
  policySnapshot: object; policyHash: string; risk: SkillRisk; actorKind: 'personal' | 'membership'; actorId: string; authorizationEpoch: string
}): Promise<string> {
  const versionId = randomUUID()
  await client.query(`INSERT INTO memory_skill_versions(version_id,installation_id,skill_id,version_number,candidate_id,archive_id,
    document,document_hash,source_digest,archive_content_hash,policy_snapshot,policy_hash,risk,author_kind,author_id,authorization_epoch)
    SELECT $1,$2,$3,COALESCE(MAX(version_number),0)+1,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15
    FROM memory_skill_versions WHERE installation_id=$2 AND skill_id=$3`,
  [versionId,input.installationId,input.skillId,input.source.candidate_id,input.source.archive_id,JSON.stringify(input.document),input.documentHash,
    input.source.source_digest,input.source.content_hash,JSON.stringify(input.policySnapshot),input.policyHash,input.risk,input.actorKind,input.actorId,input.authorizationEpoch])
  return versionId
}
