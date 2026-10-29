import type pg from 'pg'
export async function initTeamTemplateSchema(db:Pick<pg.Pool,'query'>):Promise<void>{
 await db.query(`
 CREATE TABLE IF NOT EXISTS team_template_revisions (
  team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
  template_id TEXT NOT NULL, revision INT NOT NULL CHECK(revision BETWEEN 1 AND 100),
  definition JSONB NOT NULL CHECK(jsonb_typeof(definition)='object'), content_hash CHAR(64) NOT NULL,
  created_by_user_id INT NOT NULL REFERENCES team_actor_identities(actor_user_id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(team_id,template_id,revision)
 );
 CREATE TABLE IF NOT EXISTS team_template_heads (
  team_id TEXT NOT NULL, template_id TEXT NOT NULL, revision INT NOT NULL,
  PRIMARY KEY(team_id,template_id),FOREIGN KEY(team_id,template_id,revision) REFERENCES team_template_revisions(team_id,template_id,revision) ON DELETE CASCADE
 );
 CREATE TABLE IF NOT EXISTS team_task_template_sources (
  task_id TEXT PRIMARY KEY REFERENCES team_tasks(task_id) ON DELETE CASCADE,
  team_id TEXT NOT NULL, template_id TEXT NOT NULL, template_revision INT NOT NULL,
  team_session_id TEXT NOT NULL REFERENCES collaboration_sessions(team_session_id),
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'), content_hash CHAR(64) NOT NULL,
  role_bindings JSONB NOT NULL CHECK(jsonb_typeof(role_bindings)='object'), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(team_id,template_id,template_revision) REFERENCES team_template_revisions(team_id,template_id,revision),
  CONSTRAINT team_template_source_session_team_fk FOREIGN KEY(team_session_id,team_id) REFERENCES collaboration_sessions(team_session_id,team_id),
  FOREIGN KEY(task_id,team_id) REFERENCES team_tasks(task_id,team_id) ON DELETE CASCADE
 );
 DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='team_task_template_sources'::regclass AND conname='team_template_source_session_team_fk') THEN
   ALTER TABLE team_task_template_sources ADD CONSTRAINT team_template_source_session_team_fk FOREIGN KEY(team_session_id,team_id) REFERENCES collaboration_sessions(team_session_id,team_id);
  END IF;
 END $$;
 CREATE OR REPLACE FUNCTION protect_team_template_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'template versions and task snapshots are immutable' USING ERRCODE='23514'; END $$;
 DROP TRIGGER IF EXISTS protect_team_template_revision ON team_template_revisions;
 CREATE TRIGGER protect_team_template_revision BEFORE UPDATE ON team_template_revisions FOR EACH ROW EXECUTE FUNCTION protect_team_template_snapshot();
 DROP TRIGGER IF EXISTS protect_team_template_source ON team_task_template_sources;
 CREATE TRIGGER protect_team_template_source BEFORE UPDATE ON team_task_template_sources FOR EACH ROW EXECUTE FUNCTION protect_team_template_snapshot();
 `)
}
