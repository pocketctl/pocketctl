import {SourceProcessingPins} from './processing-pins.js'
import type {SourceScope,SourceRoot,SourceVersion} from '@pocketctl/session-source'
import {AsyncLocalStorage} from 'node:async_hooks'
import {createHash} from 'node:crypto'
import type pg from 'pg'
import {sourceConnectionKey,sourcePoolContext} from './pool-context.js'
export type SourceExecutionBranch='legacy-active'|'canonical-active'|'canonical-shadow'
export type SourceExecutionSelection=SourceExecutionBranch|'active'|'canonical'
interface Execution {semanticObservations:Map<string,{roster:unknown;businessDigest:string}>;pins:SourceProcessingPins;pool:pg.Pool;executionId:string;installationId:string;generation:string;controlRevision:string;claimEpoch:string;branch:SourceExecutionBranch;jobId:string;worker:string}
interface ExecutionFence {jobId:string;claimedBy:string;claimEpoch:number|string}
const executions=new AsyncLocalStorage<Execution>()
const providerAttempts=new WeakMap<object,{pool:pg.Pool;executionId:string;reservationId:string}>()
type ProviderEffect='accounted'|'uncertain'|'not-sent'
const providerAccounting=new AsyncLocalStorage<Map<object,ProviderEffect>>()
const unrecordedEffects=new WeakSet<Execution>()
/** Scheduling a different job or background pass must not inherit the caller's
 * execution or provider-accounting context. Only dispatch boundaries use this;
 * actual handlers still capture and validate their own original authority. */
export function runOutsideSourceJobExecution<T>(work:()=>T):T{
 return executions.exit(()=>providerAccounting.exit(work))
}

/** A known response remains account-able, but no further dispatch or output
 * may follow an unrecorded effect in this execution. */
export function blockUnrecordedSourceEffect():void{const execution=executions.getStore();if(execution)unrecordedEffects.add(execution)}
export function assertSourceEffectsRecorded():void{const execution=executions.getStore();if(execution&&unrecordedEffects.has(execution))throw Error('source_provider_effect_unrecorded')}
export class SourceExecutionError extends Error {
 constructor(readonly code:'source_execution_generation_changed'|'source_execution_required'|'source_shadow_provider_forbidden'|'source_execution_scope_mismatch'){
  super(code);this.name='SourceExecutionError'
 }
}
const changed=()=>new SourceExecutionError('source_execution_generation_changed')
/** Only metadata work runs in this short physical transaction. User/model/
 * archive callbacks are always invoked after its COMMIT and client release. */
async function metadata<T>(pool:pg.Pool,work:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
 if(sourceConnectionKey(pool)!==pool)throw new SourceExecutionError('source_execution_scope_mismatch')
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  const result=await work(client);await client.query('COMMIT');return result
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}
export const currentSourceExecutionBranch=():SourceExecutionBranch|undefined=>executions.getStore()?.branch
/** Compatibility input may be selected only for this execution's physical
 * pool and installation. Cross-scope reads keep canonical authority checks. */
export function sourceExecutionBranchFor(pool:pg.Pool,installationId:string):SourceExecutionBranch|undefined{
 const execution=executions.getStore()
 return execution?.pool===pool&&execution.installationId===installationId?execution.branch:undefined
}
/** Opaque identity of this original execution, never an execution-ID DTO.
 * Prepared metadata must retain this exact object across asynchronous IO. */
export function sourceExecutionTokenFor(pool:pg.Pool,installationId:string):object|undefined{
 const execution=executions.getStore()
 return execution?.pool===pool&&execution.installationId===installationId?execution:undefined
}
/** Stable across claims/mode generations. Only a digest is persisted; neither
 * the provider input nor a new claim may mint another paid attempt. */
export function sourceProviderRequestKey(operation:string,input:unknown):string|undefined{
 const execution=executions.getStore();if(!execution)return undefined
 return 'source:'+createHash('sha256').update(JSON.stringify([execution.jobId,operation,input])).digest('hex')
}
/** Capture once at dispatch. Never recapture the current generation after
 * HTTP or during an outer idempotency retry. Public legacy operation is inert. */
