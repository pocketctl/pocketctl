import type pg from 'pg'
import type {FastifyInstance} from 'fastify'
import {UsageError} from './contracts.js'
import {assertPersonalQuery,resolvePersonalUsageScope} from './scope.js'
import {parseRange,rangeWindow} from './range.js'
import {assertUsageAnalyticsSchema} from './schema.js'
import {issueSnapshot,readSnapshot} from './snapshot.js'
import {getPersonalDashboard} from './token-service.js'
import {getPersonalSessions} from './session-service.js'
import {readUsageCoverage} from './coverage.js'
import {getPersonalCalls} from './call-service.js'
export type PersonalEndpoint='dashboard'|'sessions'|'session'|'calls'|'object'|'coverage'
export async function personalUsageQuery(pool:pg.Pool,actor:number,q:Record<string,unknown>,endpoint:PersonalEndpoint,id?:string){
 if(process.env.PERSONAL_USAGE_ENABLED!=='true')throw new UsageError('personal_usage_not_enabled',503)
 assertPersonalQuery(q);const allowed=['contract','daemon','range','snapshot_token','page','limit','q','category','kind','call_object_id','skill_object_id'];if(Object.keys(q).some(k=>!allowed.includes(k)))throw new UsageError('invalid_query')
 if(q.contract!==undefined&&q.contract!=='personal-v1')throw new UsageError('unsupported_contract')
 const range=parseRange(q.range),daemon=q.daemon===undefined?'all':q.daemon;if(typeof daemon!=='string'||daemon.length>64||!daemon)throw new UsageError('invalid_daemon')
 const snapshot=typeof q.snapshot_token==='string'?readSnapshot(q.snapshot_token,actor,daemon,range):null,asOf=snapshot?new Date(snapshot.as_of):new Date()
 const client=await pool.connect();try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='5s'");try{await assertUsageAnalyticsSchema(client as unknown as pg.Pool)}catch{throw new UsageError('usage_schema_not_ready',503)}
  const w=rangeWindow(range,asOf),scope=await resolvePersonalUsageScope(client as unknown as pg.Pool,actor,daemon,rangeWindow('all',asOf));if(snapshot&&snapshot.authorization_revision!==scope.authorizationRevision)throw new UsageError('snapshot_authorization_changed',409)
  const revision=String((await client.query(`SELECT COALESCE(MAX(c.revision),0)::text AS revision FROM usage_scope_changes c WHERE c.owner_user_id=$1 AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) w("ownerUserId" int,"daemonId" text,"from" timestamptz,"toExclusive" timestamptz) WHERE w."ownerUserId"=c.owner_user_id AND w."daemonId"=c.daemon_id AND c.from_at<w."toExclusive" AND c.to_exclusive>w."from")`,[actor,JSON.stringify(scope.windows)])).rows[0].revision);if(snapshot&&snapshot.revision!==revision)throw new UsageError('snapshot_changed',409);let data:any
  if(endpoint==='dashboard')data=await getPersonalDashboard(client as unknown as pg.Pool,scope,range,asOf)
  else if(endpoint==='sessions'||endpoint==='session')data=await getPersonalSessions(client as unknown as pg.Pool,scope,range,asOf,q,endpoint==='session'?id:undefined)
  else if(endpoint==='calls'||endpoint==='object')data=await getPersonalCalls(client as unknown as pg.Pool,scope,range,asOf,q,endpoint==='object'?id:undefined)
  else data={coverage:await readUsageCoverage(client as unknown as pg.Pool,scope,w),reason:'Observed record dates are not continuous collection coverage.'}
  const meta={contract:'personal-v1',accounting_version:'normalized-v1',scope:{kind:'personal',daemon},range,window_days:w.days,timezone:'UTC',requested_from:w.from,to_exclusive:asOf.toISOString(),as_of:asOf.toISOString(),display_from:data.analysis?.display_from??data.display_from??w.from,granularity:data.analysis?.granularity??data.granularity??'day',coverage:data.analysis?.coverage??(typeof data.coverage==='string'?data.coverage:'unknown'),snapshot_token:q.snapshot_token??issueSnapshot({actor,daemon,range,as_of:asOf.toISOString(),revision,authorization_revision:scope.authorizationRevision}),revision}
  await client.query('COMMIT');return {meta,...data}
 }catch(e){await client.query('ROLLBACK');if((e as any).code==='42P01')throw new UsageError('usage_schema_not_ready',503);throw e}finally{client.release()}
}
export function usageErrorReply(reply:any,error:unknown){if(error instanceof UsageError)return reply.code(error.status).send({error:error.code});throw error}
export function registerPersonalUsageRoutes(app:FastifyInstance,options:{pool:pg.Pool;verify:(token:string)=>Promise<{userId:number}|null>;ready:()=>boolean}){for(const [path,endpoint] of [['/api/usage/calls','calls'],['/api/usage/calls/:objectId','object'],['/api/usage/coverage','coverage']] as const)app.get(path,async(req,reply)=>{const header=req.headers.authorization;const actor=header?.startsWith('Bearer ')?await options.verify(header.slice(7)):null;if(!actor)return reply.code(401).send({error:'authorization_required'});if(!options.ready())return reply.code(503).send({error:'database_unavailable'});try{return await personalUsageQuery(options.pool,actor.userId,req.query as Record<string,unknown>,endpoint,(req.params as any)?.objectId)}catch(e){return usageErrorReply(reply,e)}})}
