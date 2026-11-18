import type pg from 'pg'
import { DAY } from './range.js'
import { callSourceColumns, callSourceSQL, historyResidualSQL, scopeWindowsSQL, skillSourceColumns, tokenSourceColumns } from './history-query.js'

export interface HistoryDayPayload {
 tokens: string
 residual: string
 calls: string
 skills: string
}

// Return JSON as text; pg must not decode exact PG numeric totals into JS Number.
export async function buildHistoryDay(
 db: Pick<pg.Pool,'query'>, owner: number, daemon: string, day: string,
): Promise<HistoryDayPayload> {
 const from=new Date(day+'T00:00:00Z').toISOString()
 const toExclusive=new Date(Date.parse(from)+DAY).toISOString()
 const result=await db.query<HistoryDayPayload>(`
 WITH ${scopeWindowsSQL},live_windows AS (SELECT * FROM scope_windows),${historyResidualSQL},
 token_rows AS (
  SELECT ${tokenSourceColumns},
    CASE WHEN bool_and(input IS NOT NULL) THEN sum(input) END AS input,
    CASE WHEN bool_and(output IS NOT NULL) THEN sum(output) END AS output,
    CASE WHEN bool_and(cache_read IS NOT NULL) THEN sum(cache_read) END AS cache_read,
    CASE WHEN bool_and(cache_create IS NOT NULL) THEN sum(cache_create) END AS cache_create,
    sum(total) AS total,bool_and(quality='normalized' AND time_basis='source') AS verified
  FROM usage_token_projection p JOIN live_windows w ON p.owner_user_id=w.owner AND p.daemon_id=w.daemon
    AND p.occurred_at>=w.start_at AND p.occurred_at<w.end_at
  GROUP BY ${tokenSourceColumns}
 ),
 call_rows AS (
  SELECT ${callSourceColumns},count(*) AS n FROM (${callSourceSQL('calls',false)}) f
  GROUP BY ${callSourceColumns}
 ),
 skill_rows AS (
  SELECT ${skillSourceColumns},count(*) AS n FROM (${callSourceSQL('skills',false)}) f
  GROUP BY ${skillSourceColumns}
 )
 SELECT COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM token_rows t),'[]')::text AS tokens,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('total',total)) FROM legacy WHERE total>0),'[]')::text AS residual,
        COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM call_rows c),'[]')::text AS calls,
        COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM skill_rows s),'[]')::text AS skills
 `,[JSON.stringify([{ownerUserId:owner,daemonId:daemon,from,toExclusive}]),from,toExclusive])
 return result.rows[0]
}
