import type pg from 'pg'
/** Existing tasks keep no invented requirements or override history. */
export async function initTeamTaskReadinessSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
  await db.query(`
    ALTER TABLE team_tasks ADD COLUMN IF NOT EXISTS requirements JSONB;
    ALTER TABLE team_tasks ADD COLUMN IF NOT EXISTS requirements_revision BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE team_tasks ADD COLUMN IF NOT EXISTS requirements_override JSONB;
    CREATE TABLE IF NOT EXISTS team_task_requirement_events (
      event_id UUID PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      actor_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK(kind IN ('updated','override')),
      requirements_revision BIGINT NOT NULL CHECK(requirements_revision>0),
      task_revision BIGINT NOT NULL CHECK(task_revision>0),
      details JSONB NOT NULL CHECK(jsonb_typeof(details)='object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_team_requirement_events ON team_task_requirement_events(task_id,created_at,event_id);
    CREATE INDEX IF NOT EXISTS idx_team_requirement_history ON team_task_requirement_events(task_id,task_revision DESC);
  `)
}
