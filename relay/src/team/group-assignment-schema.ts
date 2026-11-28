import type pg from 'pg'

export async function initGroupAssignmentSchema(db: Pick<pg.Pool, 'query'>) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_session_assignments (
      assignment_id UUID PRIMARY KEY,
      team_session_id TEXT NOT NULL REFERENCES collaboration_sessions ON DELETE CASCADE,
      source_event_id TEXT NOT NULL REFERENCES collaboration_events,
      thread_event_id TEXT NOT NULL REFERENCES collaboration_events,
      source_offer_id TEXT REFERENCES team_agent_offers,
      source_binding_id TEXT REFERENCES collaboration_session_agent_bindings,
      source_text TEXT NOT NULL,
      proposal TEXT NOT NULL,
      references_snapshot JSONB NOT NULL DEFAULT '[]',
      context_version BIGINT NOT NULL, context_hash TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'independent' CHECK(mode IN ('original','independent','plan')),
      creator_user_id INT NOT NULL REFERENCES team_actor_identities,
      confirmed_by INT REFERENCES team_actor_identities, confirmed_at TIMESTAMPTZ,
      UNIQUE(team_session_id,source_event_id)
    );
    CREATE TABLE IF NOT EXISTS team_session_assignment_items (
      assignment_id UUID NOT NULL REFERENCES team_session_assignments ON DELETE CASCADE,
      item_id TEXT NOT NULL, position INTEGER NOT NULL,
      offer_id TEXT NOT NULL REFERENCES team_agent_offers, binding_id TEXT NOT NULL REFERENCES collaboration_session_agent_bindings,
      owner_user_id INT NOT NULL REFERENCES team_actor_identities, binding_revision BIGINT NOT NULL, offer_revision BIGINT NOT NULL,
      instruction TEXT NOT NULL, acceptance TEXT NOT NULL, reviewer_user_id INT NOT NULL REFERENCES team_actor_identities,
      required_checks JSONB NOT NULL, depends_on JSONB NOT NULL,
      task_id TEXT REFERENCES team_tasks ON DELETE SET NULL, event_id TEXT REFERENCES collaboration_events ON DELETE SET NULL,
      PRIMARY KEY(assignment_id,item_id), UNIQUE(assignment_id,position)
    );
    CREATE INDEX IF NOT EXISTS idx_team_assignment_task ON team_session_assignment_items(task_id) WHERE task_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_team_assignment_event ON team_session_assignment_items(event_id) WHERE event_id IS NOT NULL;
    ALTER TABLE team_session_assignments ADD COLUMN IF NOT EXISTS source_binding_revision BIGINT, ADD COLUMN IF NOT EXISTS source_offer_revision BIGINT;
    ALTER TABLE team_session_assignment_items ADD COLUMN IF NOT EXISTS code JSONB;
    ALTER TABLE collaboration_calls ADD COLUMN IF NOT EXISTS code_workspace JSONB;
    CREATE TABLE IF NOT EXISTS team_code_workspace_leases (
      generation BIGSERIAL PRIMARY KEY,
      attempt_id UUID NOT NULL UNIQUE REFERENCES team_task_step_attempts(attempt_id) ON DELETE CASCADE,
      call_id TEXT NOT NULL UNIQUE REFERENCES collaboration_calls(call_id) ON DELETE CASCADE,
      daemon_id TEXT NOT NULL, grant_revision TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_team_code_leases_daemon ON team_code_workspace_leases(daemon_id,generation);
    ALTER TABLE collaboration_context_deliveries ADD COLUMN IF NOT EXISTS native_session_id TEXT,
      ADD COLUMN IF NOT EXISTS binding_revision BIGINT, ADD COLUMN IF NOT EXISTS included_event_seqs JSONB,
      ADD COLUMN IF NOT EXISTS omitted_event_seqs JSONB;
    CREATE INDEX IF NOT EXISTS idx_team_context_accepted_native ON collaboration_context_deliveries(binding_id,binding_revision,native_session_id) WHERE state='accepted';
  `)
}
