/** Review TTL is independent of a knowledge statement's valid_until. */
export const CANDIDATE_REVIEW_EXPIRY_MIGRATION = {
  version: 71,
  statements: [
    `ALTER TABLE memory_candidates ADD COLUMN review_expires_at TIMESTAMPTZ`,
    // Upgrading must not give an old, unattended candidate another 14 days.
    `UPDATE memory_candidates SET review_expires_at=created_at+INTERVAL '336 hours'`,
    // Existing lineage/FK constraint triggers must finish before further DDL.
    `SET CONSTRAINTS ALL IMMEDIATE`,
    `ALTER TABLE memory_candidates ALTER COLUMN review_expires_at SET NOT NULL`,
    `CREATE FUNCTION memory_candidate_review_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.review_expires_at := NEW.created_at+INTERVAL '336 hours';
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_candidate_review_deadline BEFORE INSERT OR UPDATE OF created_at,review_expires_at
      ON memory_candidates FOR EACH ROW EXECUTE FUNCTION memory_candidate_review_deadline()`,
    `ALTER TABLE memory_candidates DROP CONSTRAINT memory_candidates_status_check`,
    `ALTER TABLE memory_candidates ADD CONSTRAINT memory_candidates_status_check CHECK(status IN
      ('shadow','validated','duplicate','conflict','rejected_by_validator','rejected','accepted','expired'))`,
    `CREATE INDEX memory_candidates_review_expiry_idx ON memory_candidates(review_expires_at,candidate_id)
      WHERE status IN ('validated','conflict')`,
    // Also close the race where the TTL elapses while acceptance builds evidence.
    // Raising rolls back the whole ledger transaction, including its new claim.
    `CREATE FUNCTION memory_candidate_review_clock() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status IN ('accepted','rejected') AND OLD.status IN ('validated','conflict','expired')
          AND (OLD.status='expired' OR OLD.review_expires_at<=clock_timestamp()) THEN
          RAISE EXCEPTION 'candidate_expired' USING ERRCODE='PCE01';
        END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_candidate_review_clock BEFORE UPDATE OF status ON memory_candidates
      FOR EACH ROW EXECUTE FUNCTION memory_candidate_review_clock()`,
  ],
}
