import {z} from 'zod'
import type pg from 'pg'
import {canonicalBundleJSON,type RevisionBundle} from './revision-bundle.js'
import {claimConsumptionDecision} from './applicability.js'

const applicability=z.object({scopeKind:z.enum(['installation','repository','snapshot','branch','task']),scopeKey:z.string(),
 canonicalRepositoryKey:z.string().nullable(),repositoryId:z.string().uuid().nullable(),snapshotId:z.string().uuid().nullable(),
 branch:z.string().nullable(),status:z.enum(['verified','legacy_unknown','requires_review'])}).strict()
const instant=z.string().datetime({offset:true}).transform(v=>new Date(v).toISOString()).nullable()
/** Source freshness and origin policy are evidence, never client assertions. */
export const revisionMetadataPatchSchema=z.object({applicability:applicability.optional(),sourceValidFrom:instant.optional(),sourceValidUntil:instant.optional()}).strict()
export type RevisionMetadataPatch=z.input<typeof revisionMetadataPatchSchema>
export function parseRevisionMetadataPatch(value:unknown):RevisionMetadataPatch {
 const parsed=revisionMetadataPatchSchema.safeParse(value)
 if(!parsed.success)throw new Error('invalid revision metadata')
 return parsed.data
}
export function applyRevisionMetadata(bundle:RevisionBundle,patch:RevisionMetadataPatch|undefined,source:RevisionBundle|undefined):RevisionBundle {
 if(!patch)return bundle
 if(!source)throw new Error('source metadata proof required')
 const next={...bundle,...patch}
 if(patch.applicability){
  const app=patch.applicability,proof=source.applicability
  // Reclassification uses captured source facts. Unknown or held metadata may
  // be retained/downgraded, but cannot be declared verified by a request.
  if(canonicalBundleJSON({...app,status:null})!==canonicalBundleJSON({...proof,status:null})
   ||(app.status==='verified'&&proof.status!=='verified'))throw new Error('source applicability metadata mismatch')
  if(app.status==='verified'&&!claimConsumptionDecision({scopeKind:app.scopeKind,scopeKey:app.scopeKey,repositoryId:app.repositoryId,
   snapshotId:app.snapshotId,branch:app.branch,canonicalRepositoryKey:app.canonicalRepositoryKey,applicability:app},
   {repositoryId:app.repositoryId,snapshotId:app.snapshotId,branch:app.branch,taskScopeKey:app.scopeKey}).eligible)throw new Error('invalid applicability metadata')
  next.sourceSnapshotCommitSha=source.sourceSnapshotCommitSha
  next.sourceRepositoryKey=source.sourceRepositoryKey
 }
 if(next.sourceValidFrom!==null&&next.sourceValidUntil!==null&&Date.parse(next.sourceValidFrom)>=Date.parse(next.sourceValidUntil))throw new Error('invalid revision time interval')
 return next
}

/** Registry/purge order precedes Claim/Candidate locks. Discovery is rechecked
 * after the Claim lock; a new dependency requires a fresh ordered attempt. */
export async function lockRevisionSourceMetadata(client:pg.PoolClient,installationId:string,versionId:string){
 const observed=(await client.query<{repository_id:string|null;repo_snapshot_id:string|null}>(
  'SELECT repository_id,repo_snapshot_id FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2',[installationId,versionId])).rows[0]
 if(!observed)throw new Error('source metadata unavailable')
 await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('registry:canonical:'||$1,0))",[installationId])
 if(observed.repository_id){
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:repository:'||$1||':'||$2,0))",[installationId,observed.repository_id])
  await client.query('SELECT repository_id FROM repositories WHERE installation_id=$1 AND repository_id=$2 FOR SHARE',[installationId,observed.repository_id])
 }
 if(observed.repo_snapshot_id)await client.query('SELECT repo_snapshot_id FROM repo_snapshots WHERE installation_id=$1 AND repo_snapshot_id=$2 FOR SHARE',[installationId,observed.repo_snapshot_id])
 return async()=>{
  const current=(await client.query('SELECT repository_id,repo_snapshot_id FROM knowledge_versions WHERE installation_id=$1 AND version_id=$2 FOR SHARE',[installationId,versionId])).rows[0]
  if(!current||current.repository_id!==observed.repository_id||current.repo_snapshot_id!==observed.repo_snapshot_id)throw new Error('source metadata dependencies changed; retry revision')
  const held=await client.query(`SELECT 1 FROM memory_repository_tombstones WHERE installation_id=$1 AND repository_id=$2
    UNION ALL SELECT 1 FROM memory_source_snapshot_tombstones WHERE installation_id=$1 AND repository_id=$2
    AND commit_sha=(SELECT commit_sha FROM repo_snapshots WHERE installation_id=$1 AND repo_snapshot_id=$3)`,[installationId,observed.repository_id,observed.repo_snapshot_id])
  if(held.rowCount)throw new Error('source metadata tombstoned')
 }
}
