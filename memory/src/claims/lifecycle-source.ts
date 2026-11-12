import type pg from 'pg'
import {sourcePoolContext} from '../sources/pool-context.js'
import {guardRetainedVersions} from '../sources/retained-versions.js'
import {assertRetainedSourceGuards,detachRetainedSourceGuards} from '../sources/retained-authority.js'
import {preparedSourceUnavailable} from '../sources/prepared-sources.js'
import {guardSourceExecutionCommit,SourceExecutionError} from '../sources/source-execution.js'

/** Hold the native evidence and execution locks through the caller's commit.
 * An unavailable source may discard the positive effect while the assessment
 * run records the provider's independently incurred usage. */
export async function guardLifecycleVersion(client:pg.PoolClient,installationId:string,versionId:string):Promise<boolean>{
 if(sourcePoolContext(client).namespace!=='memory')return true
 await client.query('SAVEPOINT lifecycle_version_source')
 try{
  await guardRetainedVersions(client,installationId,[versionId],{requireCurrent:true,requireAvailable:true,recordCheck:false})
  await assertRetainedSourceGuards(client)
  await guardSourceExecutionCommit(client,installationId)
  await client.query('RELEASE SAVEPOINT lifecycle_version_source')
  return true
 }catch(error){
  if(!preparedSourceUnavailable(error)&&!(error instanceof SourceExecutionError)
   &&!['55P03','57014'].includes((error as {code?:string})?.code??''))throw error
  await client.query('ROLLBACK TO SAVEPOINT lifecycle_version_source')
  await client.query('RELEASE SAVEPOINT lifecycle_version_source')
  return false
 }finally{detachRetainedSourceGuards(client)}
}

/** Back off without changing the claim, observation or provider attempt. */
export async function deferLifecycleEvaluation(client:pg.PoolClient,installationId:string,claimId:string):Promise<void>{
 await client.query(`UPDATE memory_claim_lifecycle SET next_evaluate_at=clock_timestamp()+interval '5 minutes'
  WHERE installation_id=$1 AND claim_id=$2 AND next_evaluate_at<=clock_timestamp()`,[installationId,claimId])
}
