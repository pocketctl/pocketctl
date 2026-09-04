import type pg from 'pg'

/** Body-free authorship survives Git projection cleanup, but is always scoped
 * to an extant typed Skill version. Membership revision never erases authorship. */
export async function loadGitSkillCoauthors(client:Pick<pg.PoolClient,'query'>,installationId:string,versionId:string):Promise<ReadonlySet<string>> {
  const result=await client.query<{resolver_membership_id:string}>(`WITH applied AS (
    SELECT l.installation_id,l.connection_id,o.proposal_id,o.proposal_revision,l.skill_id,l.skill_version_id AS version_id
    FROM memory_git_revision_links l JOIN memory_git_import_outcomes o USING(installation_id,connection_id,link_id,binding_id)
    WHERE l.installation_id=$1 AND l.skill_version_id=$2
    UNION
    SELECT installation_id,connection_id,proposal_id,proposal_revision,asset_id,version_id FROM memory_git_retained_outcomes
    WHERE installation_id=$1 AND version_id=$2
  ) SELECT DISTINCT a.resolver_membership_id FROM applied o
    JOIN memory_skill_versions v ON v.installation_id=o.installation_id AND v.skill_id=o.skill_id AND v.version_id=o.version_id
    JOIN memory_git_resolution_authors a ON a.installation_id=o.installation_id AND a.connection_id=o.connection_id
      AND a.proposal_id=o.proposal_id AND a.proposal_revision<=o.proposal_revision`,[installationId,versionId])
  return new Set(result.rows.map(row=>row.resolver_membership_id))
}
