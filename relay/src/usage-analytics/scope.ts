import {createHash} from 'node:crypto'
import type pg from 'pg'
import {UsageError,type AuthorizedWindow,type AuthorizedUsageScope,type Window} from './contracts.js'
export function assertPersonalQuery(q:Record<string,unknown>){for(const k of Object.keys(q))if(['user_id','userId','owner','owner_user_id','team','team_id','member','member_id','member_user_id','scope','daemon_ids','from','to','date_from','date_to','as_of','agent','model','days','granularity'].includes(k))throw new UsageError('scope_parameter_forbidden')}
export function mergeWindows(windows:AuthorizedWindow[]):AuthorizedWindow[]{const out:AuthorizedWindow[]=[];for(const w of [...windows].sort((a,b)=>a.ownerUserId-b.ownerUserId||a.daemonId.localeCompare(b.daemonId)||Date.parse(a.from)-Date.parse(b.from))){if(Date.parse(w.from)>=Date.parse(w.toExclusive))continue;const prev=out.at(-1);if(prev&&prev.ownerUserId===w.ownerUserId&&prev.daemonId===w.daemonId&&Date.parse(w.from)<=Date.parse(prev.toExclusive)){if(Date.parse(w.toExclusive)>Date.parse(prev.toExclusive))prev.toExclusive=w.toExclusive}else out.push({...w})}return out}
export function scopeIncludes(w:AuthorizedWindow[],owner:number,daemon:string,at:string){return w.some(x=>x.ownerUserId===owner&&x.daemonId===daemon&&Date.parse(at)>=Date.parse(x.from)&&Date.parse(at)<Date.parse(x.toExclusive))}
export function resolveTeamUsageScope():never {throw new UsageError('not_enabled',403)}
const hostSources=[
 ['token_usage_facts','user_id'],
 ['token_daily_stats','user_id'],
 ['usage_call_facts','owner_user_id'],
] as const

// Each source has an index beginning with (owner, daemon). Step to the next
// daemon instead of reading every accounting row to enumerate a few hosts.
function historicalHostsSQL() {
 const prefix=hostSources.map(([table,owner],index)=>`historical_${index} AS (
  (SELECT daemon_id FROM ${table} WHERE ${owner}=$1 ORDER BY daemon_id LIMIT 1)
  UNION ALL
  SELECT next_host.daemon_id FROM historical_${index} prev
  CROSS JOIN LATERAL (
   SELECT daemon_id FROM ${table} WHERE ${owner}=$1 AND daemon_id>prev.daemon_id ORDER BY daemon_id LIMIT 1
  ) next_host
 )`).join(',')
 return {
  prefix:'WITH RECURSIVE '+prefix,
  rows:hostSources.map((_source,index)=>`SELECT daemon_id,'历史主机' AS label,FALSE AS current_host FROM historical_${index}`),
 }
}
export async function resolvePersonalUsageScope(db:Pick<pg.Pool,'query'>,owner:number,daemon:string,w:Window):Promise<AuthorizedUsageScope>{
 const hosts=historicalHostsSQL()
 const rows=(await db.query(`${hosts.prefix}
 SELECT daemon_id,COALESCE(MAX(label) FILTER(WHERE current_host),'历史主机') AS label,bool_or(current_host) AS current_host FROM (
  SELECT daemon_id,COALESCE(NULLIF(alias,''),hostname,daemon_id) AS label,TRUE AS current_host FROM daemons WHERE user_id=$1
  UNION ALL ${hosts.rows.join(' UNION ALL ')}
 ) h WHERE daemon_id IS NOT NULL GROUP BY daemon_id ORDER BY daemon_id`,[owner])).rows
 if(daemon!=='all'&&!rows.some(r=>r.daemon_id===daemon))throw new UsageError('daemon_not_found',404)
 const daemons=rows.map(r=>({daemon_id:r.daemon_id,name:r.label,historical:!r.current_host}))
 const windows=daemons.filter(r=>daemon==='all'||r.daemon_id===daemon).map(r=>({
  ownerUserId:owner,daemonId:r.daemon_id,from:w.from,toExclusive:w.toExclusive,
 }))
 // A sequence can be allocated before a concurrent higher revision commits.
 // Digest the visible alias records so each subsequent change invalidates the
 // signed authorization even when it does not raise MAX(revision).
 const authority=(await db.query(`
  SELECT COALESCE(jsonb_agg(jsonb_build_array(old_session_id,next_session_id,original_daemon_id,
    request_daemon_id,blocked,owner_boundary,revision::text) ORDER BY old_session_id),'[]')::text AS aliases
  FROM session_aliases WHERE owner_user_id=$1
 `,[owner])).rows[0]?.aliases??'[]'
 return {kind:'personal',actorUserId:owner,windows,daemons,
  authorizationRevision:createHash('sha256').update(JSON.stringify([windows,authority])).digest('hex')}
}
