/** Upgrade existing Phase 5 installations without rewriting migrations 31-37. */
export const SKILL_REVIEW_FIXES_MIGRATION = {
  version: 38,
  statements: [
    // Skill documents contain objects, arrays and strings. Count compact JSON
    // separators and UTF-16 code units just like canonicalJsonString(doc).length.
    // jsonb::text itself adds formatting spaces and counts Unicode code points.
    `CREATE FUNCTION memory_skill_document_chars(document JSONB) RETURNS BIGINT
      LANGUAGE plpgsql IMMUTABLE STRICT AS $$
      DECLARE total BIGINT;
      BEGIN
        CASE jsonb_typeof(document)
          WHEN 'object' THEN
            SELECT 2 + COALESCE(SUM(memory_skill_document_chars(to_jsonb(e.key)) + 1 + memory_skill_document_chars(e.value)),0)
              + GREATEST(COUNT(*)-1,0) INTO total FROM jsonb_each(document) e;
          WHEN 'array' THEN
            SELECT 2 + COALESCE(SUM(memory_skill_document_chars(e.value)),0)
              + GREATEST(COUNT(*)-1,0) INTO total FROM jsonb_array_elements(document) e;
          ELSE
            SELECT COALESCE(SUM(CASE WHEN ascii(c) > 65535 THEN 2 ELSE 1 END),0) INTO total
              FROM regexp_split_to_table(document::text,'') c;
        END CASE;
        RETURN total;
      END $$`,
    `ALTER TABLE memory_skill_archives DROP CONSTRAINT memory_skill_archives_document_check`,
    `ALTER TABLE memory_skill_archives ADD CONSTRAINT memory_skill_archives_document_check CHECK ((
      jsonb_typeof(document)='object' AND document->>'schema_version'='skill-candidate.v1'
      AND jsonb_typeof(document->'source_tokens')='array'
      AND jsonb_array_length(document->'source_tokens') BETWEEN 1 AND 64
      AND memory_skill_document_chars(document)<=32000) IS TRUE)`,
    `CREATE OR REPLACE FUNCTION memory_skill_snapshot_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE affected_runs UUID[];
      BEGIN
        SELECT COALESCE(ARRAY_AGG(r.run_id),ARRAY[]::UUID[]) INTO affected_runs
          FROM memory_skill_task_runs r JOIN repo_snapshots s USING(installation_id,repo_snapshot_id)
          WHERE r.installation_id=NEW.installation_id AND s.repository_id=NEW.repository_id AND s.commit_sha=NEW.commit_sha;
        -- The repository fence held by snapshot purge prevents new admissions.
        -- Follow task -> run -> generation/job order, retaining unrelated generations.
        PERFORM 1 FROM memory_skill_tasks t WHERE t.installation_id=NEW.installation_id AND EXISTS(
          SELECT 1 FROM memory_skill_task_runs r WHERE r.run_id=ANY(affected_runs) AND r.task_id=t.task_id)
          ORDER BY t.task_id FOR UPDATE;
        UPDATE memory_skill_task_runs SET state='cancelled',error_code='skill_source_invalidated',completed_at=NOW()
          WHERE run_id=ANY(affected_runs) AND state IN('pending','running','candidate');
        UPDATE memory_generation_runs g SET state='cancelled',error_code='skill_source_invalidated',completed_at=NOW()
          FROM memory_skill_task_runs r WHERE r.run_id=ANY(affected_runs) AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
        UPDATE memory_jobs j SET state='completed',last_error_code='skill_source_invalidated',completed_at=NOW(),claim_expires_at=NULL
          WHERE j.installation_id=NEW.installation_id AND j.job_type='extract_skill_candidate' AND j.state IN('pending','running')
            AND EXISTS(SELECT 1 FROM memory_skill_task_runs r WHERE r.run_id=ANY(affected_runs)
              AND j.payload->>'task_id'=r.task_id::text AND j.payload->>'generation'=r.generation::text);
        DELETE FROM memory_skill_archives a USING memory_skill_task_runs r
          WHERE r.run_id=ANY(affected_runs) AND a.installation_id=r.installation_id AND a.task_id=r.task_id AND a.generation=r.generation;
        UPDATE memory_skill_tasks t SET state='cancelled',updated_at=NOW()
          WHERE t.installation_id=NEW.installation_id AND EXISTS(SELECT 1 FROM memory_skill_task_runs r
            WHERE r.run_id=ANY(affected_runs) AND r.task_id=t.task_id AND r.generation=t.current_generation);
        RETURN NEW;
      END $$`,
  ],
} as const
