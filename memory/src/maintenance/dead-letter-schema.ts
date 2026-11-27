// The compatibility summary remains one row per job because historical projection
// recovery verifies its byte digest. New failures additionally retain each epoch.
export const DEAD_LETTER_RETENTION_STATEMENTS = [
  `ALTER TABLE memory_dead_letters ADD COLUMN claim_epoch bigint`,
  `ALTER TABLE memory_jobs ADD COLUMN had_failure boolean NOT NULL DEFAULT false`,
  `CREATE TABLE memory_job_failures (
    failure_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL,
    installation_id uuid, job_type text NOT NULL, claim_epoch bigint, input_generation text,
    key_hash bytea, session_id text, turn_id text, attempts integer NOT NULL,
    error_code text, payload_hash bytea, dead_at timestamptz NOT NULL,
    last_review_reason text, next_review_at timestamptz,
    origin text NOT NULL CHECK(origin IN ('worker','legacy_summary','legacy_job')),
    UNIQUE(job_id,claim_epoch)
  )`,
  `CREATE UNIQUE INDEX memory_failure_legacy_identity ON memory_job_failures(job_id,dead_at)
    WHERE claim_epoch IS NULL`,
  `CREATE INDEX memory_failure_review ON memory_job_failures(installation_id,COALESCE(next_review_at,dead_at),failure_id)`,
  `CREATE INDEX memory_failure_session ON memory_job_failures(installation_id,session_id)`,
  `CREATE TABLE memory_failure_cleanup_receipts (
    failure_id uuid PRIMARY KEY, job_id uuid NOT NULL, installation_id uuid REFERENCES memory_installations ON DELETE CASCADE, claim_epoch bigint NOT NULL,
    generation bigint NOT NULL, session_id text NOT NULL, turn_id text NOT NULL,
    disposition text NOT NULL, closed_at timestamptz NOT NULL, cleaned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    successor_generation bigint, policy_version integer NOT NULL, removed_job boolean NOT NULL, removed_summary boolean NOT NULL,
    removed_failure boolean NOT NULL CHECK(removed_failure)
  )`,
  `CREATE INDEX memory_failure_cleanup_expiry ON memory_failure_cleanup_receipts(installation_id,cleaned_at,failure_id)`,
  `CREATE INDEX memory_failure_cleanup_session ON memory_failure_cleanup_receipts(installation_id,session_id)`,
  `CREATE TABLE memory_failure_deduplication (
    scope_key text NOT NULL, installation_id uuid REFERENCES memory_installations ON DELETE CASCADE, job_type text NOT NULL, key_hash bytea NOT NULL,
    generation bigint NOT NULL, session_id text NOT NULL, turn_id text NOT NULL,
    PRIMARY KEY(scope_key,job_type,key_hash,generation),
    CHECK(scope_key=COALESCE(installation_id::text,'global'))
  )`,
  `CREATE INDEX memory_failure_dedupe_session ON memory_failure_deduplication(installation_id,session_id)`,
  `INSERT INTO memory_job_failures(job_id,installation_id,job_type,attempts,error_code,payload_hash,dead_at,
     origin,key_hash,session_id,turn_id)
    SELECT d.job_id,d.installation_id,d.job_type,d.attempts,d.error_code,d.payload_hash,d.dead_at,
     'legacy_summary',sha256(convert_to(j.idempotency_key,'UTF8')),COALESCE(j.payload->>'dialogue_session',j.payload->>'session_id'),
     COALESCE(j.payload->>'turn',j.payload->>'turn_id')
    FROM memory_dead_letters d LEFT JOIN memory_jobs j ON j.job_id=d.job_id
      AND j.installation_id IS NOT DISTINCT FROM d.installation_id AND j.job_type=d.job_type`,
  `INSERT INTO memory_job_failures(job_id,installation_id,job_type,attempts,error_code,dead_at,claim_epoch,
      origin,key_hash,session_id,turn_id)
    SELECT j.job_id,j.installation_id,j.job_type,j.attempts,j.last_error_code,COALESCE(j.completed_at,j.created_at),j.claim_epoch,
      'legacy_job',sha256(convert_to(j.idempotency_key,'UTF8')),COALESCE(j.payload->>'dialogue_session',j.payload->>'session_id'),
      COALESCE(j.payload->>'turn',j.payload->>'turn_id')
    FROM memory_jobs j WHERE j.state='dead' AND NOT EXISTS(SELECT 1 FROM memory_dead_letters d WHERE d.job_id=j.job_id)`,
  `UPDATE memory_jobs j SET had_failure=true WHERE state='dead' OR EXISTS(SELECT 1 FROM memory_dead_letters d WHERE d.job_id=j.job_id)`,
  `CREATE FUNCTION memory_mark_failed_job() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN NEW.had_failure=true; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_mark_failed_job BEFORE INSERT OR UPDATE OF state ON memory_jobs
    FOR EACH ROW WHEN (NEW.state='dead') EXECUTE FUNCTION memory_mark_failed_job()`,
  `CREATE FUNCTION memory_failure_scope_available(i uuid,s text) RETURNS boolean LANGUAGE plpgsql AS $$
    BEGIN
      IF i IS NULL THEN RETURN true; END IF;
      IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:installation:'||i::text,0))
        OR (s IS NOT NULL AND NOT pg_try_advisory_xact_lock_shared(hashtextextended('purge:session:'||i::text||':'||s,0)))
        THEN RAISE EXCEPTION 'failure_scope_busy' USING ERRCODE='55P03'; END IF;
      RETURN NOT EXISTS(SELECT 1 FROM memory_installations WHERE installation_id=i AND local_status IN('purging','purged'))
        AND NOT EXISTS(SELECT 1 FROM memory_session_tombstones WHERE installation_id=i AND session_id=s);
    END $$`,
  // Restored data and old writers can leave a dead job without a summary. Keep
  // this conservative placeholder until the fenced terminal writer adds its digest.
  `CREATE FUNCTION memory_capture_job_only_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT memory_failure_scope_available(NEW.installation_id,COALESCE(NEW.payload->>'dialogue_session',NEW.payload->>'session_id'))
        THEN RETURN NULL; END IF;
      INSERT INTO memory_job_failures(job_id,installation_id,job_type,claim_epoch,attempts,error_code,dead_at,
        origin,key_hash,session_id,turn_id)
      VALUES(NEW.job_id,NEW.installation_id,NEW.job_type,NEW.claim_epoch,NEW.attempts,NEW.last_error_code,
        COALESCE(NEW.completed_at,NEW.created_at),'legacy_job',sha256(convert_to(NEW.idempotency_key,'UTF8')),
        COALESCE(NEW.payload->>'dialogue_session',NEW.payload->>'session_id'),COALESCE(NEW.payload->>'turn',NEW.payload->>'turn_id'))
      ON CONFLICT DO NOTHING;
      RETURN NULL;
    END $$`,
  `CREATE TRIGGER memory_capture_job_only_failure AFTER INSERT OR UPDATE OF state ON memory_jobs
    FOR EACH ROW WHEN(NEW.state='dead') EXECUTE FUNCTION memory_capture_job_only_failure()`,
  `CREATE FUNCTION memory_capture_job_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE j memory_jobs%ROWTYPE; sid text;
    BEGIN
      SELECT * INTO j FROM memory_jobs WHERE job_id=NEW.job_id AND job_type=NEW.job_type
        AND installation_id IS NOT DISTINCT FROM NEW.installation_id;
      sid=COALESCE(j.payload->>'dialogue_session',j.payload->>'session_id');
      IF NOT memory_failure_scope_available(NEW.installation_id,sid) THEN RETURN NULL; END IF;
      IF NEW.claim_epoch IS NOT NULL AND (j.job_id IS NULL OR j.state<>'dead' OR j.claim_epoch<>NEW.claim_epoch
          OR j.completed_at IS DISTINCT FROM NEW.dead_at OR j.attempts<>NEW.attempts OR j.last_error_code IS DISTINCT FROM NEW.error_code)
        THEN RAISE EXCEPTION 'failure_claim_mismatch'; END IF;
      DELETE FROM memory_job_failures f WHERE f.job_id=NEW.job_id AND f.claim_epoch=j.claim_epoch AND f.origin='legacy_job'
        AND f.dead_at=NEW.dead_at AND f.attempts=NEW.attempts AND f.error_code=NEW.error_code
        AND f.installation_id IS NOT DISTINCT FROM NEW.installation_id AND f.job_type=NEW.job_type;
      INSERT INTO memory_job_failures(job_id,installation_id,job_type,claim_epoch,input_generation,
        key_hash,session_id,turn_id,attempts,error_code,payload_hash,dead_at,origin)
      VALUES(NEW.job_id,NEW.installation_id,NEW.job_type,NEW.claim_epoch,
        CASE WHEN j.job_type='compile_episode' AND j.payload->>'dialogue_generation' ~ '^[1-9][0-9]{0,18}$' THEN j.payload->>'dialogue_generation'
          WHEN j.job_type='extract_skill_candidate' AND j.payload->>'generation' ~ '^[1-9][0-9]{0,18}$' THEN j.payload->>'generation'
          WHEN j.payload->>'bundle_revision' ~ '^[1-9][0-9]{0,18}$' THEN j.payload->>'bundle_revision'
          ELSE encode(NEW.payload_hash,'hex') END,
        sha256(convert_to(j.idempotency_key,'UTF8')),COALESCE(j.payload->>'dialogue_session',j.payload->>'session_id'),
        COALESCE(j.payload->>'turn',j.payload->>'turn_id'),NEW.attempts,NEW.error_code,NEW.payload_hash,NEW.dead_at,
        CASE WHEN NEW.claim_epoch IS NULL THEN 'legacy_summary' ELSE 'worker' END)
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$`,
  `CREATE TRIGGER memory_capture_job_failure BEFORE INSERT ON memory_dead_letters
    FOR EACH ROW EXECUTE FUNCTION memory_capture_job_failure()`,
  // The shared lock serializes even a concurrent INSERT ... ON CONFLICT whose
  // target tuple disappears during cleanup. A new generation is still accepted.
  `CREATE FUNCTION memory_dedupe_retired_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE scope text=COALESCE(NEW.installation_id::text,'global'); digest bytea=sha256(convert_to(NEW.idempotency_key,'UTF8'));
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('memory:failure-enqueue:'||scope||':'||encode(digest,'hex'),0));
      IF EXISTS(SELECT 1 FROM memory_failure_deduplication d WHERE d.scope_key=scope AND d.job_type=NEW.job_type
        AND d.key_hash=digest AND d.generation::text=NEW.payload->>'dialogue_generation')
        THEN RETURN NULL; END IF;
      RETURN NEW;
    END $$`,
  `CREATE TRIGGER memory_dedupe_retired_failure BEFORE INSERT ON memory_jobs
    FOR EACH ROW WHEN(NEW.job_type='compile_episode' AND NEW.payload ? 'dialogue_generation')
    EXECUTE FUNCTION memory_dedupe_retired_failure()`,
  `CREATE FUNCTION memory_forget_failure_scope(i uuid,s text,t text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      DELETE FROM memory_dead_letters d USING memory_job_failures f WHERE d.job_id=f.job_id AND f.installation_id=i
       AND (s IS NULL OR f.session_id=s) AND (t IS NULL OR f.turn_id=t) AND d.dead_at=f.dead_at
       AND d.installation_id=i AND d.payload_hash=f.payload_hash;
      DELETE FROM memory_failure_cleanup_receipts WHERE installation_id=i AND (s IS NULL OR session_id=s) AND (t IS NULL OR turn_id=t);
      DELETE FROM memory_failure_deduplication WHERE installation_id=i AND (s IS NULL OR session_id=s) AND (t IS NULL OR turn_id=t);
      DELETE FROM memory_job_failures WHERE installation_id=i AND (s IS NULL OR session_id=s) AND (t IS NULL OR turn_id=t);
    END $$`,
  `CREATE FUNCTION memory_forget_turn_failures() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM memory_forget_failure_scope(OLD.installation_id,OLD.session_id,OLD.turn_id); RETURN NULL; END $$`,
  `CREATE FUNCTION memory_forget_deleted_installation_failures() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM memory_forget_failure_scope(OLD.installation_id,NULL,NULL); RETURN NULL; END $$`,
  `CREATE TRIGGER memory_forget_deleted_installation_failures AFTER DELETE ON memory_installations FOR EACH ROW
    EXECUTE FUNCTION memory_forget_deleted_installation_failures()`,
] as const
