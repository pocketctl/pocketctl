import type pg from 'pg'
import type {AuthorizedUsageScope,Window} from './contracts.js'
/** A single authorized relation is shared by every aggregation. Legacy residuals
 * are scalar, unassigned and mutually exclusive with already projected facts. */
export const adoptedTokenSQL=`WITH windows AS(SELECT * FROM jsonb_to_recordset($1::jsonb) AS x("ownerUserId" int,"daemonId" text,"from" timestamptz,"toExclusive" timestamptz)),
 authority AS MATERIALIZED(SELECT * FROM usage_session_authority WHERE owner_user_id=ANY(SELECT DISTINCT "ownerUserId" FROM windows)),
 p AS(SELECT p.*,visible.current_session,parent.current_session AS current_parent,(COALESCE(parent.current_session,visible.current_session) IS NULL) AS identity_revoked FROM usage_token_projection p LEFT JOIN authority visible ON visible.owner_user_id=p.owner_user_id AND visible.daemon_id=p.daemon_id AND visible.source_session=p.source_session LEFT JOIN authority parent ON parent.owner_user_id=p.owner_user_id AND parent.daemon_id=p.daemon_id AND parent.source_session=p.parent_session_id WHERE occurred_at >= $2::timestamptz AND occurred_at<$3::timestamptz AND EXISTS(SELECT 1 FROM windows w WHERE w."ownerUserId"=p.owner_user_id AND w."daemonId"=p.daemon_id AND p.occurred_at>=w."from" AND p.occurred_at<w."toExclusive")),
 residual AS(SELECT d.user_id AS owner_user_id,d.daemon_id,d.date::timestamp AT TIME ZONE 'UTC' AS occurred_at,
 GREATEST(0,(d.input+d.output+d.cache_read+d.cache_create)-COALESCE((SELECT SUM(f.input+f.output+f.cache_read+f.cache_create) FROM token_usage_facts f WHERE f.user_id=d.user_id AND f.daemon_id=d.daemon_id AND f.usage_date=d.date AND f.model=d.model AND EXISTS(SELECT 1 FROM usage_source_metadata m JOIN usage_token_projection q ON q.owner_user_id=f.user_id AND q.daemon_id=f.daemon_id AND q.source_session=m.source_session AND q.logical_usage_id=m.logical_usage_id WHERE m.fact_key=f.fact_key)),0)) AS total
 FROM token_daily_stats d WHERE d.date>=($2::timestamptz AT TIME ZONE 'UTC')::date AND d.date<=($3::timestamptz AT TIME ZONE 'UTC')::date
 AND EXISTS(SELECT 1 FROM windows w WHERE w."ownerUserId"=d.user_id AND w."daemonId"=d.daemon_id AND d.date::timestamp AT TIME ZONE 'UTC'>=w."from" AND (d.date+1)::timestamp AT TIME ZONE 'UTC'<=w."toExclusive")),
 adopted AS(SELECT owner_user_id,daemon_id,current_session AS source_session,agent_type,model,occurred_at,input,output,cache_read,cache_create,total,request_id,quality,time_basis,(attribution_revoked OR identity_revoked) AS attribution_revoked,current_parent AS parent_session_id,child_agent_id FROM p
 UNION ALL SELECT owner_user_id,daemon_id,NULL,'unknown','unknown',occurred_at,NULL,NULL,NULL,NULL,total,NULL,'legacy_unverified','legacy_day',TRUE,NULL,NULL FROM residual WHERE total>0)
`
export async function readTokenRows(db:Pick<pg.Pool,'query'>,scope:AuthorizedUsageScope,w:Window,options:{aggregate?:boolean;sessionIds?:string[]}={}){
 const session=options.aggregate?'NULL::text':'source_session',parent=options.aggregate?'NULL::text':'parent_session_id',child=options.aggregate?'NULL::text':'child_agent_id'
 return (await db.query(adoptedTokenSQL+`,selected AS(SELECT * FROM adopted WHERE ($4::text[] IS NULL OR source_session=ANY($4) OR parent_session_id=ANY($4))),
 ranked AS(SELECT selected.*,CASE WHEN request_id IS NOT NULL THEN DENSE_RANK() OVER(ORDER BY owner_user_id,daemon_id,source_session,request_id) END AS request_rank FROM selected)
 SELECT owner_user_id,daemon_id,${session} AS source_session,agent_type,model,(occurred_at AT TIME ZONE 'UTC')::date::text AS date,
 CASE WHEN bool_and(input IS NOT NULL) THEN SUM(input)::text END AS input,CASE WHEN bool_and(output IS NOT NULL) THEN SUM(output)::text END AS output,CASE WHEN bool_and(cache_read IS NOT NULL) THEN SUM(cache_read)::text END AS cache_read,CASE WHEN bool_and(cache_create IS NOT NULL) THEN SUM(cache_create)::text END AS cache_create,SUM(total)::text AS total,
 CASE WHEN bool_and(request_id IS NOT NULL) THEN COUNT(DISTINCT request_rank)::text END AS requests,
 ARRAY_AGG(DISTINCT request_rank::text) FILTER(WHERE request_id IS NOT NULL) AS request_keys,
 bool_and(quality='normalized' AND time_basis='source') AS verified,bool_or(attribution_revoked) AS attribution_revoked,${parent} AS parent_session_id,${child} AS child_agent_id
 FROM ranked GROUP BY owner_user_id,daemon_id,${session},agent_type,model,(occurred_at AT TIME ZONE 'UTC')::date,${parent},${child},attribution_revoked`,[JSON.stringify(scope.windows),w.from,w.toExclusive,options.sessionIds??null])).rows as TokenRow[]
}
export interface TokenRow {owner_user_id:number;daemon_id:string;source_session:string|null;agent_type:string;model:string;date:string;input:string|null;output:string|null;cache_read:string|null;cache_create:string|null;total:string;requests:string|null;request_keys?:string[];verified:boolean;attribution_revoked:boolean;parent_session_id:string|null;child_agent_id:string|null}
