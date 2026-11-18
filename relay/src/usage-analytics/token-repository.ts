import type pg from 'pg'
import type {AuthorizedUsageScope,Window} from './contracts.js'
import {mergeWindows} from './scope.js'
import {candidateAuthoritySQL,historyResidualSQL,historyWindowsSQL,tokenSourceColumns,tokenSourceShape} from './history-query.js'
/** A single authorized relation is shared by every aggregation. Legacy residuals
 * are scalar, unassigned and mutually exclusive with already projected facts.
 * Aggregate covered legacy facts once, rather than probing every fact again for
 * each daily row (and again when filtering positive residuals). Match on the
 * legacy fact's date/model: a correction may move the projection to another day
 * or model. EXISTS keeps multiple projection versions from multiplying facts. */
export const adoptedTokenSQL=`WITH windows AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("ownerUserId" int,"daemonId" text,"from" timestamptz,"toExclusive" timestamptz)),
 authority AS MATERIALIZED(SELECT * FROM usage_session_authority WHERE owner_user_id=ANY(SELECT DISTINCT "ownerUserId" FROM windows)),
 p AS(SELECT p.*,visible.current_session,parent.current_session AS current_parent,(COALESCE(parent.current_session,visible.current_session) IS NULL) AS identity_revoked FROM usage_token_projection p LEFT JOIN authority visible ON visible.owner_user_id=p.owner_user_id AND visible.daemon_id=p.daemon_id AND visible.source_session=p.source_session LEFT JOIN authority parent ON parent.owner_user_id=p.owner_user_id AND parent.daemon_id=p.daemon_id AND parent.source_session=p.parent_session_id WHERE occurred_at >= $2::timestamptz AND occurred_at<$3::timestamptz AND EXISTS(SELECT 1 FROM windows w WHERE w."ownerUserId"=p.owner_user_id AND w."daemonId"=p.daemon_id AND p.occurred_at>=w."from" AND p.occurred_at<w."toExclusive")),
 covered AS MATERIALIZED(
 SELECT f.user_id,f.daemon_id,f.usage_date,f.model,SUM(f.input+f.output+f.cache_read+f.cache_create) AS total
 FROM usage_source_metadata m JOIN token_usage_facts f ON f.fact_key=m.fact_key
 WHERE f.usage_date>=($2::timestamptz AT TIME ZONE 'UTC')::date AND f.usage_date<=($3::timestamptz AT TIME ZONE 'UTC')::date
 AND f.user_id IN(SELECT "ownerUserId" FROM windows)
 AND EXISTS(SELECT 1 FROM usage_token_projection q WHERE q.owner_user_id=f.user_id AND q.daemon_id=f.daemon_id AND q.source_session=m.source_session AND q.logical_usage_id=m.logical_usage_id)
 GROUP BY f.user_id,f.daemon_id,f.usage_date,f.model),
 residual AS(SELECT d.user_id AS owner_user_id,d.daemon_id,d.date::timestamp AT TIME ZONE 'UTC' AS occurred_at,
 GREATEST(0,(d.input+d.output+d.cache_read+d.cache_create)-COALESCE(c.total,0)) AS total
 FROM token_daily_stats d LEFT JOIN covered c ON c.user_id=d.user_id AND c.daemon_id=d.daemon_id AND c.usage_date=d.date AND c.model=d.model
 WHERE d.date>=($2::timestamptz AT TIME ZONE 'UTC')::date AND d.date<=($3::timestamptz AT TIME ZONE 'UTC')::date
 AND EXISTS(SELECT 1 FROM windows w WHERE w."ownerUserId"=d.user_id AND w."daemonId"=d.daemon_id AND d.date::timestamp AT TIME ZONE 'UTC'>=w."from" AND (d.date+1)::timestamp AT TIME ZONE 'UTC'<=w."toExclusive")),
 adopted AS(SELECT owner_user_id,daemon_id,current_session AS source_session,agent_type,model,occurred_at,input,output,cache_read,cache_create,total,request_id,quality,time_basis,(attribution_revoked OR identity_revoked) AS attribution_revoked,current_parent AS parent_session_id,child_agent_id FROM p
 UNION ALL SELECT owner_user_id,daemon_id,NULL,'unknown','unknown',occurred_at,NULL,NULL,NULL,NULL,total,NULL,'legacy_unverified','legacy_day',TRUE,NULL,NULL FROM residual WHERE total>0)
`
export const historyAdoptedTokenSQL=`WITH ${historyWindowsSQL},${historyResidualSQL},
 projected AS MATERIALIZED (
  SELECT w.owner AS owner_user_id,w.daemon AS daemon_id,${tokenSourceColumns},
     (p.occurred_at AT TIME ZONE 'UTC')::date AS day,input,output,cache_read,cache_create,total,
     (quality='normalized' AND time_basis='source') AS verified
  FROM live_windows w
  CROSS JOIN LATERAL (
   SELECT ${tokenSourceColumns},occurred_at,input,output,cache_read,cache_create,total,quality,time_basis
   FROM usage_token_projection WHERE owner_user_id=w.owner AND daemon_id=w.daemon
     AND occurred_at>=w.start_at AND occurred_at<w.end_at
   OFFSET 0
  ) p
  UNION ALL
  SELECT h.owner_user_id,h.daemon_id,${tokenSourceColumns},h.day,p.input,p.output,p.cache_read,
    p.cache_create,p.total,p.verified
  FROM history_days h JOIN usage_history_days d USING(owner_user_id,daemon_id,day)
  CROSS JOIN LATERAL jsonb_to_recordset(d.tokens) AS p(${tokenSourceShape})
 ),
 ${candidateAuthoritySQL('projected',true)},
 residual_days AS (
  SELECT * FROM legacy WHERE total>0
  UNION ALL
  SELECT h.owner_user_id,h.daemon_id,h.day,r.total
  FROM history_days h JOIN usage_history_days d USING(owner_user_id,daemon_id,day)
  CROSS JOIN LATERAL jsonb_to_recordset(d.residual) AS r(total numeric)
 ),
 adopted AS (
  SELECT p.owner_user_id,p.daemon_id,v.current_session AS source_session,p.agent_type,p.model,
    p.day::timestamp AT TIME ZONE 'UTC' AS occurred_at,p.input,p.output,p.cache_read,p.cache_create,
    p.total,p.request_id,p.verified,
    (p.attribution_revoked OR COALESCE(parent.current_session,v.current_session) IS NULL) AS attribution_revoked,
    parent.current_session AS parent_session_id,p.child_agent_id
  FROM projected p
  LEFT JOIN authority v ON v.owner_user_id=p.owner_user_id AND v.daemon_id=p.daemon_id AND v.source_session=p.source_session
  -- Keep the parent join on the complete identity. Separate owner/host
  -- equalities can choose a merge join that pairs nearly every host's rows.
  LEFT JOIN authority parent
    ON ARRAY[parent.owner_user_id::text,parent.daemon_id,parent.source_session]
       = CASE WHEN p.parent_session_id IS NOT NULL
           THEN ARRAY[p.owner_user_id::text,p.daemon_id,p.parent_session_id]
         END
  UNION ALL
  SELECT owner_user_id,daemon_id,NULL,'unknown','unknown',day::timestamp AT TIME ZONE 'UTC',
    NULL,NULL,NULL,NULL,total,NULL,FALSE,TRUE,NULL,NULL FROM residual_days
 )
`

