// Credit is advanced by actual claims in the existing serialized claim transaction.
// Saturation gives the next available repair a turn even after a long idle period.
export const JOB_ADMISSION_MIGRATION = {version:112,statements:[
  `CREATE TABLE memory_job_dispatch_fairness (
     job_type text PRIMARY KEY, fresh_claims smallint NOT NULL CHECK(fresh_claims BETWEEN 0 AND 4))`,
  `INSERT INTO memory_job_dispatch_fairness VALUES ('compile_episode',0),('consolidate_task',0),
    ('project_shared_source',0),('curate_conclusions',0),('index_claim_version',0),('index_shared_claim',0),('rebuild_claim_index',0)`,
]}

export const SHARED_CLAIM_PROTOCOL = [
  `CREATE OR REPLACE FUNCTION shared.require_memory_job_protocol() RETURNS trigger
   LANGUAGE plpgsql SET search_path=pg_catalog AS $$
   BEGIN
     IF current_setting('pocketctl.failure_isolation_worker',true) IS DISTINCT FROM '1' THEN RETURN NULL; END IF;
     RETURN NEW;
   END $$`,
  'REVOKE ALL ON FUNCTION shared.require_memory_job_protocol() FROM PUBLIC',
  `DROP TRIGGER IF EXISTS memory_job_protocol ON memory.memory_jobs;
   CREATE TRIGGER memory_job_protocol BEFORE UPDATE OF state ON memory.memory_jobs FOR EACH ROW
   WHEN (OLD.state='pending' AND NEW.state='running' AND
     ((NEW.job_type='compile_episode' AND NEW.payload ? 'dialogue_generation') OR
      NEW.job_type IN ('consolidate_task','curate_conclusions','index_claim_version','index_shared_claim','rebuild_claim_index') OR
      (NEW.job_type='project_shared_source' AND NEW.payload#>>'{root,kind}' IN ('team_collaboration','team_delivery'))))
   EXECUTE FUNCTION shared.require_memory_job_protocol()`,
] as const