export async function withSourceJobExecution<T>(pool:pg.Pool,fence:ExecutionFence,work:()=>Promise<T>,options:{branch?:SourceExecutionSelection;signal?:AbortSignal}={}):Promise<T>{
 const branch=options.branch??'active',current=executions.getStore()
 if(current){
  if(current.pool!==pool||current.jobId!==fence.jobId||current.worker!==fence.claimedBy||current.claimEpoch!==String(fence.claimEpoch)
   ||(branch==='active'?current.branch==='canonical-shadow':branch==='canonical'?current.branch==='legacy-active':current.branch!==branch))throw new SourceExecutionError('source_execution_scope_mismatch')
  return work()
 }
 if(sourcePoolContext(pool).namespace!=='memory')return work()
 if(options.signal?.aborted)throw Error('source_execution_aborted')
 const epoch=String(fence.claimEpoch)
 if(typeof fence.claimEpoch==='number'&&!Number.isSafeInteger(fence.claimEpoch)||!/^[1-9][0-9]*$/.test(epoch)||BigInt(epoch)>9223372036854775807n)throw changed()
 const row=await metadata(pool,async client=>(await client.query('SELECT shared.capture_memory_job_source($1,$2,$3::bigint,$4) AS execution',[fence.jobId,fence.claimedBy,epoch,branch])).rows[0]?.execution)
 if(!row||(branch==='active'?!['legacy-active','canonical-active'].includes(row.branch):branch==='canonical'?!['canonical-shadow','canonical-active'].includes(row.branch):row.branch!==branch)||row.claimEpoch!==epoch||typeof row.executionId!=='string'||typeof row.installationId!=='string'||typeof row.generation!=='string'||typeof row.controlRevision!=='string'||!/^[1-9][0-9]*$/.test(row.controlRevision)||BigInt(row.controlRevision)>9223372036854775807n)throw changed()
 const execution:Execution=Object.freeze({semanticObservations:new Map<string,{roster:unknown;businessDigest:string}>(),pins:new SourceProcessingPins(pool,row.executionId),pool,executionId:row.executionId,installationId:row.installationId,generation:row.generation,controlRevision:row.controlRevision,claimEpoch:epoch,branch:row.branch,jobId:fence.jobId,worker:fence.claimedBy})
 const abort=()=>{void execution.pins.close().catch(()=>undefined)}
 options.signal?.addEventListener('abort',abort,{once:true})
 try{if(options.signal?.aborted)throw Error('source_execution_aborted');return await executions.run(execution,work)}finally{options.signal?.removeEventListener('abort',abort);await execution.pins.close()}
}
/** Only original native personal canonical jobs acquire protection. Public API,
 * retained authority, Team and sole legacy archive custody remain unchanged. */
export async function protectSourceExecutionBodies(pool:pg.Pool,scope:SourceScope,root:SourceRoot,version:SourceVersion|(()=>Promise<SourceVersion>)):Promise<void>{
 const execution=executions.getStore()
 if(!execution||execution.branch==='legacy-active'||root.kind!=='relay_event'||scope.ownerScopeKind!=='personal')return
 if(execution.pool!==pool||execution.installationId!==scope.installationId)throw new SourceExecutionError('source_execution_scope_mismatch')
 await execution.pins.protect(scope,root,typeof version==='function'?await version():version)
}
/** Fixed selected metadata content and current purge protection are separate.
 * SQL still acquires/renews only an independently current ordinary vector. */
export async function protectMetadataSourceBodies(pool:pg.Pool,scope:SourceScope,root:SourceRoot):Promise<void>{
 const execution=executions.getStore()
 if(!execution||execution.pool!==pool||execution.installationId!==scope.installationId||execution.branch!=='canonical-active'
  ||root.kind!=='relay_event'||scope.ownerScopeKind!=='personal')throw new SourceExecutionError('source_execution_scope_mismatch')
 await execution.pins.protectCurrent(scope,root)
}
/** A locator only. The selected SQL fence independently validates the actual
 * original running job/type/root/turn/claim; no GUC can confer this authority. */
export function metadataSourceExecution(pool:pg.Pool,installationId:string):{token:object;executionId:string}{
 const execution=executions.getStore()
 if(!execution||execution.pool!==pool||execution.installationId!==installationId||execution.branch!=='canonical-active')throw new SourceExecutionError('source_execution_scope_mismatch')
 return {token:execution,executionId:execution.executionId}
}
/** Before reserving any budget. Canonical comparison shadow cannot consume
 * even an internal budget reservation; business legacy-active shadow may. */
