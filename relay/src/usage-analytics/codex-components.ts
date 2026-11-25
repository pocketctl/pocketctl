import type pg from 'pg'

// Validate the original typed wire envelope against the immutable fact. Codex
// omits zero counters on the wire. A reported total by itself proves no split.
export const codexFactShapeSQL = `
 CREATE OR REPLACE FUNCTION usage_codex_fact_shape_v1(f token_usage_facts, envelope jsonb)
 RETURNS text LANGUAGE SQL IMMUTABLE AS $shape$
 SELECT CASE
   WHEN u ?| ARRAY['input_tokens','output_tokens']
     AND f.input::numeric + f.output = f.reported_total AND f.input >= f.cache_read
     AND f.cache_create=0 AND f.reasoning<=f.output THEN 'components'
   WHEN NOT u ?| ARRAY['input_tokens','output_tokens','cache_read_tokens','cache_create_tokens','reasoning_tokens']
     THEN 'total_only'
 END
 FROM (SELECT envelope->'usage_meta' AS m, envelope->'usage' AS u) source
 WHERE m @> '{"version":1,"mode":"cumulative","input_semantics":"includes_cache"}'
   AND m->>'provider' IN ('codex','codex-managed')
   AND COALESCE(m->>'source_usage_id','')='' AND COALESCE(m->>'revision','0')='0'
   AND COALESCE(m->>'previous_event_identity','')='' AND COALESCE(envelope->>'previous_event_id','')=''
   AND jsonb_typeof(u)='object' AND f.reported_total>0
   AND u->'total_tokens'=to_jsonb(f.reported_total)
   AND COALESCE(u->'input_tokens','0')=to_jsonb(f.input)
   AND COALESCE(u->'output_tokens','0')=to_jsonb(f.output)
   AND COALESCE(u->'cache_read_tokens','0')=to_jsonb(f.cache_read)
   AND COALESCE(u->'cache_create_tokens','0')=to_jsonb(f.cache_create)
   AND COALESCE(u->'reasoning_tokens','0')=to_jsonb(f.reasoning)
 $shape$;
`

// Only the explicit Relay migrator invokes this repair. Save the cursor and
// the changes in the same batch transaction. Existing projection triggers
// invalidate signed reads and history days without touching raw facts.
export async function repairCodexUsageComponents(pool:pg.Pool) {
 const db=await pool.connect()
 try {
  for (;;) {
   await db.query('BEGIN')
   const {rows:[state]}=await db.query(`SELECT codex_components_cursor AS cursor,
    codex_components_version AS version FROM usage_analytics_state WHERE singleton FOR UPDATE`)
   if(state.version>=1){await db.query('COMMIT');return}
   const {rows:[batch]}=await db.query(`
    WITH candidates AS MATERIALIZED (
     SELECT m.fact_key,m.owner_user_id,m.daemon_id,m.source_session
     FROM usage_source_metadata m
     WHERE ($1::text IS NULL OR m.fact_key>$1) AND m.metadata->>'provider' IN ('codex','codex-managed')
       AND m.metadata->>'input_semantics'='includes_cache' AND m.metadata->>'mode'='cumulative'
       AND m.logical_usage_id=m.fact_key AND m.received_at>=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - interval '365 days'
     ORDER BY m.fact_key LIMIT 500
    ), evidence AS MATERIALIZED (
     SELECT c.*,f.input,f.output,f.cache_read,f.cache_create,f.reported_total,
       usage_codex_fact_shape_v1(f,COALESCE(e.payload,e.body_header)) AS shape
     FROM candidates c JOIN token_usage_facts f ON f.fact_key=c.fact_key AND f.user_id=c.owner_user_id AND f.daemon_id=c.daemon_id
     JOIN events e ON e.id=f.source_event_id AND e.user_id=f.user_id AND e.session_id=f.session_id AND e.event_type='agent_text'
     WHERE NOT e.owner_retired
    ), corrected AS (
     UPDATE usage_token_projection p SET
      input=CASE WHEN f.shape='components' THEN f.input-f.cache_read END,
      output=CASE WHEN f.shape='components' THEN f.output END,
      cache_read=CASE WHEN f.shape='components' THEN f.cache_read END,
      cache_create=CASE WHEN f.shape='components' THEN f.cache_create END,
      total=f.reported_total,quality='codex_fact_'||f.shape
     FROM evidence f WHERE f.shape IS NOT NULL AND p.owner_user_id=f.owner_user_id AND p.daemon_id=f.daemon_id
       AND p.source_session=f.source_session AND p.source_fact_key=f.fact_key AND p.logical_usage_id=f.fact_key
       AND p.accounting_version='normalized-v1' AND p.quality='legacy_unverified' AND p.revision=0
       AND p.input IS NULL AND p.output IS NULL AND p.cache_read IS NULL AND p.cache_create IS NULL
       AND p.requests IS NULL AND p.request_id IS NULL AND p.total=f.input::numeric+f.output+f.cache_read+f.cache_create
     RETURNING p.source_fact_key,f.shape
    ), saved AS (
      UPDATE usage_source_metadata m SET metadata=m.metadata||jsonb_build_object('codex_fact_shape_v1',c.shape)
      FROM corrected c WHERE m.fact_key=c.source_fact_key
    )
    SELECT max(fact_key) AS cursor,count(*)::int AS n FROM candidates
   `,[state.cursor])
   const done=batch.n<500
   await db.query('UPDATE usage_analytics_state SET codex_components_cursor=$1,codex_components_version=$2 WHERE singleton',
    [batch.cursor??state.cursor,done?1:0])
   await db.query('COMMIT')
   if(done)return
  }
 } catch(error){await db.query('ROLLBACK');throw error} finally {db.release()}
}