export function historyParams(scope: AuthorizedUsageScope,w: Window): [string,string,string] {
 return [JSON.stringify(mergeWindows(scope.windows)),w.from,w.toExclusive]
}
export function aggregateSelectedTokensSQL(aggregate: boolean, history: boolean): string {
 const session=aggregate?'NULL::text':'source_session'
 const parent=aggregate?'NULL::text':'parent_session_id'
 const child=aggregate?'NULL::text':'child_agent_id'
 // The composite's text form quotes each field unambiguously. History can
 // dedupe the exact keys without a global dense-rank sort before grouping.
 const source=history?`SELECT selected.*,CASE WHEN request_id IS NOT NULL THEN ROW(owner_user_id,daemon_id,source_session,request_id)::text END AS request_key FROM selected`
  :`SELECT selected.*,CASE WHEN request_id IS NOT NULL THEN DENSE_RANK() OVER(
    ORDER BY owner_user_id,daemon_id,source_session,request_id) END::text AS request_key FROM selected`
 return `keyed AS (${source}),
 sums AS (
  SELECT owner_user_id,daemon_id,${session} AS source_session,agent_type,model,(occurred_at AT TIME ZONE 'UTC')::date::text AS date,
   CASE WHEN bool_and(input IS NOT NULL) THEN SUM(input)::text END AS input,
   CASE WHEN bool_and(output IS NOT NULL) THEN SUM(output)::text END AS output,
   CASE WHEN bool_and(cache_read IS NOT NULL) THEN SUM(cache_read)::text END AS cache_read,
   CASE WHEN bool_and(cache_create IS NOT NULL) THEN SUM(cache_create)::text END AS cache_create,
   SUM(total)::text AS total,bool_and(request_id IS NOT NULL) AS known_requests,
   ARRAY_AGG(DISTINCT request_key) FILTER(WHERE request_key IS NOT NULL) AS request_keys,
   bool_and(${history?'verified':"quality='normalized' AND time_basis='source'"}) AS verified,
   bool_or(attribution_revoked) AS attribution_revoked,${parent} AS parent_session_id,${child} AS child_agent_id
  FROM keyed GROUP BY owner_user_id,daemon_id,${session},agent_type,model,(occurred_at AT TIME ZONE 'UTC')::date,${parent},${child},attribution_revoked
 )
 SELECT owner_user_id,daemon_id,source_session,agent_type,model,date,input,output,cache_read,cache_create,total,
  CASE WHEN known_requests THEN cardinality(request_keys)::text END AS requests,
  request_keys,verified,attribution_revoked,parent_session_id,child_agent_id FROM sums`
}

export async function readTokenRows(db:Pick<pg.Pool,'query'>,scope:AuthorizedUsageScope,w:Window,options:{aggregate?:boolean;sessionIds?:string[];history?:boolean}={}){
 const adopted=options.history?historyAdoptedTokenSQL:adoptedTokenSQL
 const params=options.history?historyParams(scope,w):[JSON.stringify(scope.windows),w.from,w.toExclusive]
 return (await db.query<TokenRow>(adopted+`,selected AS(
  SELECT * FROM adopted WHERE ($4::text[] IS NULL OR source_session=ANY($4) OR parent_session_id=ANY($4))
 ) ,`+aggregateSelectedTokensSQL(options.aggregate??false,options.history??false),
 [...params,options.sessionIds??null])).rows
}
export interface TokenRow {owner_user_id:number;daemon_id:string;source_session:string|null;agent_type:string;model:string;date:string;input:string|null;output:string|null;cache_read:string|null;cache_create:string|null;total:string;requests:string|null;request_keys?:string[];verified:boolean;attribution_revoked:boolean;parent_session_id:string|null;child_agent_id:string|null}
