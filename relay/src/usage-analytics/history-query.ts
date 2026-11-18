// $1 is the server-resolved scope; $2/$3 are the requested time bounds.
// Complete days can come from history. The gaps retain the exact original
// timestamps, so a range ending at an older signed as_of cannot read a full day.
export const scopeWindowsSQL = `scope_windows AS MATERIALIZED (
 SELECT owner, daemon, GREATEST(w."from", $2::timestamptz) AS start_at,
        LEAST(w."toExclusive", $3::timestamptz) AS end_at
 FROM jsonb_to_recordset($1::jsonb)
      AS w("ownerUserId" int, "daemonId" text, "from" timestamptz, "toExclusive" timestamptz)
 CROSS JOIN LATERAL (VALUES (w."ownerUserId", w."daemonId")) s(owner, daemon)
 WHERE w."from" < $3::timestamptz AND w."toExclusive" > $2::timestamptz
)`

export const historyWindowsSQL = scopeWindowsSQL + `,
 history_days AS MATERIALIZED (
  SELECT DISTINCT h.owner_user_id, h.daemon_id, h.day
  FROM scope_windows w
  JOIN usage_history_days h ON h.owner_user_id=w.owner AND h.daemon_id=w.daemon
   AND h.day >= (w.start_at AT TIME ZONE 'UTC')::date
   AND h.day < (w.end_at AT TIME ZONE 'UTC')::date
  WHERE h.built_revision=h.revision
   AND (h.day::timestamp AT TIME ZONE 'UTC') >= w.start_at
 ),
 live_windows AS MATERIALIZED (
  SELECT w.owner,w.daemon,gaps.start_at,gaps.end_at
  FROM scope_windows w
  CROSS JOIN LATERAL (
   SELECT upper_edge AS start_at, lead(lower_edge) OVER (ORDER BY lower_edge, upper_edge) AS end_at
   FROM (
    SELECT w.start_at AS lower_edge,w.start_at AS upper_edge
    UNION ALL SELECT w.end_at,w.end_at
    UNION ALL
    SELECT h.day::timestamp AT TIME ZONE 'UTC',(h.day+1)::timestamp AT TIME ZONE 'UTC'
    FROM history_days h WHERE h.owner_user_id=w.owner AND h.daemon_id=w.daemon
      AND h.day::timestamp AT TIME ZONE 'UTC' >= w.start_at
      AND (h.day+1)::timestamp AT TIME ZONE 'UTC' <= w.end_at
   ) edges
  ) gaps WHERE gaps.start_at<gaps.end_at
 )`

// These columns are needed after historical and live rows have been combined.
// In particular, request_id is the stable source ID, never a SQL dense_rank
// generated for a single date. We resolve current session authority at read time.
export const tokenSourceColumns = `source_session,parent_session_id,child_agent_id,agent_type,model,
 request_id,attribution_revoked`
export const tokenSourceShape = `source_session text,parent_session_id text,child_agent_id text,
 agent_type text,model text,request_id text,attribution_revoked boolean,
 input numeric,output numeric,cache_read numeric,cache_create numeric,total numeric,verified boolean`

// All legacy consumers use the same adoption rule: only complete UTC dates,
// preserve the original fact's date/model, and count each covered fact once.
export const historyResidualSQL = `
 daily AS MATERIALIZED (
  SELECT d.*
  FROM live_windows w
  CROSS JOIN LATERAL (
   SELECT * FROM token_daily_stats d WHERE d.user_id=w.owner AND d.daemon_id=w.daemon
     AND d.date >= (w.start_at AT TIME ZONE 'UTC')::date
     AND d.date < (w.end_at AT TIME ZONE 'UTC')::date
     AND (d.date::timestamp AT TIME ZONE 'UTC')>=w.start_at
   OFFSET 0
  ) d
 ),
 covered AS (
  SELECT d.user_id,d.daemon_id,d.date,d.model, SUM(f.input+f.output+f.cache_read+f.cache_create) AS total
  FROM daily d
  JOIN token_usage_facts f ON f.user_id=d.user_id AND f.daemon_id=d.daemon_id
   AND f.usage_date=d.date AND f.model=d.model
  JOIN usage_source_metadata m ON m.fact_key=f.fact_key
  WHERE EXISTS (
    SELECT 1 FROM usage_token_projection p
    WHERE p.owner_user_id=f.user_id AND p.daemon_id=f.daemon_id
      AND p.source_session=m.source_session AND p.logical_usage_id=m.logical_usage_id
  )
  GROUP BY d.user_id,d.daemon_id,d.date,d.model
 ),
 legacy AS (
  SELECT d.user_id AS owner_user_id,d.daemon_id,d.date AS day,
         SUM(GREATEST(0,d.input+d.output+d.cache_read+d.cache_create-COALESCE(c.total,0))) AS total
  FROM daily d LEFT JOIN covered c USING(user_id,daemon_id,date,model)
  GROUP BY d.user_id,d.daemon_id,d.date
 )`

export const callSourceColumns = `source_session,attribution_revoked,tool_kind,tool_name,mcp_server,outcome,has_start`
export const skillSourceColumns = `source_session,attribution_revoked,skill_key,skill_name`
const callSourceShape = `source_session text,attribution_revoked boolean,tool_kind text,tool_name text,
 mcp_server text,outcome text,has_start boolean,n bigint`
const skillSourceShape = `source_session text,attribution_revoked boolean,skill_key text,skill_name text,n bigint`

export function callSourceSQL(kind: 'calls' | 'skills', history: boolean): string {
 const skills=kind==='skills'
 const columns=skills?skillSourceColumns:callSourceColumns
 const facts=skills?'usage_skill_facts':'usage_call_facts'
 return `
  SELECT w.owner AS owner_user_id,w.daemon AS daemon_id,
     (f.occurred_at AT TIME ZONE 'UTC')::date AS day,${columns},1::bigint AS n
  FROM live_windows w
  CROSS JOIN LATERAL (
    SELECT ${columns},occurred_at FROM ${facts}
    WHERE owner_user_id=w.owner AND daemon_id=w.daemon
      AND occurred_at>=w.start_at AND occurred_at<w.end_at
    OFFSET 0
  ) f` + (history ? `
  UNION ALL
  SELECT h.owner_user_id,h.daemon_id,h.day,f.*
  FROM history_days h JOIN usage_history_days d USING(owner_user_id,daemon_id,day)
  CROSS JOIN LATERAL jsonb_to_recordset(d.${kind}) AS f(${skills?skillSourceShape:callSourceShape})` : '')
}

// Resolve the *current* authority only for identities that occur in the read.
// The key predicates go into both branches of the authority view. The outer
// joins still retain accounted totals when attribution has been revoked.
export function candidateAuthoritySQL(source: string, includeParent=false): string {
 const keys=includeParent?`CROSS JOIN LATERAL (VALUES (p.source_session),(p.parent_session_id)) AS key(source_session)`:''
 const session=includeParent?'key.source_session':'p.source_session'
 return `
 authority_keys AS MATERIALIZED (
  SELECT DISTINCT p.owner_user_id,p.daemon_id,${session}
  FROM ${source} p ${keys} WHERE ${session} IS NOT NULL
 ),
 authority AS MATERIALIZED (
  SELECT k.owner_user_id,k.daemon_id,k.source_session,a.current_session
  FROM authority_keys k
  CROSS JOIN LATERAL (
   SELECT a.current_session FROM usage_session_authority a
   WHERE a.owner_user_id=k.owner_user_id AND a.daemon_id=k.daemon_id AND a.source_session=k.source_session
   OFFSET 0
  ) a
 )`
}
