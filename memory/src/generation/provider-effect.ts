import {recordReviewProviderReceipt,findReviewProviderReceipt,type ProviderReceiptHandle} from '../model/provider-receipt.js'
import type pg from 'pg'
import type {ModelUsage} from '../ports/text-generator.js'
import type {EmbeddingResult} from '../ports/embedding-provider.js'
import {randomUUID} from 'node:crypto'
import {sourceConnectionKey} from '../sources/pool-context.js'

/** Review advice can become stale while the provider is responding. Its
 * content-free charge is independent of whether advice is still publishable. */
export async function recordReviewProviderUsage(pool:pg.Pool,input:{installationId:string;runId:string;usage?:ModelUsage;budgetReservationId?:string;providerReceipt?:ProviderReceiptHandle}):Promise<void>{
 const enrolled=input.providerReceipt??findReviewProviderReceipt(pool,input.budgetReservationId)
 if(enrolled){await recordReviewProviderReceipt(pool,{...input,providerReceipt:enrolled});return}
 const usage=input.usage;if(!usage)return
 if(sourceConnectionKey(pool)!==pool)throw Error('provider_effect_requires_physical_pool')
 if(![usage.inputTokens,usage.outputTokens,usage.costMicros??0].every(n=>Number.isSafeInteger(n)&&n>=0)||typeof usage.model!=='string'||usage.model.length<1||usage.model.length>200)throw Error('invalid_provider_effect_usage')
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[input.installationId])
  if(!(await client.query('SELECT installation_id FROM memory_installations WHERE installation_id=$1 AND local_status NOT IN(\'purging\',\'purged\') FOR KEY SHARE',[input.installationId])).rowCount){await client.query('COMMIT');return}
  await client.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,embedding_tokens,cached_tokens,cost_micros,occurred_at)
   SELECT installation_id,$3,'review_shadow',$4,$5,$6,0,0,$7,clock_timestamp() FROM memory_review_automation_runs
   WHERE installation_id=$1 AND run_id=$2 ON CONFLICT(installation_id,usage_id) DO NOTHING`,
   [input.installationId,input.runId,'review:'+input.runId,usage.model,usage.inputTokens,usage.outputTokens,usage.costMicros??0])
  await client.query('COMMIT')
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}

/** Each received embedding effect is recorded before validating/storing
 * vectors. A known charge survives a stale source/consent/output fence. */
export async function recordEmbeddingProviderUsage(pool:pg.Pool,installationId:string,result:EmbeddingResult):Promise<void>{
 if(sourceConnectionKey(pool)!==pool)throw Error('provider_effect_requires_physical_pool')
 if(![result.tokens,result.costMicros??0].every(n=>Number.isSafeInteger(n)&&n>=0)||typeof result.model!=='string'||result.model.length<1||result.model.length>160)throw Error('invalid_provider_effect_usage')
 const usageId='embedding:index:'+(result.budgetReservationId??randomUUID())
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[installationId])
  if(!(await client.query('SELECT installation_id FROM memory_installations WHERE installation_id=$1 AND local_status NOT IN(\'purging\',\'purged\') FOR KEY SHARE',[installationId])).rowCount){await client.query('COMMIT');return}
  await client.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,embedding_tokens,cached_tokens,cost_micros,occurred_at)
   SELECT installation_id,$2,'embedding',$3,0,0,$4,0,$5,clock_timestamp() FROM memory_installations WHERE installation_id=$1
   ON CONFLICT(installation_id,usage_id) DO NOTHING`,[installationId,usageId,result.model,result.tokens,result.costMicros??0])
  await client.query('COMMIT')
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}

/** Preserve incurred, content-free facts independently of output eligibility.
 * Never change run state, recreate a purged row, refund a reservation, or
 * acquire source/job fences here. This short physical transaction completes
 * before the caller attempts its separately fenced publication transaction. */