export async function assertSourceProviderExecution(required=false):Promise<void>{
 assertSourceEffectsRecorded()
 const execution=executions.getStore()
 if(!execution){if(required)throw new SourceExecutionError('source_execution_required');return}
 await execution.pins.assertCurrent()
 if(execution.branch==='canonical-shadow')throw new SourceExecutionError('source_shadow_provider_forbidden')
 await metadata(execution.pool,async client=>{
  for(const observation of execution.semanticObservations.values()){
   if((await client.query('SELECT shared.lock_memory_team_semantic_group($1,$2::jsonb,FALSE) AS valid',[execution.executionId,JSON.stringify(observation.roster)])).rows[0]?.valid!==true)throw changed()
  }
  if((await client.query("SELECT shared.assert_memory_job_source($1,'provider') AS valid",[execution.executionId])).rows[0]?.valid!==true)throw changed()
 })
}
/** Caller must own the physical output transaction. This does not belong in
 * generic job fencing or in an incurred-usage/failure bookkeeping transaction. */
export async function guardSourceExecutionCommit(client:Pick<pg.PoolClient,'query'>,installationId?:string):Promise<void>{
 assertSourceEffectsRecorded()
 const execution=executions.getStore()
 if(execution&&installationId!==undefined&&execution.installationId!==installationId)throw new SourceExecutionError('source_execution_scope_mismatch')
 if(!execution||sourceConnectionKey(client)!==client)return
 execution.pins.assertUsable()
 // Final source/body authority is still checked by the caller's source fence.
 // Avoid another physical connection while an output transaction owns locks.
 if((await client.query('SELECT shared.guard_memory_source_processing_pins($1,$2) AS valid',[execution.executionId,execution.pins.count])).rows[0]?.valid!==true)throw changed()
 if((await client.query('SELECT shared.guard_memory_job_source_commit($1) AS valid',[execution.executionId])).rows[0]?.valid!==true)throw changed()
}
/** Advance the installation watermark only after its complete sealed set is
 * projected. SQL independently rechecks original execution and current source;
 * a partial set legitimately returns false. */
export async function completeSourceProjection(client:Pick<pg.PoolClient,'query'>,scope:{installationId:string},root:{kind:string;key:string},version:unknown):Promise<boolean>{
 const execution=executions.getStore()
 if(!execution||execution.branch!=='canonical-active'||execution.installationId!==scope.installationId||sourceConnectionKey(client)!==client)throw new SourceExecutionError('source_execution_scope_mismatch')
 const result=await client.query('SELECT shared.complete_memory_source_projection($1,$2::jsonb,$3,$4,$5::jsonb) AS completed',[execution.executionId,JSON.stringify(scope),root.kind,root.key,JSON.stringify(version)])
 return result.rows[0]?.completed===true
}
/** Comparison receipts have their own physical commit admission. This never
 * grants the positive publish/provider capability to a shadow execution. */
export async function guardSourceComparisonCommit(client:Pick<pg.PoolClient,'query'>,installationId:string):Promise<void>{
 const execution=executions.getStore()
 if(!execution||execution.branch!=='canonical-shadow'||execution.installationId!==installationId||sourceConnectionKey(client)!==client)
  throw new SourceExecutionError('source_execution_scope_mismatch')
 execution.pins.assertUsable()
 if((await client.query('SELECT shared.guard_memory_source_processing_pins($1,$2) AS valid',[execution.executionId,execution.pins.count])).rows[0]?.valid!==true)throw changed()
 if((await client.query('SELECT shared.guard_memory_job_source_comparison($1) AS valid',[execution.executionId])).rows[0]?.valid!==true)throw changed()
}
/** Internal comparison persistence uses the original private execution ID.
 * The caller's opaque prepared page, SQL scope/root fence and this deferred
 * guard jointly admit metadata; none grant positive publication capability. */
export async function writeSourceComparisonProgress(client:Pick<pg.PoolClient,'query'>,installationId:string,input:{scope:unknown;kind:string;root:string;scan:string;context:string;meta:unknown}):Promise<any>{
 const execution=executions.getStore()
 if(!execution||execution.branch!=='canonical-shadow'||execution.installationId!==installationId||sourceConnectionKey(client)!==client)
  throw new SourceExecutionError('source_execution_scope_mismatch')
 await guardSourceComparisonCommit(client,installationId)
 const result=(await client.query('SELECT shared.write_memory_source_shadow_progress($1,$2::jsonb,$3,$4,$5,$6,$7::jsonb) AS progress',
  [execution.executionId,JSON.stringify(input.scope),input.kind,input.root,input.scan,input.context,JSON.stringify(input.meta)])).rows[0].progress
 await guardSourceComparisonCommit(client,installationId)
 return result
}
/** Record in-flight state and pass its deferred lease check before HTTP. */
export async function startSourceProviderAttempt(reservationId:string,requestKey?:string):Promise<object|undefined>{
 const execution=executions.getStore();if(!execution)return undefined
 await assertSourceProviderExecution(true)
 const requestHash=createHash('sha256').update(JSON.stringify([reservationId,requestKey??null])).digest('hex')
 await metadata(execution.pool,async client=>{
  if((await client.query('SELECT shared.start_memory_source_provider($1,$2,$3) AS valid',[execution.executionId,reservationId,requestHash])).rows[0]?.valid!==true)throw changed()
 })
 const token=Object.freeze({});providerAttempts.set(token,{pool:execution.pool,executionId:execution.executionId,reservationId});return token
}
/** Abort-first callers must finish their independent usage callback before
 * native mode drain can consider the original request complete. No new receipt
 * protocol or authority is created: the existing attempt remains in-flight.
 * A failed callback/COMMIT leaves that durable hold for explicit forward repair. */
