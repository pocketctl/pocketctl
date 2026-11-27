import {createHash} from 'node:crypto'
import type pg from 'pg'
import {sourceConnectionKey} from '../sources/pool-context.js'
import {withTransaction} from '../db.js'
import {canonicalPacketJson} from '../episodes/packet.js'
import type {ModelUsage,TextGenerator} from '../ports/text-generator.js'
import {extractConclusions} from './conclusion-extractor.js'
import type {ExtractionInput,ExtractionResult} from './dialogue-extraction.js'

export const checkpointDigest=(value:unknown)=>createHash('sha256').update(canonicalPacketJson(value)).digest('hex')
type Positive = Extract<ExtractionResult,{ok:true}>
type Authorized = <T>(work:(client:pg.PoolClient)=>Promise<T>)=>Promise<T>
export interface BindingWitness {tasks:Record<string,string>;spaces:Record<string,string>}
export interface WindowWitness {callId:string;bindings:BindingWitness}
const unknown=():ExtractionResult=>({ok:false,code:'provider_result_unknown',retryable:false})

async function account(client:pg.PoolClient,installation:string,run:string,index:number,call:string,usage:ModelUsage){
 if(![usage.inputTokens,usage.outputTokens,usage.costMicros??0].every(v=>Number.isSafeInteger(v)&&v>=0)
   ||typeof usage.model!=='string'||!usage.model.length||usage.model.length>200)throw Error('invalid_provider_effect_usage')
 const changed=await client.query(`UPDATE memory_curation_calls SET usage=$4,updated_at=clock_timestamp()
   WHERE installation_id=$1 AND run_id=$2 AND call_id=$3 AND usage IS NULL`,[installation,run,call,usage])
 if(changed.rowCount)await client.query(`UPDATE memory_curation_runs SET input_tokens=input_tokens+$3,output_tokens=output_tokens+$4
   WHERE installation_id=$1 AND run_id=$2`,[installation,run,usage.inputTokens,usage.outputTokens])
 // A session purge can erase both the run and its call while HTTP is in flight.
 // The issued window identity still deduplicates its content-free charge.
 await client.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,embedding_tokens,cached_tokens,cost_micros,occurred_at)
   VALUES($1,$2,'curation',$3,$4,$5,0,0,$6,clock_timestamp()) ON CONFLICT DO NOTHING`,
   [installation,'curation:'+run+(index?':window:'+index:''),usage.model,usage.inputTokens,usage.outputTokens,usage.costMicros??0])
}

/** Only the provider adapter enters the send barrier. Validation stores source-grounded
 * conclusions and bounded rejection codes. Prompts, catalog prose and raw HTTP never persist. */
export function createWindowCheckpoints(input:{
 pool:pg.Pool;installation:string;run:string;runEpoch:number;modelHash:string;generator?:TextGenerator;routeMatches:boolean;bindings:BindingWitness;
 owned:Authorized;dispatch:Authorized;receipt:Authorized;witnesses:WindowWitness[];
}){
 if(sourceConnectionKey(input.pool)!==input.pool)throw Error('provider_effect_requires_physical_pool')
 return async (window:ExtractionInput,index:number):Promise<ExtractionResult>=>{
  const {installation,run,generator}=input
  const digest=checkpointDigest(window.sources), args=[installation,run,index] as const
  const call=await input.owned(async c=>{
   await c.query(`INSERT INTO memory_curation_calls(installation_id,run_id,window_index,input_digest)
     VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[...args,digest])
   return (await c.query('SELECT * FROM memory_curation_calls WHERE installation_id=$1 AND run_id=$2 AND window_index=$3',[...args])).rows[0]
  })
  if(call.input_digest!==digest)throw Error('curation_source_changed')
  function observed(result:Positive,bindings:BindingWitness){
   input.witnesses[index]={callId:call.call_id,bindings}
   return result
  }
  if(call.state==='saved'){
   if(checkpointDigest(call.response)!==call.response_digest)throw Error('curation_checkpoint_integrity')
   return call.response.ok?observed(call.response,call.bindings):call.response
  }
  if(call.state!=='intended')return unknown()
  if(!input.routeMatches)throw Error('curation_model_config_changed')
  if(!generator)return {ok:false,code:'budget_unavailable',retryable:true}
  // Only a new, still-unsent logical request can probe. Saved and unknown
  // windows exited above. The row lock grants at most one probe per cooldown.
  const paused=await input.owned(async c=>{
   const circuit=(await c.query(`SELECT failures,probe_after,probe_after>clock_timestamp() AS cooling
    FROM memory_curation_provider_circuits WHERE installation_id=$1 AND model_config_hash=$2 FOR UPDATE`,[installation,input.modelHash])).rows[0]
   if(!circuit||circuit.failures<3)return null
   if(circuit.cooling)return new Date(circuit.probe_after)
   await c.query("UPDATE memory_curation_provider_circuits SET probe_call_id=$3,probe_after=clock_timestamp()+interval '5 minutes' WHERE installation_id=$1 AND model_config_hash=$2",
    [installation,input.modelHash,call.call_id])
   return null
  })
  if(paused)return {ok:false,code:'provider_circuit_open',retryAt:paused.toISOString(),retryable:true}
  const markPossible=async (requestDigest:string,reservation?:string)=>input.dispatch(async c=>{
   const updated=await c.query(`UPDATE memory_curation_calls SET state='possible',budget_reservation_id=$4,dispatch_epoch=$5,request_digest=$6,updated_at=clock_timestamp()
    WHERE installation_id=$1 AND run_id=$2 AND call_id=$3 AND state='intended' AND (request_digest IS NULL OR request_digest=$6)`,[installation,run,call.call_id,reservation??null,input.runEpoch,requestDigest])
   return updated.rowCount===1
  })
  const resumeUnsentReservation=async()=>input.owned(async c=>!!(await c.query(
   "SELECT 1 FROM memory_curation_calls WHERE installation_id=$1 AND run_id=$2 AND call_id=$3 AND state='intended'",[installation,run,call.call_id])).rowCount)
  const guarded:TextGenerator={async generateJson<T>(prompt:Parameters<TextGenerator['generateJson']>[0]){
   const requestDigest=checkpointDigest([prompt.operation,prompt.system,prompt.document,prompt.schema])
   const authorizeDispatch=(reservation?:string)=>markPossible(requestDigest,reservation)
   if(!generator.budgetedDispatch&&!await authorizeDispatch())return {ok:false,code:'provider_result_unknown',retryable:false}
   return generator.generateJson<T>({...prompt,singleAttempt:true,requestKey:'curation-call:'+call.call_id,
    authorizeDispatch,resumeUnsentReservation})
  }}
  let result:ExtractionResult
  try{result=await extractConclusions(guarded,window)}
  catch{
   const state=(await input.pool.query('SELECT state FROM memory_curation_calls WHERE installation_id=$1 AND run_id=$2 AND call_id=$3',[installation,run,call.call_id])).rows[0]?.state
   result=state==='intended'?{ok:false,code:'source_not_sent',retryable:true}:unknown()
  }
  const uncertain=!result.ok&&(Boolean('billingUncertain' in result&&result.billingUncertain)||Boolean('timeoutFallback' in result&&result.timeoutFallback)||['provider_result_unknown','aborted','http_error'].includes(result.code))
  const refused=!result.ok&&!uncertain&&['budget_exceeded','budget_unavailable','source_not_sent'].includes(result.code)
  // Content-free incurred usage survives a revocation or a source protection failure.
  const accountSeparately=()=>withTransaction(input.pool,async c=>{
   await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
   await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[installation])
   if(!(await c.query("SELECT 1 FROM memory_installations WHERE installation_id=$1 AND local_status NOT IN('purging','purged') FOR KEY SHARE",[installation])).rowCount)return
   if(result.usage)await account(c,installation,run,index,call.call_id,result.usage)
   if(uncertain||refused){
    const transitioned=await c.query(`UPDATE memory_curation_calls SET state=$4,updated_at=clock_timestamp()
     WHERE installation_id=$1 AND run_id=$2 AND call_id=$3 AND (state='intended' OR (state='possible' AND dispatch_epoch=$5))`,
     [installation,run,call.call_id,uncertain?'unknown':'intended',input.runEpoch])
    if(uncertain&&transitioned.rowCount)await c.query(`INSERT INTO memory_curation_provider_circuits(installation_id,model_config_hash,failures)
     VALUES($1,$2,1) ON CONFLICT(installation_id,model_config_hash) DO UPDATE SET failures=LEAST(3,memory_curation_provider_circuits.failures+1),
      probe_after=CASE WHEN memory_curation_provider_circuits.failures>=2 THEN clock_timestamp()+interval '5 minutes' END,
      probe_call_id=NULL`,[installation,input.modelHash])
   }
  })
  if(uncertain||refused){
   await accountSeparately()
   return uncertain?{...unknown(),...(result.usage?{usage:result.usage}:{})}:result
  }
  const responseDigest=checkpointDigest(result)
  // No queue lease or processing pin is needed to checkpoint a late reply.
  // The caller locks current policy, purge fences and the original source proof.
  const saved=await input.receipt(async c=>{
   const row=(await c.query('SELECT state,response_digest FROM memory_curation_calls WHERE installation_id=$1 AND run_id=$2 AND call_id=$3 FOR UPDATE',
    [installation,run,call.call_id])).rows[0]
   if(!row||['withdrawn','conflict'].includes(row.state))return false
   if(row.response_digest){
    if(row.response_digest===responseDigest)return row.state==='saved'
    await c.query("UPDATE memory_curation_calls SET state='conflict',response=NULL,conflicting_digest=$4,updated_at=clock_timestamp() WHERE installation_id=$1 AND run_id=$2 AND call_id=$3",
     [installation,run,call.call_id,responseDigest]);return false
   }
   if(result.usage)await account(c,installation,run,index,call.call_id,result.usage)
   await c.query(`DELETE FROM memory_curation_provider_circuits WHERE installation_id=$1 AND model_config_hash=$2
     AND (failures<3 OR probe_call_id=$3)`,[installation,input.modelHash,call.call_id])
   const stored=await c.query(`UPDATE memory_curation_calls SET state='saved',response=$4,response_digest=$5,bindings=$6,updated_at=clock_timestamp()
    WHERE installation_id=$1 AND run_id=$2 AND call_id=$3 AND state IN ('possible','unknown')`,
    [installation,run,call.call_id,JSON.stringify(result),responseDigest,input.bindings])
   if(stored.rowCount)await c.query(`UPDATE memory_curation_runs SET recovery_at=clock_timestamp(),
     error_code=CASE WHEN state='running' AND claim_epoch=$3 AND error_code IS NULL THEN 'provider_response_received' ELSE error_code END
     WHERE installation_id=$1 AND run_id=$2 AND (state<>'completed' OR recovery_at IS NOT NULL)`,[installation,run,input.runEpoch])
   return stored.rowCount===1
  }).catch(async error=>{
   await accountSeparately()
   throw error
  })
  if(!saved){await accountSeparately();return unknown()}
  return result.ok?observed(result,input.bindings):result
 }
}
