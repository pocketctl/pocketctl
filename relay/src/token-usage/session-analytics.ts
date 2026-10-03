import type pg from 'pg'

export class TokenQueryError extends Error {}
export interface TokenSessionQuery {
  daemon: string | null; agent: string | null; q: string; from: string | null; to: string | null
  page: number; limit: number; sort: 'activity' | 'tokens'; direction: 'asc' | 'desc'
}
function date(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new TokenQueryError('from/to must be valid YYYY-MM-DD dates in UTC')
  return value
}
export function parseTokenSessionQuery(raw: Record<string, unknown>): TokenSessionQuery {
  const integer = (key: string, fallback: number, max: number) => {
    if (raw[key] === undefined) return fallback
    if (typeof raw[key] !== 'string' && typeof raw[key] !== 'number' || !/^\d+$/.test(String(raw[key]))) throw new TokenQueryError(`invalid ${key}`)
    const value = Number(raw[key]); if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TokenQueryError(`invalid ${key}`)
    return value
  }
  const text = (key: string, max: number) => {
    if (raw[key] === undefined) return ''
    if (typeof raw[key] !== 'string' || raw[key].length > max) throw new TokenQueryError(`invalid ${key}`)
    return raw[key].trim()
  }
  const from = date(raw.from), to = date(raw.to)
  if ((from === null) !== (to === null) || (from && to && (from > to || (Date.parse(to)-Date.parse(from))/86400000 > 365))) throw new TokenQueryError('provide from and to together, ordered and at most 366 days apart')
  const sort = raw.sort ?? 'activity', direction = raw.direction ?? 'desc'
  if (typeof sort !== 'string' || typeof direction !== 'string' || !['activity', 'tokens'].includes(sort) || !['asc', 'desc'].includes(direction)) throw new TokenQueryError('invalid sort or direction')
  const daemon = text('daemon', 128), agent = text('agent', 64)
  return { daemon: !daemon || daemon === 'all' ? null : daemon, agent: !agent || agent === 'all' ? null : agent, q: text('q', 200), from, to, page: integer('page',1,100000), limit: integer('limit',20,100), sort: sort as TokenSessionQuery['sort'], direction: direction as TokenSessionQuery['direction'] }
}

