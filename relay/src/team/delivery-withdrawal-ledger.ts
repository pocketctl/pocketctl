import type pg from 'pg'

type DB = Pick<pg.PoolClient, 'query'>
export const DELIVERY_WITHDRAWAL_PUBLISH_LOCK = 'team-delivery-withdrawal-publish-v1'

/** No installation/user/Team FK: invalidation must outlive every source owner.
 * Keep the content-free ledger for new provider consumers to hydrate from zero. */
export async function initDeliveryWithdrawalLedger(db: DB): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_delivery_memory_withdrawals (
      sequence BIGSERIAL PRIMARY KEY,
      team_id TEXT NOT NULL,team_session_id TEXT NOT NULL,
      submission_id UUID NOT NULL,decision_id UUID NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(team_id,team_session_id,submission_id,decision_id)
    );
    CREATE TABLE IF NOT EXISTS team_delivery_memory_consumers (
      consumer_id UUID PRIMARY KEY,ack_sequence BIGINT NOT NULL DEFAULT 0,
      lease_epoch BIGINT NOT NULL DEFAULT 0,lease_hash BYTEA,lease_expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    SELECT pg_advisory_xact_lock(hashtextextended('${DELIVERY_WITHDRAWAL_PUBLISH_LOCK}',0));
    INSERT INTO team_delivery_memory_withdrawals(team_id,team_session_id,submission_id,decision_id,recorded_at)
      SELECT team_id,team_session_id,submission_id,decision_id,MIN(withdrawn_at)
      FROM team_delivery_memory_sources WHERE withdrawn_at IS NOT NULL
      GROUP BY team_id,team_session_id,submission_id,decision_id ON CONFLICT DO NOTHING;
  `)
}

/** Caller owns the artifact revocation transaction. Serialize sequence allocation
 * through COMMIT so a later committed record cannot hide an earlier uncommitted
 * sequence below a provider's ACK. Readers never acquire this publication lock. */
export async function recordDeliveryWithdrawal(db: DB, source: {
  team_id: string; team_session_id: string; submission_id: string; decision_id: string
}): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [DELIVERY_WITHDRAWAL_PUBLISH_LOCK])
  await db.query(`INSERT INTO team_delivery_memory_withdrawals(team_id,team_session_id,submission_id,decision_id)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [source.team_id, source.team_session_id, source.submission_id, source.decision_id])
}
