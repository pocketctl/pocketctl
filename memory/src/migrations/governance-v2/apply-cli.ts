import {readFile} from 'node:fs/promises'
import type pg from 'pg'
import {startGovernanceBackfill,backfillGovernance,governanceEnvironmentFingerprint,type MigrationBaseline} from './backfill.js'
import {validateGovernanceMigration} from './validate.js'
import {cutoverGovernance} from './cutover.js'
import {reconcileGovernanceChanges} from './reconcile.js'
/** Apply is explicit, environment-bound, scoped and content-free. The default
 * plan command never calls this module. No schema deployment or model calls. */
export async function applyGovernanceCommand(pool:pg.Pool,args:string[]){
 let phase='',runId='',fingerprint='',writerFile='',batchSize=200;const installationIds:string[]=[]
 for(let i=0;i<args.length;i++){
  const key=args[i],value=args[++i];if(!value)throw new Error('migration_argument_required')
  if(key==='--phase'&&!phase)phase=value
  else if(key==='--run-id'&&!runId)runId=value
  else if(key==='--environment-fingerprint'&&!fingerprint)fingerprint=value
  else if(key==='--installation')installationIds.push(value)
  else if(key==='--writer-proof'&&!writerFile)writerFile=value
  else if(key==='--batch-size')batchSize=Number(value)
  else throw new Error('invalid_migration_argument')
 }
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
 if(!['backfill','reconcile','validate','cutover'].includes(phase)||!installationIds.length||new Set(installationIds).size!==installationIds.length||installationIds.some(id=>!uuid.test(id))||!Number.isInteger(batchSize)||batchSize<1||batchSize>200)throw new Error('explicit_migration_scope_required')
 if(!/^[a-f0-9]{64}$/.test(fingerprint)||await governanceEnvironmentFingerprint(pool)!==fingerprint)throw new Error('migration_environment_mismatch')
 if(runId){if(!uuid.test(runId))throw new Error('invalid_migration_run');const run=(await pool.query('SELECT manifest,environment_fingerprint FROM memory_governance_migration_runs WHERE run_id=$1',[runId])).rows[0]
  if(!run||run.environment_fingerprint!==fingerprint||(phase==='cutover'?!installationIds.every(id=>(run.manifest as MigrationBaseline).installationIds.includes(id)):JSON.stringify((run.manifest as MigrationBaseline).installationIds.slice().sort())!==JSON.stringify(installationIds.slice().sort())))throw new Error('migration_scope_mismatch')
 }else{if(phase!=='backfill')throw new Error('migration_run_required');runId=await startGovernanceBackfill(pool,{installationIds,environmentFingerprint:fingerprint})}
 const started=performance.now()
 if(phase==='backfill')return {runId,phase,...await backfillGovernance(pool,{runId,batchSize}),elapsedMs:Math.round(performance.now()-started)}
 if(phase==='reconcile')return {runId,phase,...await reconcileGovernanceChanges(pool,{runId}),elapsedMs:Math.round(performance.now()-started)}
 if(phase==='validate')return {runId,phase,...await validateGovernanceMigration(pool,runId),elapsedMs:Math.round(performance.now()-started)}
 if(installationIds.length!==1||!writerFile)throw new Error('one_scope_writer_proof_required')
 const proof=JSON.parse(await readFile(writerFile,'utf8'))
 if(!Array.isArray(proof.writers)||!proof.writers.every((p:unknown)=>typeof p==='string')||proof.environmentFingerprint!==fingerprint||proof.installationId!==installationIds[0]||!proof.artifactManifestSha256||!/^[a-f0-9]{64}$/.test(proof.artifactManifestSha256))throw new Error('writer_proof_required')
 return {runId,phase,...await cutoverGovernance(pool,{runId,installationId:installationIds[0],writerProof:proof.writers}),elapsedMs:Math.round(performance.now()-started)}
}
