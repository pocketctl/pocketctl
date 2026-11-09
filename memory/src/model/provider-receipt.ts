import {blockUnrecordedSourceEffect} from '../sources/source-execution.js'
import pg from 'pg'
import {randomUUID} from 'node:crypto'
import {ProviderDrain} from './provider-drain.js'
import {RECEIPT_IDENTITY,RECEIPT_USAGE,identityValues,receiptPricingSnapshot,validateReceiptUsage,type ReceiptIdentity,type ReceiptUsage,type ReviewReceiptContext} from './provider-receipt-contract.js'
import type {ModelJsonResult,ModelUsage} from '../ports/text-generator.js'
export interface ReviewReceiptRequest {readonly kind:'review-receipt-request'}
export interface ProviderReceiptHandle {readonly kind:'provider-receipt-handle'}
interface RequestState {repository:ProviderReceiptRepository;context:ReviewReceiptContext;identity:ReceiptIdentity}
interface HandleState extends RequestState {usage?:ReceiptUsage;handle:ProviderReceiptHandle}
const requests=new WeakMap<object,RequestState>(),handles=new WeakMap<object,HandleState>()
const reservations=new WeakMap<pg.Pool,Map<string,ProviderReceiptHandle>>()
const reservationHandles=(pool:pg.Pool)=>{let map=reservations.get(pool);if(!map){map=new Map();reservations.set(pool,map)}return map}
const state=(handle:ProviderReceiptHandle)=>{const s=handles.get(handle);if(!s)throw Error('invalid_provider_receipt_handle');return s}
const usageParams=(u?:ReceiptUsage)=>u?[u.model,u.inputTokens,u.outputTokens,u.costMicros,u.receivedAt]:[null,null,null,null,null]
const casts=[...RECEIPT_IDENTITY,...RECEIPT_USAGE].map(([,t],i)=>'$'+(i+1)+'::'+t).join(',')
export class ProviderReceiptRepository {
 readonly drain=new ProviderDrain()
 private readonly ownerId=randomUUID()
 private readonly retry=new Map<string,HandleState>()
 constructor(readonly pool:pg.Pool,options:{enrollment:'explicit-isolated-review-component';reporter:'not-started'}){
  if(options.enrollment!=='explicit-isolated-review-component'||options.reporter!=='not-started')throw Error('receipt_component_not_enrolled')
 }
 review(context:ReviewReceiptContext):ReviewReceiptRequest{
  if(reservationHandles(this.pool).size>=4096)throw Error('receipt_component_handle_capacity')
  for(const id of [context.installationId,context.runId,context.jobId])if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw Error('invalid_receipt_original_identity')
  if(!/^[1-9][0-9]*$/.test(String(context.claimEpoch)))throw Error('invalid_receipt_claim_epoch')
  if(!Buffer.isBuffer(context.routeFingerprint)||context.routeFingerprint.length!==32)throw Error('invalid_receipt_route')
  const pricing=Object.freeze({...context.pricing}),frozen=Object.freeze({...context,pricing,routeFingerprint:Buffer.from(context.routeFingerprint)}),snapshot=receiptPricingSnapshot(pricing,{provider:context.provider,model:context.model})
  const identity:ReceiptIdentity=Object.freeze({original_attempt_id:randomUUID(),budget_reservation_id:null,installation_id:context.installationId,operation_id:randomUUID(),caller_kind:'review',operation:'review_shadow',business_run_id:context.runId,generation_run_id:null,subject_id:null,source_execution_id:null,original_job_id:context.jobId,original_claim_epoch:String(context.claimEpoch),result_owner_id:this.ownerId,leg:'single',parent_attempt_id:null,route_fingerprint:Buffer.from(context.routeFingerprint),provider:context.provider,dispatched_model:context.model,pricing_fingerprint:snapshot.fingerprint,price_basis:snapshot.basis})
  const request=Object.freeze({kind:'review-receipt-request' as const});requests.set(request,{repository:this,context:frozen,identity});return request
 }
 private async transaction<T>(work:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
  const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'");const result=await work(c);await c.query('COMMIT');return result}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
 }
 async status(installationId:string,attemptId:string){return (await this.pool.query('SELECT * FROM memory.read_provider_receipt_status_v1($1,$2)',[installationId,attemptId])).rows[0]??null}
 async call(name:'receive_provider_receipt_v1'|'commit_provider_sink_independent_v1'|'commit_provider_sink_v1',identity:ReceiptIdentity,usage?:ReceiptUsage){
  const result=await this.transaction(async c=>(await c.query(`SELECT memory.${name}(${casts}) AS outcome`,[...identityValues(identity),...usageParams(usage)])).rows[0].outcome as string)
  // A conflict result is visible only after actual physical COMMIT.
  if(result==='conflict')throw Error('provider_receipt_conflict')
  return result
 }
 async admit(request:ReviewReceiptRequest,reservationId:string):Promise<ProviderReceiptHandle>{
  const r=requests.get(request);if(!r||r.repository!==this)throw Error('invalid_provider_receipt_request')
  const identity={...r.identity,budget_reservation_id:reservationId}
  const result=await this.transaction(async c=>(await c.query(`SELECT memory.admit_provider_receipt_v1(${RECEIPT_IDENTITY.map(([,t],i)=>'$'+(i+1)+'::'+t).join(',')}) AS outcome`,identityValues(identity))).rows[0].outcome)
  if(result!=='admitted')throw Error(result==='conflict'?'provider_receipt_conflict':'provider_receipt_already_admitted')
  const row=await this.status(String(identity.installation_id),String(identity.original_attempt_id));if(!row)throw Error('receipt_admission_ack_unproved')
  const canonical=Object.freeze(Object.fromEntries(RECEIPT_IDENTITY.map(([key])=>[key,row[key]]))) as ReceiptIdentity
  if(reservationHandles(this.pool).size>=4096)throw Error('receipt_component_handle_capacity')
  const handle=Object.freeze({kind:'provider-receipt-handle' as const});handles.set(handle,{...r,identity:canonical,handle});reservationHandles(this.pool).set(reservationId,handle)
  const begin=await this.transaction(async c=>(await c.query('SELECT memory.begin_provider_dispatch_v1($1,$2) AS outcome',[canonical.original_attempt_id,canonical.result_owner_id])).rows[0].outcome)
  if(begin!=='started')throw Error('receipt_dispatch_refused')
  return handle
 }
 async observe(handle:ProviderReceiptHandle,usage?:ModelUsage){
  const s=state(handle);if(s.repository!==this)throw Error('receipt_repository_mismatch')
  if(!usage){await this.transaction(async c=>c.query('SELECT memory.finish_provider_unknown_v1($1,$2)',[s.identity.original_attempt_id,s.identity.result_owner_id]));return}
  const pricing=s.context.pricing,cost=s.identity.price_basis==='configured'?Math.round((usage.inputTokens*pricing.inputRate!+usage.outputTokens*pricing.outputRate!)/1000000):null
  s.usage={model:usage.model,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,costMicros:cost,receivedAt:new Date().toISOString()};validateReceiptUsage(s.usage)
  this.retry.set(String(s.identity.original_attempt_id),s)
  await this.flushOne(s)
 }
 private async flushOne(s:HandleState){
  if(!s.usage)return
  // Both paths are attempted independently; neither central failure nor sink
  // failure can roll back the other physical COMMIT.
  const central=await this.call('receive_provider_receipt_v1',s.identity,s.usage).then(outcome=>({outcome}),error=>({error}))
  const sink=await this.call('commit_provider_sink_independent_v1',s.identity,s.usage).then(outcome=>({outcome}),error=>({error}))
  if('error'in central&&String(central.error).includes('provider_receipt_conflict'))throw central.error
  if('outcome'in sink&&sink.outcome==='conflict_unpreserved'){
   await this.call('receive_provider_receipt_v1',s.identity,s.usage)
   throw Error('provider_receipt_conflict_unpreserved')
  }
  try{
   // The receive routine resolves a lost central ACK against the exact tuple.
   await this.call('receive_provider_receipt_v1',s.identity,s.usage)
   const outcome=await this.call('commit_provider_sink_v1',s.identity,s.usage)
   if(outcome==='committed'||outcome==='committed_same')this.retry.delete(String(s.identity.original_attempt_id))
  }catch(error){if(String(error).includes('provider_receipt_conflict'))throw error}
 }
 async flushKnown(){const errors:unknown[]=[];for(const s of this.retry.values()){try{await this.flushOne(s)}catch(error){errors.push(error)}}if(errors.length)throw new AggregateError(errors,'provider_receipt_retries_blocked')}
 async reconcile(identity:ReceiptIdentity){
  await this.call('receive_provider_receipt_v1',identity)
  const row=await this.status(String(identity.installation_id),String(identity.original_attempt_id));if(!row||row.phase!=='received')throw Error('receipt_reconciliation_pending')
  const usage:ReceiptUsage={model:row.received_model,inputTokens:Number(row.input_tokens),outputTokens:Number(row.output_tokens),costMicros:row.cost_micros===null?null:Number(row.cost_micros),receivedAt:row.received_at.toISOString()}
  return this.call('commit_provider_sink_v1',identity,usage)
 }
 async assertReceiptDrain(client:pg.PoolClient,installationId:string){
  const before=(await client.query("SELECT pg_current_xact_id()::text AS xid,pg_advisory_xact_lock(hashtextextended('provider-receipt:'||$1::text,0))",[installationId])).rows[0].xid
  const counts=(await client.query('SELECT * FROM memory.read_provider_receipt_drain_v1($1)',[installationId])).rows[0]
  const after=(await client.query('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid
  if(before!==after)throw Error('receipt_drain_requires_transaction')
  if([counts.pending_original_count,counts.unknown_unresolved_count,counts.conflict_count].some(n=>Number(n)>0))throw Error('provider_receipts_not_drained')
  return counts
 }
}
export function assertReviewReceiptRequest(request:ReviewReceiptRequest,installationId:string,runId:string){const s=requests.get(request);if(!s||s.context.installationId!==installationId||s.context.runId!==runId)throw Error('receipt_review_scope_mismatch')}
export async function admitProviderReceipt(request:ReviewReceiptRequest,reservationId:string){const s=requests.get(request);if(!s)throw Error('invalid_provider_receipt_request');return s.repository.admit(request,reservationId)}
export function trackReviewReceiptBusiness<T>(request:ReviewReceiptRequest,promise:Promise<T>){const s=requests.get(request);if(!s)throw Error('invalid_provider_receipt_request');return s.repository.drain.track('business',promise)}
export function trackProviderReceipt<T>(handle:ProviderReceiptHandle,work:()=>Promise<ModelJsonResult<T>>):Promise<ModelJsonResult<T>>{
 const s=state(handle)
 const promise=Promise.resolve().then(async()=>{let result:ModelJsonResult<T>;try{result=await work()}catch(error){await s.repository.observe(handle).catch(()=>{});throw error}
  await s.repository.observe(handle,result.usage)
  const known=s.usage
  const usage=known?{model:known.model,inputTokens:known.inputTokens,outputTokens:known.outputTokens,...(known.costMicros===null?{}:{costMicros:known.costMicros})}:undefined
  const row=await s.repository.status(String(s.identity.installation_id),String(s.identity.original_attempt_id)).catch(()=>null)
  if(known&&(!row||row.phase!=='received'||row.sink_state!=='recorded'||row.conflict_at)){blockUnrecordedSourceEffect();return {ok:false,code:'provider_result_unknown',retryable:false,billingUncertain:true,...(usage?{usage}:{}),budgetReservationId:result.budgetReservationId,providerReceipt:handle} as ModelJsonResult<T>}
  return {...result,...(usage?{usage}:{}),providerReceipt:handle} as ModelJsonResult<T>
 })
 return s.repository.drain.track('original',promise)
}
export async function recordReviewProviderReceipt(pool:pg.Pool,input:{installationId:string;runId:string;usage?:ModelUsage;budgetReservationId?:string;providerReceipt:ProviderReceiptHandle}){
 const s=state(input.providerReceipt);if(s.repository.pool!==pool)throw Error('receipt_physical_pool_mismatch')
 if(!input.usage)return
 const candidate:ReceiptIdentity={...s.identity,installation_id:input.installationId,business_run_id:input.runId,budget_reservation_id:input.budgetReservationId??null}
 const usage:ReceiptUsage={model:input.usage.model,inputTokens:input.usage.inputTokens,outputTokens:input.usage.outputTokens,costMicros:input.usage.costMicros??null,receivedAt:s.usage?.receivedAt??''}
 await s.repository.call('receive_provider_receipt_v1',candidate,usage)
 await s.repository.call('commit_provider_sink_v1',candidate,usage)
}
export function providerReceiptIdentity(handle:ProviderReceiptHandle):ReceiptIdentity{return state(handle).identity}

export function assertProviderReceiptBudgetInput(request:ReviewReceiptRequest,operation:string,requestKey?:string){const s=requests.get(request);if(!s||operation!=='review_shadow'||requestKey!=='review:'+s.context.runId)throw Error('receipt_budget_identity_mismatch')}
export const findReviewProviderReceipt=(pool:pg.Pool,reservationId?:string)=>reservationId?reservationHandles(pool).get(reservationId):undefined
