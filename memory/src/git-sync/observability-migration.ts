/** Additive measurements only. Existing invalidation functions and lock order
 * remain intact; historical costs/timings are never inferred or backfilled. */
export const GIT_OBSERVABILITY_MIGRATION={version:46,statements:[
  `ALTER TABLE memory_git_request_reservations
    ADD COLUMN duration_seconds DOUBLE PRECISION CHECK(duration_seconds>=0 AND duration_seconds<'Infinity'::float8),
    ADD COLUMN request_limit INTEGER CHECK(request_limit BETWEEN 1 AND 128),
    ADD COLUMN byte_limit BIGINT CHECK(byte_limit>0)`,
  `CREATE TABLE memory_git_projection_invalidations(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,export_id UUID NOT NULL,started_at TIMESTAMPTZ NOT NULL,finished_at TIMESTAMPTZ,
    duration_seconds DOUBLE PRECISION CHECK(duration_seconds>=0 AND duration_seconds<'Infinity'::float8),
    PRIMARY KEY(installation_id,connection_id,export_id))`,
  `CREATE FUNCTION memory_git_measure_invalidation_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO memory_git_projection_invalidations(installation_id,connection_id,export_id,started_at)
      SELECT OLD.installation_id,OLD.connection_id,OLD.export_id,clock_timestamp()
      WHERE EXISTS(SELECT 1 FROM memory_installations WHERE installation_id=OLD.installation_id) ON CONFLICT DO NOTHING;
    RETURN OLD; END $$`,
  // BEFORE triggers sort by name: start before the existing retain/epoch hook.
  `CREATE TRIGGER memory_git_00_measure_invalidation BEFORE DELETE ON memory_git_snapshots
    FOR EACH ROW EXECUTE FUNCTION memory_git_measure_invalidation_start()`,
  `CREATE FUNCTION memory_git_measure_invalidation_finish() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE finished TIMESTAMPTZ:=clock_timestamp(); BEGIN
    UPDATE memory_git_projection_invalidations SET finished_at=finished,
      duration_seconds=CASE WHEN finished>=started_at THEN EXTRACT(EPOCH FROM (finished-started_at)) ELSE NULL END
      WHERE installation_id=OLD.installation_id AND connection_id=OLD.connection_id AND export_id=OLD.export_id;
    RETURN OLD; END $$`,
  // Nondeferred RI cascades run before this AFTER trigger. The row measurement
  // commits/rolls back with the caller; it excludes outer COMMIT and remote lag.
  `CREATE TRIGGER memory_git_01_measure_invalidation AFTER DELETE ON memory_git_snapshots
    FOR EACH ROW EXECUTE FUNCTION memory_git_measure_invalidation_finish()`,
] } as const
