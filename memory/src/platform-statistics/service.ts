import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { statisticsEnabled, HEARTBEAT_MAX_AGE_MS } from './schema.js'

type QueryClient=Pick<pg.PoolClient,'query'>
export interface FirstClaimInput {installationId:string;claimId:string;source:'manual'|'automatic'|'unclassified'}
export interface UsageInput {installationId?:string;membershipId?:string;requestId:string;kind:'read'|'write';operation:string;humanActivity?:boolean}
const requestIds=new WeakMap<object,string>()
/** Server-generated identity survives fan-out without trusting client retry headers. */
export function statisticsRequestId(request:object):string {
  let id=requestIds.get(request)
  if(!id){id=randomUUID();requestIds.set(request,id)}
  return id
}
export function actorInstallationId(grant:unknown):string|undefined {
  if(!grant||typeof grant!=='object')return undefined
  const g=grant as {version?:string;primaryInstallationId?:string;installationId?:string}
  return g.version==='v2'?g.primaryInstallationId:g.installationId
}
/** The verified primary binding identifies the caller even when its scope is shared. */
export function actorUsageContext(grant:unknown):{installationId?:string;membershipId?:string} {
  if(!grant||typeof grant!=='object')return {}
  const g=grant as {version?:string;primaryInstallationId?:string;installationId?:string;scopeBindings?:Array<{installation_id:string;owner_scope_kind:string;membership_id?:string|null}>}
  if(g.version!=='v2')return {installationId:g.installationId}
  const binding=g.scopeBindings?.find(b=>b.installation_id===g.primaryInstallationId)
  if(!binding)return {}
  if(binding.owner_scope_kind==='personal')return {installationId:binding.installation_id}
  return binding.membership_id?{installationId:binding.installation_id,membershipId:binding.membership_id}:{}
}
const MCP_READ_TOOLS=new Set(['memory_git_status','memory_git_diff','memory_list_scenes','memory_search','memory_recall','memory_get_claim','memory_get_evidence_reference','memory_read_evidence_content','memory_get_evidence','memory_find_related_episodes','memory_get_repository_context','memory_get_code_graph','memory_analyze_change_impact','memory_get_wiki_page','memory_list_skills','memory_get_skill','memory_resolve_skill'])
export function isSuccessfulMcpRead(request:unknown,response:unknown):boolean {
  const req=request as {method?:string;params?:{name?:string}},res=response as {error?:unknown;result?:{isError?:boolean;content?:Array<{type:string;text?:string}>}}
  if(req?.method!=='tools/call'||!MCP_READ_TOOLS.has(req.params?.name??'')||!res?.result||res.error||res.result.isError===true)return false
  // Legacy business tools encode bounded errors as JSON text rather than
  // setting isError. These are failed reads as well.
  for(const content of res.result.content??[]){
    if(content.type!=='text'||!content.text)continue
    try{const value=JSON.parse(content.text);if(value&&typeof value==='object'&&value.error)return false}catch{/* A textual successful response remains a read. */}
  }
  return true
}
async function lockInstallation(c:QueryClient,id:string){
  await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||$1,0))",[id])
}
async function lockActiveInstallation(c:QueryClient,id:string):Promise<boolean>{
  // Capture holds the installation row until commit. Revocation already owns
  // that same row, so its privacy trigger needs no inverse advisory lock.
  return !!(await c.query(`SELECT 1 FROM memory_installations WHERE installation_id=$1
    AND local_status NOT IN('purging','purged','integrity_error') AND relay_status='active' FOR SHARE`,[id])).rowCount
}
async function usageGap(c:QueryClient){
  await c.query("INSERT INTO memory_platform_stats_gaps VALUES('usage',clock_timestamp()-interval '1 millisecond',clock_timestamp()+interval '1 millisecond')")
}
export async function recordFirstClaim(c:QueryClient,input:FirstClaimInput):Promise<void>{
  if(!statisticsEnabled())return
  await lockInstallation(c,input.installationId)
  if(!await lockActiveInstallation(c,input.installationId))return
  await c.query(`INSERT INTO memory_platform_stats_claims(installation_id,claim_id,source)
    SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM memory_installations WHERE installation_id=$1
      AND local_status NOT IN('purging','purged','integrity_error') AND relay_status='active')
    ON CONFLICT(installation_id,claim_id) DO NOTHING`,[input.installationId,input.claimId,input.source])
}
/** Existing transaction clients keep usage atomic with explicit writes. Pool
 * callers use their own short transaction so purge cannot race attribution. */
