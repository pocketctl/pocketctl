import {createHash} from 'node:crypto'
/** This component is explicitly enrolled in isolated callers only; native
 * migration, reporting, other callers and production lifecycle are not wired. */
export const PROVIDER_RECEIPT_PROTOCOL='provider-attempt-v1' as const
export const RECEIPT_IDENTITY=[
 ['original_attempt_id','uuid'],['budget_reservation_id','uuid'],['installation_id','uuid'],['operation_id','uuid'],
 ['caller_kind','text'],['operation','text'],['business_run_id','uuid'],['generation_run_id','uuid'],['subject_id','uuid'],
 ['source_execution_id','uuid'],['original_job_id','uuid'],['original_claim_epoch','bigint'],['result_owner_id','uuid'],
 ['leg','text'],['parent_attempt_id','uuid'],['route_fingerprint','bytea'],['provider','text'],['dispatched_model','text'],
 ['pricing_fingerprint','bytea'],['price_basis','text'],
] as const
export const RECEIPT_USAGE=[['received_model','text'],['input_tokens','bigint'],['output_tokens','bigint'],['cost_micros','bigint'],['received_at','timestamptz']] as const
export type ReceiptIdentityName=typeof RECEIPT_IDENTITY[number][0]
export type ReceiptIdentity=Readonly<Record<ReceiptIdentityName,string|Buffer|null>>
export interface ReceiptUsage {model:string;inputTokens:number;outputTokens:number;costMicros:number|null;receivedAt:string}
export interface ReceiptPricing {readonly inputRate?:number;readonly outputRate?:number}
export interface ReviewReceiptContext {
 installationId:string;runId:string;jobId:string;claimEpoch:number|string
 provider:string;model:string;routeFingerprint:Buffer;pricing:ReceiptPricing
}
export function receiptPricingSnapshot(pricing:ReceiptPricing,context:{provider:string;model:string}){
 for(const rate of [pricing.inputRate,pricing.outputRate])if(rate!==undefined&&(!Number.isFinite(rate)||rate<0))throw Error('invalid_receipt_pricing')
 const configured=pricing.inputRate!==undefined&&pricing.outputRate!==undefined
 return {basis:configured?'configured':'unknown',fingerprint:createHash('sha256').update(JSON.stringify(['token-round-v1',context.provider,context.model,pricing.inputRate!==undefined,pricing.inputRate??null,pricing.outputRate!==undefined,pricing.outputRate??null])).digest()}
}
export function validateReceiptUsage(u:ReceiptUsage){
 if(typeof u.model!=='string'||u.model.length<1||u.model.length>128||![u.inputTokens,u.outputTokens,...(u.costMicros===null?[]:[u.costMicros])].every(n=>Number.isSafeInteger(n)&&n>=0)||Number.isNaN(Date.parse(u.receivedAt)))throw Error('invalid_provider_receipt_usage')
}
export const receiptUsageId=(id:string)=>'provider-attempt:v1:'+id.toLowerCase()
export function identityValues(identity:ReceiptIdentity){return RECEIPT_IDENTITY.map(([name])=>identity[name])}
