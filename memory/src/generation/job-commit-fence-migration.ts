/** Commit-time lease check for explicitly job-fenced output transactions. */
export const JOB_COMMIT_FENCE_MIGRATION={version:56,statements:[
  `CREATE FUNCTION memory_check_job_commit_fence() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE stamp jsonb; owned boolean;
  BEGIN
    stamp:=NULLIF(current_setting('pocketctl.job_fence',true),'')::jsonb;
    IF stamp IS NULL THEN RETURN NULL; END IF;
    SELECT claimed_by=stamp->>'claimedBy' AND claim_epoch=(stamp->>'claimEpoch')::bigint
      AND ((state='running' AND claim_expires_at>clock_timestamp())
        OR (state IN('completed','dead') AND completed_at<=(stamp->>'leaseUntil')::timestamptz
          AND clock_timestamp()<(stamp->>'leaseUntil')::timestamptz))
      INTO owned FROM memory_jobs WHERE job_id=(stamp->>'jobId')::uuid;
    IF owned IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'stale_job_fence' USING ERRCODE='55000';
    END IF;
    RETURN NULL;
  END $$`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_generation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_extraction_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_candidates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_context_packs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_usage_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_skill_tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_skill_task_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_skill_candidates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_skill_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_source_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_code_graph_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_code_nodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_code_edges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_code_graph_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_wiki_build_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_wiki_pages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_git_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON knowledge_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON knowledge_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON knowledge_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON claim_search_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_context_pack_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_context_pack_evidence DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_wiki_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_wiki_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_wiki_sections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON memory_wiki_build_candidates DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
  `CREATE CONSTRAINT TRIGGER memory_job_commit_fence AFTER INSERT OR UPDATE ON work_episodes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_job_commit_fence()`,
]}
