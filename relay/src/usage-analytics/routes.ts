import type pg from 'pg'
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify'
import {UsageError} from './contracts.js'
import {assertPersonalQuery,resolvePersonalUsageScope} from './scope.js'
import {parseRange,rangeWindow} from './range.js'
import {readUsageAnalyticsSchemaCapabilities} from './schema.js'
import {issueSnapshot,readSnapshot} from './snapshot.js'
import {getPersonalDashboard} from './token-service.js'
import {getPersonalSessions} from './session-service.js'
import {readUsageCoverage} from './coverage.js'
import {getPersonalCalls} from './call-service.js'
import {installUsageTimingHooks,startUsageTiming,type UsageTiming} from './observability.js'

export type PersonalEndpoint='dashboard'|'sessions'|'session'|'calls'|'object'|'coverage'

const allowedQuery=['contract','daemon','range','snapshot_token','page','limit','q','category','kind','call_object_id','skill_object_id']
function historyEnabled(actor: number) {
 if(process.env.PERSONAL_USAGE_HISTORY_READ!=='true')return false
 const owners=process.env.PERSONAL_USAGE_HISTORY_READ_OWNERS
 return owners===undefined||owners.split(',').some(value=>value.trim()===String(actor))
}

export async function personalUsageQuery(
 pool:pg.Pool, actor:number, q:Record<string,unknown>, endpoint:PersonalEndpoint, id?:string, timing?:UsageTiming,
){
 if(process.env.PERSONAL_USAGE_ENABLED!=='true')throw new UsageError('personal_usage_not_enabled',503)
 assertPersonalQuery(q)
 if(Object.keys(q).some(k=>!allowedQuery.includes(k)))throw new UsageError('invalid_query')
 if(q.contract!==undefined&&q.contract!=='personal-v1')throw new UsageError('unsupported_contract')
 const range=parseRange(q.range),daemon=q.daemon===undefined?'all':q.daemon
 if(typeof daemon!=='string'||daemon.length>64||!daemon)throw new UsageError('invalid_daemon')
 if(q.snapshot_token!==undefined&&typeof q.snapshot_token!=='string')throw new UsageError('invalid_query')
 const snapshot=typeof q.snapshot_token==='string'?readSnapshot(q.snapshot_token,actor,daemon,range):null
 const asOf=snapshot?new Date(snapshot.as_of):new Date()
 const measure=<T>(phase:Parameters<UsageTiming['measure']>[0],fn:()=>Promise<T>)=>timing?timing.measure(phase,fn):fn()
 let client:pg.PoolClient
 try { client=await measure('pool',()=>pool.connect()) }
 catch(error) {
  if(error instanceof Error&&error.message==='timeout exceeded when trying to connect')
   throw new UsageError('usage_pool_timeout',503)
  throw error
 }
 let destroy=false
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await client.query("SET LOCAL statement_timeout='5s'")
  const {historyWatermark}=await measure('readiness',()=>readUsageAnalyticsSchemaCapabilities(client)).catch(error=>{
   if((error as {code?:string}).code==='57014')throw error
   throw new UsageError('usage_schema_not_ready',503)
  })
  const history=historyWatermark&&endpoint!=='coverage'&&historyEnabled(actor)&&await measure('readiness',async()=>(
   await client.query('SELECT 1 FROM usage_history_owners WHERE owner_user_id=$1',[actor])
  ).rowCount===1)
  if(timing)timing.history=history
  const w=rangeWindow(range,asOf)
  const scope=await measure('authorization',()=>resolvePersonalUsageScope(client,actor,daemon,rangeWindow('all',asOf),history))
  if(snapshot&&snapshot.authorization_revision!==scope.authorizationRevision)throw new UsageError('snapshot_authorization_changed',409)
  // The ledger only appends until account deletion. SUM detects late commits
  // with lower allocated sequence values as well as newly allocated ones.
  const revision=await measure('snapshot',async()=>String((await client.query(`
   SELECT COALESCE(${historyWatermark?'SUM':'MAX'}(c.revision),0)::text AS revision FROM usage_scope_changes c
   WHERE c.owner_user_id=$1 AND EXISTS(
    SELECT 1 FROM jsonb_to_recordset($2::jsonb) w("ownerUserId" int,"daemonId" text,"from" timestamptz,"toExclusive" timestamptz)
    WHERE w."ownerUserId"=c.owner_user_id AND w."daemonId"=c.daemon_id
      AND c.from_at<w."toExclusive" AND c.to_exclusive>w."from"
      ${historyWatermark?`AND (NOT c.legacy_day OR (c.from_at>=w."from" AND c.to_exclusive<=w."toExclusive"))`:''})
  `,[actor,JSON.stringify(scope.windows)])).rows[0].revision))
  if(snapshot&&snapshot.revision!==revision)throw new UsageError('snapshot_changed',409)
  // Only read-service SQL uses this adapter; existing pool query overloads stay
  // available to callers. Timing counts every query, including a failed one.
  const db=timing?{query:(sql:string,params?:unknown[])=>measure('sql',()=>client.query(sql,params))} as Pick<pg.Pool,'query'>:client
  const data:any=await measure('result',async()=>{
   if(endpoint==='dashboard')return getPersonalDashboard(db,scope,range,asOf,history)
   if(endpoint==='sessions'||endpoint==='session')return getPersonalSessions(db,scope,range,asOf,q,endpoint==='session'?id:undefined,history)
   if(endpoint==='calls'||endpoint==='object')return getPersonalCalls(db,scope,range,asOf,q,endpoint==='object'?id:undefined,history)
   return {coverage:await readUsageCoverage(db,scope,w),reason:'Observed record dates are not continuous collection coverage.'}
  })
  const meta={
   contract:'personal-v1',accounting_version:'normalized-v1',scope:{kind:'personal',daemon},range,window_days:w.days,
   timezone:'UTC',requested_from:w.from,to_exclusive:asOf.toISOString(),as_of:asOf.toISOString(),
   display_from:data.analysis?.display_from??data.display_from??w.from,granularity:data.analysis?.granularity??data.granularity??'day',
   coverage:data.analysis?.coverage??(typeof data.coverage==='string'?data.coverage:'unknown'),
   snapshot_token:q.snapshot_token??issueSnapshot({actor,daemon,range,as_of:asOf.toISOString(),revision,authorization_revision:scope.authorizationRevision}),revision,
  }
  await client.query('COMMIT')
  return {meta,...data}
 }catch(error){
  try{await client.query('ROLLBACK')}catch{destroy=true}
  const code=(error as {code?:string}).code
  if(code==='42P01')throw new UsageError('usage_schema_not_ready',503)
  if(code==='57014')throw new UsageError('usage_query_timeout',503)
  throw error
 }finally{client.release(destroy)}
}

