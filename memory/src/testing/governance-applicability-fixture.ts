import {randomUUID} from 'node:crypto'
import type pg from 'pg'
/** Governance-policy fixtures explicitly register and confirm their repository mapping; never relax runtime checks. */
export async function confirmRepositoryApplicabilityFixture(pool:pg.Pool,sourceInstallationId:string,sourceClaimId:string,targetInstallationIds:string[]):Promise<void>{
 const source=(await pool.query<{scope_kind:string;scope_key:string;current_version_id:string}>('SELECT scope_kind,scope_key,current_version_id FROM knowledge_claims WHERE installation_id=$1 AND claim_id=$2',[sourceInstallationId,sourceClaimId])).rows[0]
 if(!source||source.scope_kind!=='repository')throw new Error('repository fixture required')
 const canonical='example.test/fixture/'+sourceClaimId
 let sourceRepo=''
 for(const installation of [sourceInstallationId,...targetInstallationIds]){
  const id=randomUUID()
  const row=(await pool.query(`INSERT INTO repositories(installation_id,repository_id,repository_key,canonical_remote,first_observed_at,last_observed_at)
    VALUES($1,$2,$3,$4,NOW(),NOW()) ON CONFLICT(installation_id,repository_key) DO UPDATE SET canonical_remote=EXCLUDED.canonical_remote RETURNING repository_id::text`,[installation,id,source.scope_key,'https://'+canonical+'.git'])).rows[0]
  if(installation===sourceInstallationId)sourceRepo=row.repository_id
 }
 const app={scopeKind:'repository',scopeKey:source.scope_key,canonicalRepositoryKey:canonical,repositoryId:sourceRepo,snapshotId:null,branch:null,status:'verified'}
 await pool.query('UPDATE knowledge_claims SET canonical_repository_key=$2 WHERE claim_id=$1',[sourceClaimId,canonical])
 await pool.query('UPDATE knowledge_versions SET repository_id=$2,applicability=$3 WHERE version_id=$1',[source.current_version_id,sourceRepo,app])
}
