import type pg from 'pg'

export interface SessionObservation {
  session_id: string
  occurred_at: string
  agent_type: string | null
  daemon_id: string | null
  status: string | null
  cwd: string | null
  worktree_path: string | null
  worktree_branch: string | null
}

export interface TurnObservation {
  session_id: string
  turn_id: string
  source_event_id: string
  occurred_at: string
  state: string | null
  reason: string | null
}

type Db = Pick<pg.PoolClient, 'query'>

// Input positions are source order. Recorded timestamps can be out of order.
export async function writePageSessions(db: Db, installationId: string, rows: SessionObservation[]) {
  const lastValue = (field: string) =>
    `(array_agg(${field} ORDER BY pos DESC) FILTER (WHERE ${field} IS NOT NULL))[1]`
  await db.query(`
    INSERT INTO source_sessions (installation_id,session_id,first_recorded_at,last_recorded_at,
      agent_type,daemon_id,status,cwd_observation,worktree_path,worktree_branch)
    SELECT $1,session_id,min(occurred_at),max(occurred_at),
      ${lastValue('agent_type')},${lastValue('daemon_id')},${lastValue('status')},
      ${lastValue('cwd')},${lastValue('worktree_path')},${lastValue('worktree_branch')}
    FROM jsonb_to_recordset($2) AS p(pos int,session_id text,occurred_at timestamptz,
      agent_type text,daemon_id text,status text,cwd text,worktree_path text,worktree_branch text)
    GROUP BY session_id ORDER BY session_id
    ON CONFLICT (installation_id,session_id) DO UPDATE SET
      first_recorded_at=LEAST(source_sessions.first_recorded_at,EXCLUDED.first_recorded_at),
      last_recorded_at=GREATEST(source_sessions.last_recorded_at,EXCLUDED.last_recorded_at),
      agent_type=COALESCE(EXCLUDED.agent_type,source_sessions.agent_type),
      daemon_id=COALESCE(EXCLUDED.daemon_id,source_sessions.daemon_id),
      status=COALESCE(EXCLUDED.status,source_sessions.status),
      cwd_observation=COALESCE(EXCLUDED.cwd_observation,source_sessions.cwd_observation),
      worktree_path=COALESCE(EXCLUDED.worktree_path,source_sessions.worktree_path),
      worktree_branch=COALESCE(EXCLUDED.worktree_branch,source_sessions.worktree_branch)
  `, [installationId, JSON.stringify(rows.map((row,pos)=>({...row,pos})))])
}

// ON CONFLICT evaluates against the locked row, including concurrent creators.
// Keep the first terminal state in source order and the last nonempty reason.
export async function writePageTurns(db: Db, installationId: string, rows: TurnObservation[], terminalStates: string[]) {
  if (!rows.length) return []
  const result = await db.query<{turn_id:string;terminal:boolean}>(`
    WITH grouped AS MATERIALIZED (
      SELECT turn_id,(array_agg(session_id ORDER BY pos))[1] AS session_id,
        (array_agg(source_event_id ORDER BY pos))[1] AS first_id,
        (array_agg(source_event_id ORDER BY pos DESC))[1] AS last_id,
        (array_agg(occurred_at ORDER BY pos))[1] AS started_at,
        (array_agg(state ORDER BY pos) FILTER (WHERE state=ANY($3::text[])))[1] AS terminal_state,
        (array_agg(occurred_at ORDER BY pos) FILTER (WHERE state=ANY($3::text[])))[1] AS terminal_at,
        (array_agg(state ORDER BY pos DESC) FILTER (WHERE state IS NOT NULL))[1] AS last_state,
        (array_agg(reason ORDER BY pos DESC) FILTER (WHERE reason IS NOT NULL))[1] AS reason,
        count(*) AS event_count
      FROM jsonb_to_recordset($2) AS p(pos int,turn_id text,session_id text,source_event_id uuid,
        occurred_at timestamptz,state text,reason text)
      GROUP BY turn_id
    )
    INSERT INTO source_turns (installation_id,turn_id,session_id,state,reason,started_at,terminal_at,
      first_source_event_id,last_source_event_id,event_count)
    SELECT $1,turn_id,session_id,COALESCE(terminal_state,last_state,'running'),reason,started_at,terminal_at,
      first_id,last_id,event_count FROM grouped ORDER BY turn_id
    ON CONFLICT (installation_id,turn_id) DO UPDATE SET
      state=CASE WHEN source_turns.state=ANY($3::text[]) THEN source_turns.state
        ELSE COALESCE((SELECT COALESCE(g.terminal_state,g.last_state) FROM grouped g WHERE g.turn_id=EXCLUDED.turn_id),source_turns.state) END,
      terminal_at=COALESCE(source_turns.terminal_at,
        CASE WHEN source_turns.state=ANY($3::text[]) THEN EXCLUDED.started_at ELSE EXCLUDED.terminal_at END),
      last_source_event_id=EXCLUDED.last_source_event_id,event_count=source_turns.event_count+EXCLUDED.event_count,
      reason=COALESCE(EXCLUDED.reason,source_turns.reason),updated_at=NOW()
    RETURNING turn_id,terminal_at IS NOT NULL AS terminal
  `, [installationId, JSON.stringify(rows.map((row,pos)=>({...row,pos}))), terminalStates])
  return result.rows.filter(row=>row.terminal).map(row=>row.turn_id)
}
