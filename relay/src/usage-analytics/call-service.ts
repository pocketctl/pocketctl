import {createHash} from 'node:crypto'
import type pg from 'pg'
import {UsageError,type AuthorizedUsageScope,type UsageRange,type Window} from './contracts.js'
import {buckets,granularity,rangeWindow} from './range.js'
import {candidateAuthoritySQL,callSourceSQL,historyWindowsSQL,scopeWindowsSQL} from './history-query.js'
import {historyParams} from './token-repository.js'

export function callWindowsSQL(history: boolean): string {
 return history?historyWindowsSQL:scopeWindowsSQL+',live_windows AS (SELECT * FROM scope_windows)'
}

async function readCallRows(db:Pick<pg.Pool,'query'>,scope:AuthorizedUsageScope,w:Window,kind:'calls'|'skills',history:boolean) {
 const dimensions=kind==='calls'?'tool_kind,tool_name,mcp_server':'skill_key,skill_name'
 const outcomes=kind==='calls'?`,
  COALESCE(sum(n) FILTER(WHERE outcome='success' AND has_start),0)::text AS success,
  COALESCE(sum(n) FILTER(WHERE outcome='failure' AND has_start),0)::text AS failure,
  COALESCE(sum(n) FILTER(WHERE outcome='unknown' OR NOT has_start),0)::text AS unknown`:''
 return (await db.query(`
 WITH ${callWindowsSQL(history)}, source_rows AS MATERIALIZED (${callSourceSQL(kind,history)}),
 ${candidateAuthoritySQL('source_rows')}
 SELECT ${dimensions},f.day::text AS date,sum(n)::text AS count${outcomes},
   ARRAY_AGG(DISTINCT a.current_session)
     FILTER(WHERE NOT f.attribution_revoked AND a.current_session IS NOT NULL) AS session_ids
 FROM source_rows f LEFT JOIN authority a USING(owner_user_id,daemon_id,source_session)
 GROUP BY ${dimensions},f.day
 ORDER BY f.day,${dimensions}
 `,historyParams(scope,w))).rows
}
export function objectId(kind:string,name:string,server:string|null=null,tool_kind:string|null=null){return ({tools:'t',mcp:'m',skills:'s'} as Record<string,string>)[kind]+'_'+createHash('sha256').update(JSON.stringify([kind,name,server,tool_kind])).digest('base64url')}
export function parseObjectId(id:string):{kind:string;key:string}{if(!/^[tms]_[A-Za-z0-9_-]{43}$/.test(id))throw new UsageError('object_not_found',404);return {kind:({t:'tools',m:'mcp',s:'skills'} as Record<string,string>)[id[0]],key:id}}
export async function resolveCallObject(db:Pick<pg.Pool,'query'>,scope:AuthorizedUsageScope,w:Window,id:string,history=false){
 const {kind}=parseObjectId(id)
 const skills=kind==='skills'
 const dimensions=skills?'skill_key AS name,NULL::text AS server,NULL::text AS tool_kind':'tool_name AS name,mcp_server AS server,tool_kind'
 const rows=(await db.query(`
 WITH ${callWindowsSQL(history)}
 SELECT DISTINCT ${dimensions} FROM (${callSourceSQL(skills?'skills':'calls',history)}) f
 ${kind==='mcp'?"WHERE tool_kind='mcp'":''}
 `,historyParams(scope,w))).rows
 const result=rows.find(row=>objectId(kind,row.name,row.server,row.tool_kind)===id);if(!result)throw new UsageError('object_not_found',404);return {kind,...result} as {kind:string;name:string;server:string|null;tool_kind:string|null}
}
export async function getPersonalCalls(db:Pick<pg.Pool,'query'>,scope:AuthorizedUsageScope,range:UsageRange,asOf:Date,q:Record<string,unknown>,detailId?:string,history=false){
 const w=rangeWindow(range,asOf)
 const calls=await readCallRows(db,scope,w,'calls',history)
 const skills=await readCallRows(db,scope,w,'skills',history)
 const sum=(rs:any[],key='count')=>rs.length?rs.reduce((n,r)=>n+BigInt(r[key]??0),0n).toString():null
 const category=detailId?parseObjectId(detailId).kind:String(q.category??'tools');if(!['tools','mcp','skills'].includes(category))throw new UsageError('invalid_category')
 const source=category==='skills'?skills:category==='mcp'?calls.filter(r=>r.tool_kind==='mcp'):calls
 const groups=new Map<string,any[]>();for(const r of source){const key=category==='skills'?r.skill_key:JSON.stringify([r.tool_kind,r.mcp_server??'',r.tool_name]);const group=groups.get(key);if(group)group.push(r);else groups.set(key,[r])}
 const ranking=[...groups].map(([name,rs])=>({object_id:objectId(category,category==='skills'?name:rs[0].tool_name,rs[0].mcp_server??null,rs[0].tool_kind??null),name:rs[0].skill_name??rs[0].tool_name??name,mcp_server:rs[0].mcp_server??null,count:sum(rs),success:category==='skills'?null:sum(rs,'success'),failure:category==='skills'?null:sum(rs,'failure'),unknown:category==='skills'?null:sum(rs,'unknown'),sessions:String(new Set(rs.flatMap(r=>r.session_ids??[])).size),coverage:'partial'})).sort((a,b)=>BigInt(a.count??0)>BigInt(b.count??0)?-1:BigInt(a.count??0)<BigInt(b.count??0)?1:a.object_id.localeCompare(b.object_id))
 const first=[...calls,...skills].map(r=>r.date).sort()[0]??null;const unit=granularity(range,first,asOf);const series=buckets(w,unit,first?new Date(Math.max(Date.parse(w.from),Date.parse(first))).toISOString():w.from).map(b=>{const inBucket=(r:any)=>Date.parse(r.date)>=Date.parse(b.bucket_start)&&Date.parse(r.date)<Date.parse(b.end_exclusive);const c=calls.filter(inBucket),s=skills.filter(inBucket);return {...b,tools:sum(c),mcp:sum(c.filter(r=>r.tool_kind==='mcp')),skills:sum(s),coverage:c.length||s.length?'partial':'not_collected'}})
 const page=Number(q.page??1),limit=Math.min(100,Number(q.limit??20));if(!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1)throw new UsageError('invalid_pagination')
 if(detailId){const item=ranking.find(r=>r.object_id===detailId);if(!item)throw new UsageError('object_not_found',404);return {object:item,related_query:category==='skills'?{skill_object_id:detailId}:{call_object_id:detailId},token_attribution:null}}
 return {summary:{tools:sum(calls),mcp:sum(calls.filter(r=>r.tool_kind==='mcp')),skills:sum(skills),builtin:sum(calls.filter(r=>r.tool_kind==='builtin')),unclassified:sum(calls.filter(r=>r.tool_kind==='unknown'))},series,granularity:unit,display_from:first??w.from,category,ranking:ranking.slice((page-1)*limit,page*limit),total:ranking.length,page,limit,coverage:calls.length||skills.length?'partial':'not_collected'}
}
