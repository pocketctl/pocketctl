import type pg from 'pg'

/** Minimal legacy counters, independent of content and attribution. They
 * disappear with the account. V2 retains its existing immutable fact truth. */
export async function initSessionUsageRetentionSchema(db: Pick<pg.Pool,'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS session_usage_retention_daily (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(64) NOT NULL,
      daemon_id VARCHAR(64) NOT NULL,
      agent_type VARCHAR(64) NOT NULL,
      model VARCHAR(128) NOT NULL,
      date DATE NOT NULL,
      input BIGINT NOT NULL, output BIGINT NOT NULL, cache_read BIGINT NOT NULL, cache_create BIGINT NOT NULL,
      requests BIGINT NOT NULL, deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,session_id,date,model,daemon_id)
    );
    CREATE INDEX IF NOT EXISTS idx_retained_usage_user_date ON session_usage_retention_daily(user_id,date,daemon_id);
    CREATE TABLE IF NOT EXISTS session_usage_retention_totals (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id VARCHAR(64) NOT NULL,
      daemon_id VARCHAR(64) NOT NULL,
      agent_type VARCHAR(64) NOT NULL,
      total_tokens BIGINT NOT NULL, tok_input BIGINT NOT NULL, tok_output BIGINT NOT NULL,
      tok_cache_read BIGINT NOT NULL, tok_cache_create BIGINT NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,session_id)
    );
  `)
}

export async function retainSessionUsageInTransaction(db: Pick<pg.PoolClient,'query'>,sessionId:string,retainLegacyDaily=true): Promise<void> {
  await db.query(`INSERT INTO session_usage_retention_daily(user_id,session_id,daemon_id,agent_type,model,date,input,output,cache_read,cache_create,requests)
    SELECT s.user_id,s.session_id,s.daemon_id,COALESCE(s.agent_type,'unknown'),COALESCE(s.model,'unknown'),(e.created_at AT TIME ZONE 'UTC')::date,
      SUM(COALESCE((COALESCE(e.payload,e.body_header)->'usage'->>'input_tokens')::bigint,0)),
      SUM(COALESCE((COALESCE(e.payload,e.body_header)->'usage'->>'output_tokens')::bigint,0)),
      SUM(COALESCE((COALESCE(e.payload,e.body_header)->'usage'->>'cache_read_tokens')::bigint,0)),
      SUM(COALESCE((COALESCE(e.payload,e.body_header)->'usage'->>'cache_create_tokens')::bigint,0)),COUNT(*)
    FROM sessions s JOIN events e ON e.session_id=s.session_id
    WHERE s.session_id=$1 AND s.user_id IS NOT NULL AND s.daemon_id IS NOT NULL
      AND e.event_type='agent_text' AND COALESCE(e.payload,e.body_header) ? 'usage'
    GROUP BY s.user_id,s.session_id,s.daemon_id,s.agent_type,s.model,(e.created_at AT TIME ZONE 'UTC')::date
    ON CONFLICT(user_id,session_id,date,model,daemon_id) DO NOTHING`,[sessionId])
  await db.query(`INSERT INTO session_usage_retention_totals(user_id,session_id,daemon_id,agent_type,total_tokens,tok_input,tok_output,tok_cache_read,tok_cache_create)
    SELECT user_id,session_id,daemon_id,COALESCE(agent_type,'unknown'),COALESCE(total_tokens,0),COALESCE(tok_input,0),COALESCE(tok_output,0),COALESCE(tok_cache_read,0),COALESCE(tok_cache_create,0)
    FROM sessions WHERE session_id=$1 AND user_id IS NOT NULL AND daemon_id IS NOT NULL ON CONFLICT(user_id,session_id) DO NOTHING`,[sessionId])
  if(!retainLegacyDaily)return
  // Fill missing historical rollups while canonical rows are still present.
  // Existing authoritative rollups survive unchanged, including counters whose
  // old source events were already removed by the retired event-age cleanup.
  await db.query(`INSERT INTO token_daily_stats(user_id,daemon_id,date,model,input,output,cache_read,cache_create,requests)
    WITH affected AS(SELECT user_id,daemon_id,date,model FROM session_usage_retention_daily WHERE session_id=$1 AND date<(NOW() AT TIME ZONE 'UTC')::date),
    counters AS(
      SELECT s.user_id,s.daemon_id,(e.created_at AT TIME ZONE 'UTC')::date AS date,COALESCE(s.model,'unknown') AS model,
        COALESCE((COALESCE(e.payload,e.body_header)->'usage'->>'input_tokens')::bigint,0) AS input,
        COALESCE((COALESCE(e.payload,e.body_header)->'usage'->>'output_tokens')::bigint,0) AS output,
        COALESCE((COALESCE(e.payload,e.body_header)->'usage'->>'cache_read_tokens')::bigint,0) AS cache_read,
        COALESCE((COALESCE(e.payload,e.body_header)->'usage'->>'cache_create_tokens')::bigint,0) AS cache_create,1::bigint AS requests
      FROM events e JOIN sessions s ON s.session_id=e.session_id JOIN affected a ON a.user_id=s.user_id AND a.daemon_id=s.daemon_id
        AND a.date=(e.created_at AT TIME ZONE 'UTC')::date AND a.model=COALESCE(s.model,'unknown')
      WHERE e.event_type='agent_text' AND COALESCE(e.payload,e.body_header)?'usage'
      UNION ALL SELECT r.user_id,r.daemon_id,r.date,r.model,r.input,r.output,r.cache_read,r.cache_create,r.requests
      FROM session_usage_retention_daily r JOIN affected a USING(user_id,daemon_id,date,model)
      WHERE NOT EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=r.session_id AND s.user_id=r.user_id))
    SELECT user_id,daemon_id,date,model,sum(input),sum(output),sum(cache_read),sum(cache_create),sum(requests)
    FROM counters GROUP BY user_id,daemon_id,date,model ON CONFLICT(user_id,daemon_id,date,model) DO NOTHING`,[sessionId])
}
