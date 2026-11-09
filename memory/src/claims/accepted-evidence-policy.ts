import type pg from 'pg'

// Schema48 ownership is a positive relationship, not merely a capsule row.
// Availability/revocation is enforced separately by the existing read guards.
const acceptedOwnership = `accepted.evidence_kind='accepted_excerpt'
  AND accepted.episode_id IS NULL AND accepted.source_event_id IS NULL AND accepted.artifact_id IS NULL
  AND retained.installation_id=accepted.installation_id AND retained.capsule_id=accepted.capsule_id
  AND retained.version_id=accepted.version_id AND retained.retention_basis='user_accepted'`
/** The same exact row relationship, for native independently retained locators. */
export function independentlyAcceptedEvidenceOwnershipSql(evidenceAlias:string,capsuleAlias:string):string{
 if(!/^[a-z_]+$/.test(evidenceAlias)||!/^[a-z_]+$/.test(capsuleAlias))throw Error('invalid_accepted_evidence_sql_alias')
 return acceptedOwnership.replaceAll('accepted.',evidenceAlias+'.').replaceAll('retained.',capsuleAlias+'.')
}
const prefix=(namespace?:'memory')=>namespace?'memory.':''

/** Exact independent support for the caller's Version alias v. */
export function independentlyAcceptedVersionSupportSql(namespace?:'memory'):string{
 const schema=prefix(namespace)
 return `EXISTS(SELECT 1 FROM ${schema}knowledge_evidence accepted
  JOIN ${schema}knowledge_evidence_capsules retained
    ON retained.installation_id=accepted.installation_id AND retained.capsule_id=accepted.capsule_id
  WHERE accepted.installation_id=v.installation_id AND accepted.version_id=v.version_id
    AND ${acceptedOwnership})`
}

/** Missing/mismatched accepted relationships are unproved ownership. Refuse
 * before Session DML; neither an orphan capsule nor an invalid evidence pair
 * authorizes source deletion or independently retained replacement selection. */
export async function assertIndependentAcceptedEvidence(
 client:Pick<pg.PoolClient,'query'>,versionIds:readonly string[],namespace?:'memory',
):Promise<void>{
 if(!versionIds.length)return
 const schema=prefix(namespace)
 const unresolved=await client.query(`SELECT 1 FROM ${schema}knowledge_evidence accepted
  LEFT JOIN ${schema}knowledge_evidence_capsules retained
    ON retained.installation_id=accepted.installation_id AND retained.capsule_id=accepted.capsule_id
  WHERE accepted.version_id=ANY($1::uuid[]) AND accepted.evidence_kind='accepted_excerpt'
    AND (${acceptedOwnership}) IS NOT TRUE
  UNION ALL
  SELECT 1 FROM ${schema}knowledge_evidence_capsules retained
  WHERE retained.version_id=ANY($1::uuid[]) AND NOT EXISTS(
    SELECT 1 FROM ${schema}knowledge_evidence accepted
    WHERE accepted.installation_id=retained.installation_id AND accepted.capsule_id=retained.capsule_id
      AND ${acceptedOwnership}) LIMIT 1`,[versionIds])
 if(unresolved.rowCount)throw Error('independent_accepted_evidence_unproven')
}
