import type pg from 'pg'

export async function initTeamEvidenceSchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_trusted_evidence (
      evidence_id UUID PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES team_tasks(task_id) ON DELETE CASCADE,
      submission_id UUID NOT NULL,
      principal_user_id INT REFERENCES team_actor_identities(actor_user_id),
      connector_id TEXT NOT NULL, connector_kind TEXT NOT NULL CHECK(connector_kind IN ('ci','review')),
      repository TEXT NOT NULL, run_id TEXT NOT NULL, check_id TEXT NOT NULL,
      spec_revision BIGINT NOT NULL, code_revision TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('passed','failed','unverified')),
      report_sha256 CHAR(64) NOT NULL, report_bytes BYTEA NOT NULL CHECK(octet_length(report_bytes) BETWEEN 1 AND 2097152),
      request_hash CHAR(64) NOT NULL, receipt JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(connector_id,run_id,check_id),
      FOREIGN KEY(task_id,submission_id) REFERENCES team_task_submissions(task_id,submission_id) ON DELETE CASCADE,
      FOREIGN KEY(task_id,spec_revision) REFERENCES team_task_specs(task_id,revision)
    );
    ALTER TABLE team_trusted_evidence ADD COLUMN IF NOT EXISTS principal_user_id INT REFERENCES team_actor_identities(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_team_trusted_evidence_submission ON team_trusted_evidence(submission_id,received_at);
    DROP TRIGGER IF EXISTS protect_team_trusted_evidence ON team_trusted_evidence;
    CREATE TRIGGER protect_team_trusted_evidence BEFORE UPDATE ON team_trusted_evidence
      FOR EACH ROW EXECUTE FUNCTION protect_team_delivery_record();
  `)
}
