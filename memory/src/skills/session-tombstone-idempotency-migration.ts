/** Version32 is frozen. This explicit upgrade preserves its terminal effects
 * and ordered task locks whenever ANY associated effect remains mutable.
 * Settled cancelled tasks no longer receive redundant timestamp updates. That
 * physical idempotence is required before a paged final barrier; this does not
 * make a direct whole-Session purge bounded. No rows/tables/links are removed.
 * SQL intentionally repeats the historical function so the exact upgraded
 * definition is reviewable without unchecked source-string rewrites. */
export const SKILL_SESSION_TOMBSTONE_IDEMPOTENCY_MIGRATION={version:95,statements:[
 `CREATE OR REPLACE FUNCTION memory_skill_session_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  PERFORM 1 FROM memory_skill_tasks t WHERE t.installation_id=NEW.installation_id AND(
   EXISTS(SELECT 1 FROM memory_skill_task_runs r JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id
    WHERE r.installation_id=t.installation_id AND r.task_id=t.task_id AND e.session_id=NEW.session_id AND(
     r.state IN('pending','running','candidate')
     OR(r.state='cancelled' AND r.generation=t.current_generation AND t.state<>'cancelled')
     OR EXISTS(SELECT 1 FROM memory_generation_runs g WHERE g.run_id=r.generation_run_id AND g.state IN('queued','running'))
     OR EXISTS(SELECT 1 FROM memory_jobs j WHERE j.installation_id=r.installation_id AND j.job_type='extract_skill_candidate'
      AND j.state IN('pending','running') AND j.payload->>'task_id'=r.task_id::text AND j.payload->>'generation'=r.generation::text)))
   OR EXISTS(SELECT 1 FROM memory_skill_archives a JOIN work_episodes e ON e.installation_id=a.installation_id AND e.episode_id=a.episode_id
    WHERE a.installation_id=t.installation_id AND a.task_id=t.task_id AND e.session_id=NEW.session_id))
   ORDER BY t.task_id FOR UPDATE;
  DELETE FROM memory_skill_archives a USING work_episodes e
   WHERE a.installation_id=NEW.installation_id AND a.episode_id=e.episode_id AND e.installation_id=NEW.installation_id AND e.session_id=NEW.session_id;
  UPDATE memory_skill_task_runs r SET state='cancelled',error_code='session_purged',completed_at=NOW()
   FROM work_episodes e WHERE r.installation_id=NEW.installation_id AND r.episode_id=e.episode_id
    AND e.installation_id=NEW.installation_id AND e.session_id=NEW.session_id AND r.state IN('pending','running','candidate');
  UPDATE memory_generation_runs g SET state='cancelled',error_code='session_purged',completed_at=NOW()
   FROM memory_skill_task_runs r JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id
   WHERE r.installation_id=NEW.installation_id AND e.session_id=NEW.session_id AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
  UPDATE memory_skill_tasks t SET state='cancelled',updated_at=NOW()
   WHERE t.installation_id=NEW.installation_id AND t.state<>'cancelled' AND EXISTS(SELECT 1 FROM memory_skill_task_runs r
    JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id
    WHERE r.installation_id=t.installation_id AND r.task_id=t.task_id AND r.generation=t.current_generation AND e.session_id=NEW.session_id AND r.state='cancelled');
  UPDATE memory_jobs j SET state='completed',last_error_code='session_purged',completed_at=NOW(),claim_expires_at=NULL
   WHERE j.installation_id=NEW.installation_id AND j.job_type='extract_skill_candidate' AND j.state IN('pending','running')
    AND EXISTS(SELECT 1 FROM memory_skill_task_runs r JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id
     WHERE r.installation_id=j.installation_id AND r.task_id::text=j.payload->>'task_id' AND r.generation::text=j.payload->>'generation' AND e.session_id=NEW.session_id);
  RETURN NULL;
 END $$`,
]} as const