// Lifetime counters retain the existing parent + subagent semantics. A date
// range reads usage dates, never session creation dates. V2 excludes revoked
// attribution and unsealed historical days; legacy reads retained events only.
export async function getTokenSessionAnalytics(pool: Pick<pg.Pool,'query'>, userId: number, query: TokenSessionQuery, v2: boolean, aggregateOnly = false) {
  const usage = !query.from ? '' : v2 ? `usage AS (
    SELECT s.session_id, s.input, s.output, s.cache_read, s.cache_create FROM token_session_daily_stats s
    JOIN token_daily_closures c ON c.date=s.date AND c.status='sealed'
    WHERE s.user_id=$1 AND s.date BETWEEN $5::date AND $6::date AND s.date < (NOW() AT TIME ZONE 'UTC')::date
    UNION ALL
    SELECT f.session_id,f.input,f.output,f.cache_read,f.cache_create FROM token_usage_facts f
    WHERE f.user_id=$1 AND NOT f.session_attribution_revoked AND f.usage_date=(NOW() AT TIME ZONE 'UTC')::date AND f.usage_date BETWEEN $5::date AND $6::date
  ),` : `usage AS (
    SELECT e.session_id, COALESCE((e.payload->'usage'->>'input_tokens')::bigint,0) AS input,
      COALESCE((e.payload->'usage'->>'output_tokens')::bigint,0) AS output,
      COALESCE((e.payload->'usage'->>'cache_read_tokens')::bigint,0) AS cache_read,
      COALESCE((e.payload->'usage'->>'cache_create_tokens')::bigint,0) AS cache_create
    FROM events e JOIN sessions own ON own.session_id=e.session_id AND own.user_id=$1
    WHERE e.event_type='agent_text' AND e.payload ? 'usage' AND (e.created_at AT TIME ZONE 'UTC')::date BETWEEN $5::date AND $6::date
  ),`
  const ranged = !!query.from
  const base = `WITH ${usage} selected AS (
    SELECT s.* FROM sessions s WHERE s.user_id=$1 AND s.session_id NOT LIKE 'pending-%'
      AND COALESCE(s.parent_session_id,'')=''
      AND ($2::text IS NULL OR s.daemon_id=$2) AND ($3::text IS NULL OR s.agent_type=$3)
      AND ($4::text='' OR strpos(lower(COALESCE(s.title,'') || ' ' || s.session_id || ' ' || COALESCE(s.model,'') || ' ' || COALESCE(s.agent_type,'')),lower($4))>0)
      AND ($5::date IS NULL OR $6::date IS NOT NULL)
  ), totals AS (
    SELECT s.session_id,s.title,s.daemon_id,s.agent_type,s.model,s.status,s.created_at,
      COALESCE(s.last_activity_at,s.created_at) AS last_activity_at,
      ${ranged ? 'u.input' : 'COALESCE(s.tok_input,0)'} AS tok_input,
      ${ranged ? 'u.output' : 'COALESCE(s.tok_output,0)'} AS tok_output,
      ${ranged ? 'u.cache_read' : 'COALESCE(s.tok_cache_read,0)'} AS tok_cache_read,
      ${ranged ? 'u.cache_create' : 'COALESCE(s.tok_cache_create,0)'} AS tok_cache_create,
      ${ranged ? 'u.input+u.output+u.cache_read+u.cache_create' : 'COALESCE(s.total_tokens,0)+COALESCE(children.total,0)'} AS total_tokens
    FROM selected s
    ${ranged ? `JOIN LATERAL (SELECT SUM(input) AS input,SUM(output) AS output,SUM(cache_read) AS cache_read,SUM(cache_create) AS cache_create FROM usage WHERE session_id=s.session_id HAVING COUNT(*)>0) u ON true` : `LEFT JOIN LATERAL (SELECT SUM(COALESCE(token_in,0)+COALESCE(token_out,0)+COALESCE(token_cache,0)+COALESCE(token_cache_create,0)) AS total FROM subagents WHERE parent_session_id=s.session_id) children ON true`}
  )`
  const sort = query.sort === 'tokens' ? 'total_tokens' : 'last_activity_at'
  const direction = query.direction === 'asc' ? 'ASC' : 'DESC'
  const result = await pool.query(`${base}
    SELECT (SELECT COUNT(*) FROM totals) AS count,
      COALESCE((SELECT jsonb_agg(a ORDER BY a.total DESC,a.agent_type) FROM (SELECT COALESCE(agent_type,'unknown') AS agent_type,SUM(total_tokens) AS total FROM totals GROUP BY agent_type) a),'[]'::jsonb) AS by_agent,
      ${aggregateOnly ? "'[]'::jsonb" : `COALESCE((SELECT jsonb_agg(p ORDER BY p.${sort} ${direction},p.session_id ${direction}) FROM (SELECT * FROM totals ORDER BY ${sort} ${direction},session_id ${direction} LIMIT $7 OFFSET $8) p),'[]'::jsonb)`} AS sessions`,
      [userId,query.daemon,query.agent,query.q,query.from,query.to,...(aggregateOnly ? [] : [query.limit,(query.page-1)*query.limit])])
  const row=result.rows[0] ?? {}, total=Number(row.count ?? 0)
  const byAgent=(row.by_agent ?? []).map((entry:any)=>({agent_type:String(entry.agent_type),total:Number(entry.total)}))
  const sum=byAgent.reduce((n:number,entry:any)=>n+entry.total,0)
  const sessions=(row.sessions ?? []).map((session:any)=>({...session,...Object.fromEntries(['total_tokens','tok_input','tok_output','tok_cache_read','tok_cache_create'].map(key=>[key,Number(session[key]??0)]))}))
  if (sessions.length && !ranged) {
    const children=await pool.query(`SELECT parent_session_id,agent_id AS "agentId",agent_type AS "agentType",title,token_in AS "tokenIn",token_out AS "tokenOut",token_cache AS "tokenCache",token_cache_create AS "tokenCacheCreate" FROM subagents WHERE parent_session_id=ANY($1::text[]) ORDER BY created_at,agent_id`,[sessions.map((s:any)=>s.session_id)])
    for(const session of sessions) session.children=children.rows.filter(child=>child.parent_session_id===session.session_id).map(({parent_session_id,...child})=>child)
  }
  return { sessions,total,page:query.page,limit:query.limit,has_more:query.page*query.limit<total,
    byAgent:byAgent.map((entry:any)=>({...entry,pct:sum?Number((entry.total/sum*100).toFixed(1)):0})),
    scope:{from:query.from,to:query.to,timezone:'UTC',basis:ranged?(v2?'attributed_usage':'retained_events'):'session_lifetime',includes_cache:true,includes_subagents:!ranged} }
}
