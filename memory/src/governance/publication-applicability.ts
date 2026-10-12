import type pg from 'pg'
import {claimConsumptionDecision,confirmedCanonicalRepositoryKey} from './applicability.js'
import type {ClaimApplicability,RevisionBundle} from './revision-bundle.js'
export class PublicationApplicabilityError extends Error {
 constructor(readonly reason:string){super(reason)}
}
export function canonicalRepositoryRemotes(key:string):string[]{
 if(!confirmedCanonicalRepositoryKey(key))return[]
 const slash=key.indexOf('/'),host=key.slice(0,slash),path=key.slice(slash+1)
 return [...new Set([`https://${key}`,`https://${key}.git`,`http://${key}`,`http://${key}.git`,
  `ssh://git@${key}`,`ssh://git@${key}.git`,...(!host.includes(':')?[`git@${host}:${path}`,`git@${host}:${path}.git`]:[])])]
}
/** Map only reviewed immutable source facts into owned target records; never copy foreign FKs. */
export async function publicationApplicability(client:pg.PoolClient,bundle:RevisionBundle|null,targetInstallationId:string):Promise<ClaimApplicability>{
 const fail=(reason:string):never=>{throw new PublicationApplicabilityError(reason)}
 if(!bundle)return fail('legacy_bundle_requires_repair')
 const source=bundle.applicability
 if(!source||!claimConsumptionDecision({scopeKind:source.scopeKind,scopeKey:source.scopeKey,repositoryId:source.repositoryId,
  snapshotId:source.snapshotId,branch:source.branch,canonicalRepositoryKey:source.canonicalRepositoryKey,applicability:source},
  {repositoryId:source.repositoryId,snapshotId:source.snapshotId,branch:source.branch,taskScopeKey:source.scopeKey}).eligible)return fail('applicability_requires_review')
 if(!bundle.sourceFreshnessAt||!Number.isFinite(Date.parse(bundle.sourceFreshnessAt))
  ||(bundle.sourceValidFrom!==null&&!Number.isFinite(Date.parse(bundle.sourceValidFrom)))
  ||(bundle.sourceValidUntil!==null&&!Number.isFinite(Date.parse(bundle.sourceValidUntil)))
  ||(bundle.sourceValidFrom!==null&&bundle.sourceValidUntil!==null&&Date.parse(bundle.sourceValidFrom)>=Date.parse(bundle.sourceValidUntil)))return fail('source_time_requires_review')
 if(source.scopeKind==='task')return fail('task_mapping_required')
 if(!source.repositoryId&&!source.snapshotId&&source.scopeKind==='installation')return{...source}
 if(!confirmedCanonicalRepositoryKey(source.canonicalRepositoryKey))return fail('repository_mapping_required')
 // Protect the unique-match predicate through commit, including rows not yet present.
 // Canonical registry upserts take the exclusive side before any repository row lock.
 await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('registry:canonical:'||$1,0))",[targetInstallationId])
 async function matchingRepositories(lock=false){return(await client.query<{repository_id:string;repository_key:string}>(`SELECT r.repository_id::text,r.repository_key FROM repositories r
  WHERE r.installation_id=$1 AND r.canonical_remote=ANY($2::text[])
   AND NOT EXISTS(SELECT 1 FROM memory_repository_tombstones t WHERE t.installation_id=r.installation_id AND t.repository_id=r.repository_id)
  ORDER BY r.repository_id LIMIT 2 ${lock?'FOR SHARE OF r':''}`,[targetInstallationId,canonicalRepositoryRemotes(source.canonicalRepositoryKey!)])).rows}
 const observed=await matchingRepositories()
 if(observed.length!==1)return fail(observed.length?'repository_mapping_ambiguous':'repository_mapping_required')
 // Match purge order: repository advisory fence precedes row locks.
 await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:repository:'||$1||':'||$2,0))",[targetInstallationId,observed[0].repository_id])
 const repositories=await matchingRepositories(true)
 if(repositories.length!==1||repositories[0].repository_id!==observed[0].repository_id)return fail('repository_mapping_changed')
 const repository=repositories[0]
 let snapshotId:string|null=null
 if(source.snapshotId){
  if(!bundle.sourceSnapshotCommitSha||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(bundle.sourceSnapshotCommitSha))return fail('snapshot_proof_requires_review')
  const snapshots=(await client.query<{repo_snapshot_id:string}>(`SELECT s.repo_snapshot_id::text FROM repo_snapshots s
   WHERE s.installation_id=$1 AND s.repository_id=$2 AND s.commit_sha=$3
    AND NOT EXISTS(SELECT 1 FROM memory_source_snapshot_tombstones t WHERE t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha)
   ORDER BY s.repo_snapshot_id LIMIT 2 FOR SHARE OF s`,[targetInstallationId,repository.repository_id,bundle.sourceSnapshotCommitSha])).rows
  if(snapshots.length!==1)return fail(snapshots.length?'snapshot_mapping_ambiguous':'snapshot_mapping_required')
  snapshotId=snapshots[0].repo_snapshot_id
 }
 let scopeKey=source.scopeKey
 if(source.scopeKind==='repository'){
  if(source.scopeKey===source.repositoryId)scopeKey=repository.repository_id
  else if(source.scopeKey===bundle.sourceRepositoryKey)scopeKey=repository.repository_key
  else if(source.scopeKey!==source.canonicalRepositoryKey)return fail('scope_key_mapping_required')
 }
 if(source.scopeKind==='snapshot'){
  if(source.scopeKey===source.snapshotId)scopeKey=snapshotId!
  else if(source.scopeKey!==bundle.sourceSnapshotCommitSha)return fail('scope_key_mapping_required')
 }
 return{...source,scopeKey,repositoryId:repository.repository_id,snapshotId}
}
