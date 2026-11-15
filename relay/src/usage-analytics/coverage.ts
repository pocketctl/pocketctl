import type {CoverageState} from './contracts.js'
export function coverageState(records:{from_at:string;to_exclusive:string;state:CoverageState}[],from:string,to:string):CoverageState {if(!records.length)return 'not_collected';let cursor=Date.parse(from);for(const r of [...records].sort((a,b)=>Date.parse(a.from_at)-Date.parse(b.from_at))){if(r.state!=='complete')continue;if(Date.parse(r.from_at)>cursor)break;cursor=Math.max(cursor,Date.parse(r.to_exclusive))}return cursor>=Date.parse(to)?'complete':records.some(r=>r.state==='complete'||r.state==='partial')?'partial':'unknown'}

import type pg from 'pg'
import type {AuthorizedUsageScope,Window} from './contracts.js'
export async function readUsageCoverage(db:Pick<pg.Pool,'query'>,scope:AuthorizedUsageScope,w:Window){
 const windows=JSON.stringify(scope.windows)
 const explicit=(await db.query(`SELECT daemon_id,agent_type,capability,from_at,to_exclusive,state,reason,source_cursor,last_synced_at FROM usage_collection_coverage f WHERE EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) x("ownerUserId" int,"daemonId" text,"from" timestamptz,"toExclusive" timestamptz) WHERE x."ownerUserId"=f.owner_user_id AND x."daemonId"=f.daemon_id) AND from_at<$3::timestamptz AND to_exclusive>$2::timestamptz`,[windows,w.from,w.toExclusive])).rows
 const observed=(await db.query(`WITH windows AS(SELECT * FROM jsonb_to_recordset($1::jsonb) x("ownerUserId" int,"daemonId" text,"from" timestamptz,"toExclusive" timestamptz)),sources AS(
 SELECT owner_user_id,daemon_id,agent_type,'tokens' AS capability,occurred_at,received_at,CASE WHEN quality='revision_order_unverified' THEN quality WHEN time_basis<>'source' THEN 'source_time_fallback' WHEN quality<>'normalized' THEN quality ELSE 'no_continuous_source_cursor' END AS reason FROM usage_token_projection
 UNION ALL SELECT owner_user_id,daemon_id,runtime,'tools',occurred_at,received_at,'no_continuous_source_cursor' FROM usage_call_facts
 UNION ALL SELECT owner_user_id,daemon_id,runtime,'skills',occurred_at,occurred_at,'no_continuous_source_cursor' FROM usage_skill_facts)
 SELECT daemon_id,agent_type,capability,MIN(occurred_at) AS from_at,MAX(received_at) AS last_synced_at,NULL::timestamptz AS to_exclusive,'partial' AS state,reason,NULL::text AS source_cursor
 FROM sources f WHERE occurred_at>=$2::timestamptz AND occurred_at<$3::timestamptz AND EXISTS(SELECT 1 FROM windows w WHERE w."ownerUserId"=f.owner_user_id AND w."daemonId"=f.daemon_id AND f.occurred_at>=w."from" AND f.occurred_at<w."toExclusive") GROUP BY daemon_id,agent_type,capability,reason`,[windows,w.from,w.toExclusive])).rows
 const result=[...explicit,...observed]
 for(const daemon of scope.daemons.filter(d=>scope.windows.some(w=>w.daemonId===d.daemon_id)))for(const capability of ['tokens','tools','skills'])if(!result.some(r=>r.daemon_id===daemon.daemon_id&&r.capability===capability))result.push({daemon_id:daemon.daemon_id,agent_type:'unknown',capability,from_at:null,to_exclusive:null,last_synced_at:null,state:'not_collected',reason:capability==='skills'?'no_explicit_skill_execution_evidence':'source_not_collected',source_cursor:null})
 return result
}