export async function withSourceProviderAccounting<T>(work:()=>Promise<T>):Promise<T>{
 if(providerAccounting.getStore())throw Error('source_provider_accounting_nested')
 return providerAccounting.run(new Map(),async()=>{
  try{
   const result=await work()
   for(const [token,effect] of providerAccounting.getStore()!)await persistSourceProviderEffect(token,effect)
   return result
  }catch(error){blockUnrecordedSourceEffect();throw error}
 })
}
/** Effect recording deliberately ignores current job/mode eligibility. */
export async function finishSourceProviderAttempt(token:object|undefined,state:ProviderEffect):Promise<void>{
 if(!token)return
 if(!providerAttempts.has(token))throw new SourceExecutionError('source_execution_scope_mismatch')
 const accounting=providerAccounting.getStore()
 if(accounting){
  if(accounting.has(token)&&accounting.get(token)!==state)throw Error('source_provider_effect_conflict')
  accounting.set(token,state);return
 }
 await persistSourceProviderEffect(token,state)
}
async function persistSourceProviderEffect(token:object,state:ProviderEffect):Promise<void>{
 const attempt=providerAttempts.get(token)
 if(!attempt)throw new SourceExecutionError('source_execution_scope_mismatch')
 await metadata(attempt.pool,async client=>{
  if((await client.query('SELECT shared.finish_memory_source_provider($1,$2,$3) AS valid',[attempt.executionId,attempt.reservationId,state])).rows[0]?.valid!==true)throw changed()
 })
}

/** Semantic publication/consumption retains the original private job capture.
 * Callers cannot substitute an execution-ID DTO after body or provider IO. */
export async function lockTeamSemanticExecutionGroup(client:Pick<pg.PoolClient,'query'>,installationId:string,roster:unknown,retained=false):Promise<void>{
 const execution=executions.getStore()
 if(execution&&(execution.branch!=='canonical-active'||execution.installationId!==installationId)||sourceConnectionKey(client)!==client)throw new SourceExecutionError('source_execution_scope_mismatch')
 if(execution)await guardSourceExecutionCommit(client,installationId)
 if((await client.query('SELECT shared.lock_memory_team_semantic_group($1,$2::jsonb,$3) AS locked',[execution?.executionId??null,JSON.stringify(roster),retained])).rows[0]?.locked!==true)throw Error('team_semantic_group_changed')
}
export function teamSemanticOriginalExecution(pool:pg.Pool,installationId:string):{token:object;executionId:string;controlRevision:string;generation:string}{
 const execution=executions.getStore()
 if(!execution||execution.pool!==pool||execution.branch!=='canonical-active'||execution.installationId!==installationId)throw new SourceExecutionError('source_execution_scope_mismatch')
 return {token:execution,executionId:execution.executionId,controlRevision:execution.controlRevision,generation:execution.generation}
}

/** Native semantic SUPPORT observations participate in provider admission.
 * A changed intrinsic digest is never accepted as a support-only refresh. */
export function observeTeamSemanticExecution(pool:pg.Pool,installationId:string,key:string,roster:unknown,businessDigest:string):void{
 const execution=executions.getStore()
 if(!execution)return
 if(execution.pool!==pool||execution.installationId!==installationId||execution.branch!=='canonical-active')throw new SourceExecutionError('source_execution_scope_mismatch')
 const old=execution.semanticObservations.get(key)
 if(old&&old.businessDigest!==businessDigest)throw Error('team_semantic_intrinsic_changed')
 if(!old&&execution.semanticObservations.size>=512)throw Error('team_semantic_group_limit')
 execution.semanticObservations.set(key,{roster:structuredClone(roster),businessDigest})
}
