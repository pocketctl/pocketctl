import type pg from 'pg'
import {UsageError,type AuthorizedUsageScope,type UsageRange} from './contracts.js'
import {readTokenRows,adoptedTokenSQL,historyAdoptedTokenSQL,aggregateSelectedTokensSQL,historyParams,type TokenRow} from './token-repository.js'
import {rangeWindow} from './range.js'
import {amounts,series} from './token-service.js'
import {resolveCallObject} from './call-service.js'
import {callSourceSQL} from './history-query.js'

const historyAssociation = `
 $6::text IS NULL OR EXISTS (
  SELECT 1 FROM (
   SELECT owner_user_id,daemon_id,source_session FROM (${callSourceSQL('skills',true)}) f
   WHERE $7='skills' AND skill_key=$6 AND NOT attribution_revoked
   UNION
   SELECT owner_user_id,daemon_id,source_session FROM (${callSourceSQL('calls',true)}) f
   WHERE $7<>'skills' AND tool_name=$6 AND tool_kind=$9
     AND COALESCE(mcp_server,'')=COALESCE($8,'') AND NOT attribution_revoked
  ) f
  JOIN usage_session_authority a USING(owner_user_id,daemon_id,source_session)
  WHERE f.owner_user_id=s.user_id AND a.current_session=s.session_id
 )`
export async function getPersonalSessions(db:Pick<pg.Pool,'query'>,scope:AuthorizedUsageScope,range:UsageRange,asOf:Date,q:Record<string,unknown>,sessionId?:string,history=false){
 const search=typeof q.q==='string'?q.q.trim():'';if(search.length>200)throw new UsageError('invalid_search')
 const page=Number(q.page??1),limit=Math.min(100,Number(q.limit??20));if(!Number.isInteger(page)||page<1||!Number.isInteger(limit)||limit<1)throw new UsageError('invalid_pagination')
 const object=q.call_object_id||q.skill_object_id?await resolveCallObject(db,scope,rangeWindow(range,asOf),String(q.call_object_id??q.skill_object_id),history):null,w=rangeWindow(range,asOf)
 const adopted=history?historyAdoptedTokenSQL:adoptedTokenSQL
 const owners=history?'SELECT owner FROM scope_windows':"SELECT DISTINCT (x->>'ownerUserId')::int FROM jsonb_array_elements($1::jsonb) x"
 const params=history?historyParams(scope,w):[JSON.stringify(scope.windows),w.from,w.toExclusive]
 const data=(await db.query(adopted+`,scores AS(
 SELECT owner_user_id,COALESCE(parent_session_id,source_session) AS session_id,SUM(total) AS token_total FROM adopted WHERE NOT attribution_revoked AND source_session IS NOT NULL GROUP BY owner_user_id,COALESCE(parent_session_id,source_session)),
 matched AS(SELECT s.session_id,s.title,s.agent_type,s.model,s.status,s.daemon_id,s.updated_at,(s.archived_at IS NOT NULL) AS archived,s.content_state,scores.token_total FROM sessions s LEFT JOIN scores ON scores.session_id=s.session_id AND scores.owner_user_id=s.user_id
 WHERE s.user_id=ANY(${owners}) AND s.content_state NOT IN('deleting','deleted') AND ($6::text IS NOT NULL OR scores.session_id IS NOT NULL) AND ($4::text IS NULL OR s.session_id=$4) AND ($5::text='' OR position(lower($5) in lower(COALESCE(s.title,'')||' '||s.session_id))>0)
 AND (${history?historyAssociation:`$6::text IS NULL OR ($7='skills' AND EXISTS(SELECT 1 FROM usage_skill_facts f WHERE f.owner_user_id=s.user_id AND EXISTS(SELECT 1 FROM authority a WHERE a.owner_user_id=f.owner_user_id AND a.daemon_id=f.daemon_id AND a.source_session=f.source_session AND a.current_session=s.session_id) AND f.skill_key=$6 AND NOT f.attribution_revoked AND f.occurred_at>=$2 AND f.occurred_at<$3 AND EXISTS(SELECT 1 FROM windows w WHERE w."ownerUserId"=f.owner_user_id AND w."daemonId"=f.daemon_id AND f.occurred_at>=w."from" AND f.occurred_at<w."toExclusive")))
 OR ($7<>'skills' AND EXISTS(SELECT 1 FROM usage_call_facts f WHERE f.owner_user_id=s.user_id AND EXISTS(SELECT 1 FROM authority a WHERE a.owner_user_id=f.owner_user_id AND a.daemon_id=f.daemon_id AND a.source_session=f.source_session AND a.current_session=s.session_id) AND f.tool_name=$6 AND f.tool_kind=$9 AND COALESCE(f.mcp_server,'')=COALESCE($8,'') AND NOT f.attribution_revoked AND f.occurred_at>=$2 AND f.occurred_at<$3 AND EXISTS(SELECT 1 FROM windows w WHERE w."ownerUserId"=f.owner_user_id AND w."daemonId"=f.daemon_id AND f.occurred_at>=w."from" AND f.occurred_at<w."toExclusive")))`})),
 page_rows AS(SELECT * FROM matched ORDER BY token_total DESC NULLS LAST,session_id LIMIT $10 OFFSET $11)
 ${history?`,selected AS (
  SELECT a.* FROM adopted a WHERE EXISTS (
   SELECT 1 FROM page_rows p WHERE p.session_id=a.source_session OR p.session_id=a.parent_session_id
  )
 ), token_rows AS (WITH ${aggregateSelectedTokensSQL(false,true)})`:''}
 SELECT (SELECT COUNT(*)::int FROM matched) AS count,COALESCE((SELECT jsonb_agg(to_jsonb(p)-'token_total' ORDER BY p.token_total DESC NULLS LAST,p.session_id) FROM page_rows p),'[]'::jsonb) AS sessions,
 (SELECT SUM(total)::text FROM adopted WHERE attribution_revoked OR source_session IS NULL) AS unattributed_total
 ${history?",COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM token_rows t),'[]') AS tokens":''}`,[...params,sessionId??null,search,object?.name??null,object?.kind??null,object?.server??null,object?.tool_kind??null,limit,(page-1)*limit])).rows[0]
 const sessions=data.sessions as any[];if(sessionId&&!sessions.length)throw new UsageError('session_not_found',404)
 const rows:TokenRow[]=history?data.tokens:sessions.length?await readTokenRows(db,scope,w,{sessionIds:sessions.map(s=>s.session_id)}):[]
 const list=sessions.map(s=>{const rs=rows.filter(r=>!r.attribution_revoked&&(r.parent_session_id??r.source_session)===s.session_id);return {...s,...amounts(rs),models:[...new Set(rs.map(r=>r.model))].sort(),body_available:['hot','cold','mixed','cooling'].includes(s.content_state),stats_available:rs.length>0,children:[...new Set(rs.filter(r=>r.child_agent_id).map(r=>r.child_agent_id))].sort().map(id=>({agent_id:id,...amounts(rs.filter(r=>r.child_agent_id===id))})),...(sessionId?series(rs,range,asOf):{})}})
 return {sessions:list,total:data.count,page,limit,unattributed_total:data.unattributed_total}
}
