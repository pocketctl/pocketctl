import { initDeliveryWithdrawalLedger } from './delivery-withdrawal-ledger.js'
import type pg from 'pg'

/** Content-free capture receipts survive the transient extension outbox. */
export async function initTeamDeliveryMemorySchema(db: Pick<pg.Pool, 'query'>): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_delivery_memory_sources (
      source_session_id TEXT PRIMARY KEY,
      decision_id UUID NOT NULL REFERENCES team_acceptance_decisions(decision_id) ON DELETE CASCADE,
      submission_id UUID NOT NULL REFERENCES team_task_submissions(submission_id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES collaboration_teams(team_id) ON DELETE CASCADE,
      team_session_id TEXT NOT NULL REFERENCES collaboration_sessions(team_session_id) ON DELETE CASCADE,
      binding_id TEXT NOT NULL,
      binding_revision BIGINT NOT NULL CHECK(binding_revision > 0),
      reader_user_id INT NOT NULL REFERENCES team_actor_identities(actor_user_id) ON DELETE RESTRICT,
      participant_revision BIGINT NOT NULL CHECK(participant_revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ, revocation_reason TEXT, withdrawn_at TIMESTAMPTZ,
      UNIQUE(decision_id,reader_user_id),
      CHECK((revoked_at IS NULL) = (revocation_reason IS NULL)),
      CHECK(withdrawn_at IS NULL OR revoked_at IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_team_delivery_memory_reader
      ON team_delivery_memory_sources(team_session_id,reader_user_id,participant_revision) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_team_delivery_memory_binding
      ON team_delivery_memory_sources(team_id,binding_id,binding_revision) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_team_delivery_memory_submission
      ON team_delivery_memory_sources(submission_id) WHERE revoked_at IS NULL;
  `)
  await initDeliveryWithdrawalLedger(db)
}