export async function recordUsage(db:QueryClient|pg.Pool,input:UsageInput):Promise<void>{
  if(!statisticsEnabled())return
  if('connect' in db&&!('release' in db)){
    const c=await (db as pg.Pool).connect()
    try{await c.query('BEGIN');await recordUsage(c,input);await c.query('COMMIT')}
    catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
    return
  }
  if(!input.installationId){await usageGap(db);return}
  await lockInstallation(db,input.installationId)
  if(!await lockActiveInstallation(db,input.installationId)){await usageGap(db);return}
  const key=createHash('sha256').update((input.membershipId??'')+'\0'+input.kind+'\0'+input.operation+'\0'+input.requestId).digest('hex')
  const result=await db.query(`INSERT INTO memory_platform_stats_usage(installation_id,request_key,kind,human_activity,membership_id)
    SELECT $1,$2,$3,$4,$5::uuid WHERE EXISTS(SELECT 1 FROM memory_installations i JOIN memory_owner_scopes s USING(installation_id)
      WHERE i.installation_id=$1 AND s.state='active'
        AND ((s.owner_scope_kind='personal' AND $5::uuid IS NULL) OR (s.owner_scope_kind IN('team','organization') AND EXISTS(SELECT 1 FROM memory_scope_memberships m WHERE m.installation_id=i.installation_id AND m.membership_id=$5::uuid AND m.state='active')))
        AND i.local_status NOT IN('purging','purged','integrity_error') AND i.relay_status='active')
    ON CONFLICT(installation_id,request_key) DO UPDATE SET human_activity=memory_platform_stats_usage.human_activity OR EXCLUDED.human_activity
    RETURNING installation_id`,[input.installationId,key,input.kind,input.humanActivity===true,input.membershipId??null])
  if(!result.rowCount)await usageGap(db)
}
/** Privacy deletion removes installation identifiers, then invalidates the
 * affected historical interval; no anonymous count is represented as complete. */
