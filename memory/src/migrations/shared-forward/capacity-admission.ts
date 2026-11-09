import {capacityPlan,type CapacityInput} from '../shared-source/capacity.js'
interface CapacityScope {manifestHash:string;migrationId:string;codeSha:string;sourceIdentity:string;targetIdentity:string}
export interface ForwardCapacityEvidence extends CapacityScope {
 schemaVersion:1;kind:'memory-forward-capacity';measuredAt:string;validUntil:string;measurements:CapacityInput
}
/** Reviewed measurements are bound to one frozen transfer. Never trust a
 * caller-provided `ready` flag or credit the disk that may be reclaimed later.
 * This is disk/window admission, not permission to activate or delete data. */
function inspectForwardCapacity(value:unknown,scope:CapacityScope,now:number,reserveFullWindow:boolean){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('forward_capacity_required')
 const evidence=value as ForwardCapacityEvidence
 if(evidence.schemaVersion!==1||evidence.kind!=='memory-forward-capacity')throw Error('forward_capacity_invalid')
 for(const key of ['manifestHash','migrationId','codeSha','sourceIdentity','targetIdentity'] as const)
  if(evidence[key]!==scope[key])throw Error('forward_capacity_scope_mismatch')
 const timestamp=(value:unknown)=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))throw Error('forward_capacity_invalid')
  const time=Date.parse(value)
  if(!Number.isFinite(time)||new Date(time).toISOString()!==(value.length===20?value.slice(0,-1)+'.000Z':value))throw Error('forward_capacity_invalid')
  return time
 }
 const measured=timestamp(evidence.measuredAt),expires=timestamp(evidence.validUntil)
 if(!Number.isFinite(measured)||!Number.isFinite(expires)||measured>now||expires<=now||expires<=measured||expires-measured>3600000)throw Error('forward_capacity_expired')
 if(!evidence.measurements||evidence.measurements.policy!=='forward-only')throw Error('forward_capacity_invalid')
 const report=capacityPlan(evidence.measurements)
 if(!report.ready)throw Error('forward_capacity_not_ready')
 if(reserveFullWindow&&BigInt(evidence.measurements.copySeconds!)+BigInt(evidence.measurements.indexSeconds!)>BigInt(Math.floor((expires-now)/1000)))throw Error('forward_capacity_window_insufficient')
 return report
}

/** Start requires the whole estimated copy/index window. Once execution has
 * begun, completed work does not need to reserve that full duration again at
 * every batch. All live checks retain the same immutable scope, measured disk
 * sufficiency and absolute <=1h deadline. No renewal or duration waiver. */
export function assertForwardCapacity(value:unknown,scope:CapacityScope,now=Date.now()){
 return inspectForwardCapacity(value,scope,now,true)
}
export function beginForwardCapacityRun(value:unknown,scope:CapacityScope,clock:()=>number=()=>Date.now()){
 const evidence=structuredClone(value),frozenScope=structuredClone(scope)
 assertForwardCapacity(evidence,frozenScope,clock())
 const check=()=>inspectForwardCapacity(evidence,frozenScope,clock(),false)
 return Object.freeze({check,checkWal(initial:string,current:string){
  check()
  if(!/^(0|[1-9][0-9]*)$/.test(initial??'')||!/^(0|[1-9][0-9]*)$/.test(current??''))throw Error('forward_wal_measurement_invalid')
  if(BigInt(current)>BigInt(initial)+BigInt((evidence as ForwardCapacityEvidence).measurements.walBytes!))throw Error('forward_wal_capacity_exceeded')
 }})
}
