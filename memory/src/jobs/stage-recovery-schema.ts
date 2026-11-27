export const STAGE_RECOVERY_MIGRATION={version:114,statements:[
  `CREATE TABLE memory_index_rebuild_page_receipts(job_id uuid PRIMARY KEY,installation_id uuid NOT NULL REFERENCES memory_installations ON DELETE CASCADE,
    input_digest text NOT NULL,claim_epoch bigint NOT NULL,examined_count integer NOT NULL CHECK(examined_count BETWEEN 0 AND 1000),
    dispatched_count integer NOT NULL CHECK(dispatched_count BETWEEN 0 AND examined_count),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp())`,
  `CREATE TABLE memory_stage_dispositions(
    job_id uuid PRIMARY KEY,claim_epoch bigint NOT NULL,installation_id uuid NOT NULL REFERENCES memory_installations ON DELETE CASCADE,
    job_type text NOT NULL,object_key text NOT NULL,input_digest text NOT NULL,session_id text,
    status text NOT NULL CHECK(status IN('retrying','isolated','repair_queued','resolved')),reason text NOT NULL,
    first_isolated_at timestamptz,first_isolation_reason text,
    attempts integer NOT NULL CHECK(attempts>0),dependency_digest text,processor_revision text NOT NULL,
    first_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),closed_at timestamptz,next_probe_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),probes integer NOT NULL DEFAULT 0,repair_attempts integer NOT NULL DEFAULT 0)`,
  `CREATE INDEX memory_stage_job_intake ON memory_jobs(installation_id,job_type,created_at DESC,job_id)`,
  `CREATE INDEX memory_stage_unresolved_age ON memory_stage_dispositions(installation_id,job_type,first_failed_at) WHERE status<>'resolved'`,
  `CREATE INDEX memory_stage_probe_due ON memory_stage_dispositions(next_probe_at,installation_id,job_id) WHERE next_probe_at IS NOT NULL`,
  `CREATE INDEX memory_stage_installation ON memory_stage_dispositions(installation_id,job_type,status)`,
  `CREATE FUNCTION memory_keep_initial_stage_failure() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN
       IF NEW.status='isolated' AND NEW.first_isolated_at IS NULL THEN
         NEW.first_isolated_at=clock_timestamp();NEW.first_isolation_reason=NEW.reason;
       END IF; RETURN NEW;END $$`,
  `CREATE TRIGGER memory_keep_initial_stage_failure BEFORE INSERT OR UPDATE OF status ON memory_stage_dispositions
    FOR EACH ROW EXECUTE FUNCTION memory_keep_initial_stage_failure()`,
  `CREATE FUNCTION memory_wake_stage_receipt_check() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN
      UPDATE memory_stage_dispositions SET next_probe_at=clock_timestamp() WHERE job_id=NEW.job_id
        AND status IN('retrying','repair_queued');
      RETURN NULL;END $$`,
  `CREATE TRIGGER memory_wake_stage_receipt_check AFTER UPDATE OF state ON memory_jobs
    FOR EACH ROW WHEN (OLD.state='running' AND NEW.state='completed' AND OLD.job_type IN
      ('project_shared_source','curate_conclusions','consolidate_task','index_claim_version','index_shared_claim','rebuild_claim_index'))
    EXECUTE FUNCTION memory_wake_stage_receipt_check()`,
  `CREATE FUNCTION memory_forget_stage_dispositions() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN
    IF TG_TABLE_NAME='memory_session_tombstones' THEN
      DELETE FROM memory_stage_dispositions WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id;
    ELSE
      DELETE FROM memory_index_rebuild_page_receipts WHERE installation_id=NEW.installation_id;
      DELETE FROM memory_stage_dispositions WHERE installation_id=NEW.installation_id;
    END IF; RETURN NULL; END $$`,
  `CREATE TRIGGER forget_session_stage_dispositions AFTER INSERT OR UPDATE ON memory_session_tombstones
    FOR EACH ROW EXECUTE FUNCTION memory_forget_stage_dispositions()`,
  `CREATE TRIGGER forget_installation_stage_dispositions AFTER UPDATE OF relay_status,local_status ON memory_installations
    FOR EACH ROW WHEN (NEW.relay_status='revoked' OR NEW.local_status IN('purging','purged'))
    EXECUTE FUNCTION memory_forget_stage_dispositions()`,
]}
