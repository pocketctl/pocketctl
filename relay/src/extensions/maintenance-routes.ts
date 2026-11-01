import type {FastifyInstance} from 'fastify'
import type pg from 'pg'
import {verifyProviderExtensionToken} from './provider-auth.js'
import {maintenanceCounts} from '../session-lifecycle/maintenance-summary.js'

/** Closed numeric reporting contract. Provider identity can only report its
 * own personal installation; no session titles, content or global counters. */
export function registerMaintenanceRoutes(app:FastifyInstance,deps:{pool:pg.Pool;mode:string;providerJwtSecret:string;issuer:string}){
 app.post('/api/extensions/v1/maintenance',{bodyLimit:4096},async(req,reply)=>{
  const fail=(status:number,code:string)=>reply.code(status).send({error:{code}})
  if(deps.mode!=='enabled')return fail(503,'feature_disabled')
  const auth=req.headers.authorization
  const identity=auth?.startsWith('Bearer ')?verifyProviderExtensionToken(auth.slice(7),{secret:deps.providerJwtSecret,issuer:deps.issuer}):null
  if(!identity)return fail(401,'unauthorized')
  const b=req.body as Record<string,any>|null
  const allowed=['installation_id','scheduled_at','revision','state','counts','last_error_code','started_at','completed_at']
  if(!b||Object.keys(b).some(k=>!allowed.includes(k))||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(b.installation_id??'')
   ||!Number.isSafeInteger(b.revision)||b.revision<1||!['running','completed'].includes(b.state)
   ||!b.counts||typeof b.counts!=='object'||Array.isArray(b.counts)
   ||Object.entries(b.counts).some(([k,v])=>!(maintenanceCounts as readonly string[]).includes(k)||!Number.isSafeInteger(v)||Number(v)<0)
   ||(b.last_error_code!=null&&!/^[a-zA-Z0-9_]{1,64}$/.test(b.last_error_code)))return fail(400,'invalid_request')
  if(typeof b.scheduled_at!=='string'||typeof b.started_at!=='string'||(b.completed_at!=null&&typeof b.completed_at!=='string'))return fail(400,'invalid_request')
  const slot=new Date(b.scheduled_at),started=new Date(b.started_at),completed=b.completed_at?new Date(b.completed_at):null
  if(!Number.isFinite(slot.getTime())||!Number.isFinite(started.getTime())||slot.toISOString().slice(11)!=='19:00:00.000Z'
   ||slot.getTime()>Date.now()||slot.getTime()<Date.now()-90*86400000
   ||(completed&&!Number.isFinite(completed.getTime()))||(b.state==='completed'&&!completed)||started<slot||started.getTime()>Date.now()+300000
   ||(completed&&(completed<started||completed.getTime()>Date.now()+300000)))return fail(400,'invalid_request')
  const result=await deps.pool.query(`INSERT INTO maintenance_provider_results(installation_id,scheduled_at,revision,state,counts,last_error_code,started_at,completed_at)
   SELECT $1,$3,$4,$5,$6,$7,$8,$9 WHERE EXISTS(SELECT 1 FROM extension_installations
    WHERE installation_id=$1 AND provider_id=$2 AND owner_type='user' AND status IN('active','paused'))
   ON CONFLICT(installation_id,scheduled_at) DO UPDATE SET revision=EXCLUDED.revision,state=EXCLUDED.state,
    counts=EXCLUDED.counts,last_error_code=EXCLUDED.last_error_code,started_at=EXCLUDED.started_at,
    completed_at=EXCLUDED.completed_at,updated_at=NOW() WHERE maintenance_provider_results.revision<EXCLUDED.revision
   RETURNING installation_id`,[b.installation_id,identity.providerId,slot,b.revision,b.state,JSON.stringify(b.counts),b.last_error_code??null,started,completed])
  if(!result.rowCount){
   const exists=await deps.pool.query(`SELECT 1 FROM extension_installations WHERE installation_id=$1 AND provider_id=$2 AND owner_type='user' AND status IN('active','paused')`,[b.installation_id,identity.providerId])
   if(!exists.rowCount)return fail(404,'not_found')
  }
  return {accepted:true}
 })
}