export async function replyPersonalUsage(
 req:FastifyRequest,reply:FastifyReply,pool:pg.Pool,actor:number,endpoint:PersonalEndpoint,id?:string,
){
 const timing=startUsageTiming(req,reply,endpoint)
 try{return await personalUsageQuery(pool,actor,req.query as Record<string,unknown>,endpoint,id,timing)}
 catch(error){
  timing.outcome=error instanceof UsageError?error.code:'unexpected_error'
  if(error instanceof UsageError)return reply.code(error.status).send({error:error.code})
  throw error
 }
}
export function registerPersonalUsageRoutes(app:FastifyInstance,options:{pool:pg.Pool;verify:(token:string)=>Promise<{userId:number}|null>;ready:()=>boolean}){
 installUsageTimingHooks(app)
 for(const [path,endpoint] of [['/api/usage/calls','calls'],['/api/usage/calls/:objectId','object'],['/api/usage/coverage','coverage']] as const){
  app.get(path,async(req,reply)=>{
   const header=req.headers.authorization
   const actor=header?.startsWith('Bearer ')?await options.verify(header.slice(7)):null
   if(!actor)return reply.code(401).send({error:'authorization_required'})
   if(!options.ready())return reply.code(503).send({error:'database_unavailable'})
   return replyPersonalUsage(req,reply,options.pool,actor.userId,endpoint,(req.params as {objectId?:string})?.objectId)
  })
 }
}