export async function purgeStatistics(c:QueryClient,installationId:string):Promise<void>{
  // Opting out stops new observations; it never disables privacy cleanup of
  // facts collected earlier. An installation with no stats schema is inert.
  if(!statisticsEnabled()&&!(await c.query("SELECT to_regclass('memory_platform_stats_usage') IS NOT NULL AS relation_present")).rows[0]?.relation_present)return
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('purge:installation:'||$1,0))",[installationId])
  for(const [table,metric] of [['memory_platform_stats_claims','memory'],['memory_platform_stats_usage','usage']]){
    await c.query(`INSERT INTO memory_platform_stats_gaps SELECT $2,min(occurred_at),clock_timestamp() FROM ${table} WHERE installation_id=$1 HAVING count(*)>0`,[installationId,metric])
    await c.query(`DELETE FROM ${table} WHERE installation_id=$1`,[installationId])
  }
}
export interface SnapshotQuery {from:Date;to:Date;previousFrom:Date;previousTo:Date;excludeInstallationIds:string[]}
export function parseSnapshotQuery(raw:unknown):SnapshotQuery {
  if(!raw||typeof raw!=='object')throw new Error('invalid interval')
  const q=raw as Record<string,unknown>
  if(Object.keys(q).some(k=>!['from','to','previousFrom','previousTo','excludeInstallationIds'].includes(k)))throw new Error('invalid query')
  const date=(key:string)=>{const s=q[key];if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s))throw new Error('UTC ISO interval required');const d=new Date(s);if(!Number.isFinite(d.getTime())||d.toISOString().replace('.000Z','Z')!==s.replace('.000Z','Z'))throw new Error('invalid interval');return d}
  const from=date('from'),to=date('to'),previousFrom=date('previousFrom'),previousTo=date('previousTo')
  const duration=to.getTime()-from.getTime(),prior=previousTo.getTime()-previousFrom.getTime()
  if(duration<=0||duration>90*86_400_000||prior!==duration||previousTo.getTime()>from.getTime()||to.getTime()>Date.now()+1000)throw new Error('invalid interval')
  const excludes=q.excludeInstallationIds===undefined?[]:typeof q.excludeInstallationIds==='string'?q.excludeInstallationIds.split(','):['invalid']
  if(excludes.length>1000||excludes.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))throw new Error('invalid exclusions')
  return {from,to,previousFrom,previousTo,excludeInstallationIds:excludes}
}
export interface Actor {installationId:string;membershipId?:string;readRequests:number;writeRequests:number;humanActivity:boolean}
export interface Period {memory:number;automatic:number;manual:number;unclassified:number;daily:Array<{date:string;memory:number;automatic:number;manual:number;unclassified:number}>;actors:Actor[];dailyActors:Array<Actor&{date:string}>}
export async function loadStatisticsSnapshot(pool:pg.Pool,q:SnapshotQuery){
  const c=await pool.connect()
  try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const now=(await c.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const collectors=(await c.query('SELECT collector,coverage_start,last_seen FROM memory_platform_stats_collectors')).rows as Array<{collector:string;coverage_start:Date;last_seen:Date}>
    const coverageStart=collectors.length===2?new Date(Math.max(...collectors.map(r=>r.coverage_start.getTime()))).toISOString():null
    const gapRows=(await c.query(`SELECT metric,gap_from,gap_to FROM memory_platform_stats_gaps
      WHERE gap_from<$2 AND gap_to>$1 ORDER BY gap_from LIMIT 20001`,[q.previousFrom,q.to])).rows
    let actorLimitExceeded=gapRows.length>20000
    const gaps=gapRows.slice(0,20000).map(r=>({metric:r.metric as 'memory'|'usage',from:r.gap_from.toISOString(),to:r.gap_to.toISOString()}))
    for(const row of collectors)if(now.getTime()-row.last_seen.getTime()>HEARTBEAT_MAX_AGE_MS)for(const metric of ['memory','usage'] as const)gaps.push({metric,from:row.last_seen.toISOString(),to:now.toISOString()})
    const period=async(from:Date,to:Date):Promise<Period>=>{
      const values=[from,to,q.excludeInstallationIds]
      const rows=(await c.query(`SELECT to_char(occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,
        count(*)::int AS memory,count(*) FILTER(WHERE source='automatic')::int AS automatic,
        count(*) FILTER(WHERE source='manual')::int AS manual,count(*) FILTER(WHERE source='unclassified')::int AS unclassified
        FROM memory_platform_stats_claims WHERE occurred_at>=$1 AND occurred_at<$2 AND NOT(installation_id=ANY($3::uuid[])) GROUP BY 1 ORDER BY 1`,values)).rows
      const actorDays=(await c.query(`SELECT to_char(occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,
        installation_id::text AS "installationId",membership_id::text AS "membershipId",count(*) FILTER(WHERE kind='read')::int AS "readRequests",
        count(*) FILTER(WHERE kind='write')::int AS "writeRequests",bool_or(human_activity) AS "humanActivity"
        FROM memory_platform_stats_usage WHERE occurred_at>=$1 AND occurred_at<$2 AND NOT(installation_id=ANY($3::uuid[]))
        GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 20001`,values)).rows as Array<Actor&{date:string}>
      if(actorDays.length>20000)actorLimitExceeded=true
      const dailyActors=actorDays.slice(0,20000).map(({membershipId,...row})=>({...row,...(membershipId?{membershipId}:{})})),actors=new Map<string,Actor>()
      for(const row of dailyActors){const key=row.installationId+':'+(row.membershipId??'');const actor=actors.get(key)??{installationId:row.installationId,...(row.membershipId?{membershipId:row.membershipId}:{}),readRequests:0,writeRequests:0,humanActivity:false};actor.readRequests+=row.readRequests;actor.writeRequests+=row.writeRequests;actor.humanActivity ||=row.humanActivity;actors.set(key,actor)}
      const sum=(key:'memory'|'automatic'|'manual'|'unclassified')=>rows.reduce((n,r)=>n+r[key],0)
      return {memory:sum('memory'),automatic:sum('automatic'),manual:sum('manual'),unclassified:sum('unclassified'),daily:rows as Period['daily'],actors:[...actors.values()],dailyActors}
    }
    const current=await period(q.from,q.to),previous=await period(q.previousFrom,q.previousTo)
    // Both periods share one capped actor-day budget; never return silently
    // truncated identities as a complete distinct-user population.
    if(current.dailyActors.length+previous.dailyActors.length>20000){actorLimitExceeded=true;current.actors=[];current.dailyActors=[];previous.actors=[];previous.dailyActors=[]}
    await c.query('COMMIT')
    return {coverageStart,dataThrough:now.toISOString(),gaps,periods:{current,previous},actorLimitExceeded}
  }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
}