export async function recordGenerationProviderEffect(pool:pg.Pool,input:{
 installationId:string;generationRunId:string|null;runId:string
 operation:'build_wiki'|'extract_skill_candidate';usage?:ModelUsage;budgetReservationId?:string
}):Promise<void>{
 if(!input.usage&&!input.budgetReservationId)return
 if(sourceConnectionKey(pool)!==pool)throw Error('provider_effect_requires_physical_pool')
 const usage=input.usage
 if(usage&&(![usage.inputTokens,usage.outputTokens,usage.costMicros??0].every(n=>Number.isSafeInteger(n)&&n>=0)
  ||typeof usage.model!=='string'||usage.model.length<1||usage.model.length>160))throw Error('invalid_provider_effect_usage')
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[input.installationId])
  if(!(await client.query('SELECT installation_id FROM memory_installations WHERE installation_id=$1 AND local_status NOT IN(\'purging\',\'purged\') FOR KEY SHARE',[input.installationId])).rowCount){await client.query('COMMIT');return}
  // Match the worker's task/build-run -> generation row lock order. A stale
  // Skill generation must not replace a newer task-run reservation link.
  if(input.budgetReservationId){
   const table=input.operation==='build_wiki'?'memory_wiki_build_runs':'memory_skill_task_runs'
   await client.query(`UPDATE ${table} SET budget_reservation_id=COALESCE(budget_reservation_id,$4::uuid)
    WHERE installation_id=$1 AND run_id=$2 AND generation_run_id=$3`,[input.installationId,input.runId,input.generationRunId,input.budgetReservationId])
  }
  if(usage&&input.generationRunId){
   const effect=await client.query(`UPDATE memory_generation_runs SET
   provider='text',model=$4,input_tokens=$5,output_tokens=$6,cost_micros=$7
   WHERE installation_id=$1 AND run_id=$2 AND operation=$3 RETURNING run_id`,[input.installationId,input.generationRunId,input.operation,usage.model,usage.inputTokens,usage.outputTokens,usage.costMicros??0])
   if(effect.rowCount)await client.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,embedding_tokens,cached_tokens,cost_micros,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,0,0,$7,clock_timestamp()) ON CONFLICT(installation_id,usage_id) DO NOTHING`,
    [input.installationId,'generation:'+input.generationRunId,input.operation,usage.model,usage.inputTokens,usage.outputTokens,usage.costMicros??0])
  }
  await client.query('COMMIT')
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}

/** Curation's source can be revoked after HTTP returns. Its existing run
 * owns content-free token totals even when no candidate/receipt may commit. */
export async function recordCurationProviderUsage(pool:pg.Pool,input:{installationId:string;runId:string;inputTokens:number;outputTokens:number;model?:string;costMicros?:number}):Promise<void>{
 if(sourceConnectionKey(pool)!==pool)throw Error('provider_effect_requires_physical_pool')
 if(![input.inputTokens,input.outputTokens,input.costMicros??0].every(n=>Number.isSafeInteger(n)&&n>=0)||(input.model!==undefined&&(typeof input.model!=='string'||input.model.length<1||input.model.length>200)))throw Error('invalid_provider_effect_usage')
 const client=await pool.connect()
 try{
  await client.query('BEGIN');await client.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='1s'")
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[input.installationId])
  if(!(await client.query('SELECT installation_id FROM memory_installations WHERE installation_id=$1 AND local_status NOT IN(\'purging\',\'purged\') FOR KEY SHARE',[input.installationId])).rowCount){await client.query('COMMIT');return}
  const effect=await client.query(`UPDATE memory_curation_runs SET input_tokens=GREATEST(input_tokens,$3::bigint),
   output_tokens=GREATEST(output_tokens,$4::bigint) WHERE installation_id=$1 AND run_id=$2 RETURNING run_id`,[input.installationId,input.runId,input.inputTokens,input.outputTokens])
  if(effect.rowCount&&input.model)await client.query(`INSERT INTO memory_usage_outbox(installation_id,usage_id,operation,model,input_tokens,output_tokens,embedding_tokens,cached_tokens,cost_micros,occurred_at)
   VALUES($1,$2,'curation',$3,$4,$5,0,0,$6,clock_timestamp()) ON CONFLICT(installation_id,usage_id) DO NOTHING`,
   [input.installationId,'curation:'+input.runId,input.model,input.inputTokens,input.outputTokens,input.costMicros??0])
  await client.query('COMMIT')
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error}finally{client.release()}
}
