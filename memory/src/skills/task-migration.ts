/** Phase 5 Task 4/5 queue, run and candidate ledgers. */
export const SKILL_TASK_MIGRATION = {
  version: 32,
  statements: [
    `ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check`,
    `ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check CHECK (job_type IN
      ('project_feed','compile_episode','snapshot_reconcile','session_purge','installation_purge',
       'report_status','report_usage','extract_candidates','index_claim_version','rebuild_claim_index',
       'expire_claims','recompile_extraction_policy','compile_context_shadow','record_context_delivery',
       'invalidate_context_packs','expire_promotion_candidates','index_shared_claim',
       'invalidate_scope_authorization','transfer_scope_claims','parse_code_snapshot','build_wiki',
       'extract_skill_candidate'))`,
    `ALTER TABLE memory_generation_runs DROP CONSTRAINT memory_generation_runs_operation_check`,
    `ALTER TABLE memory_generation_runs ADD CONSTRAINT memory_generation_runs_operation_check CHECK (operation IN
      ('extract_candidates','compile_context','compress_context_shadow','build_wiki','extract_skill_candidate'))`,
    `ALTER TABLE memory_generation_runs ADD CONSTRAINT memory_generation_runs_installation_run_unique
      UNIQUE(installation_id,run_id)`,
    `ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_installation_job_unique UNIQUE(installation_id,job_id)`,
    `ALTER TABLE memory_generation_runs ADD CONSTRAINT memory_generation_runs_installation_job_fk
      FOREIGN KEY(installation_id,job_id) REFERENCES memory_jobs(installation_id,job_id) ON DELETE SET NULL (job_id)`,
    `CREATE TABLE memory_skill_tasks (
      task_id UUID PRIMARY KEY,
      installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      repository_id UUID NOT NULL,
      candidate_key TEXT NOT NULL CHECK (candidate_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
      current_generation BIGINT NOT NULL DEFAULT 0 CHECK (current_generation BETWEEN 0 AND 9007199254740991),
      current_input_digest TEXT CHECK (current_input_digest ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','candidate','cancelled','dead')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (installation_id, task_id), UNIQUE (installation_id, repository_id, candidate_key),
      FOREIGN KEY (installation_id, repository_id) REFERENCES repositories(installation_id,repository_id) ON DELETE CASCADE
    )`,
    `CREATE TABLE memory_skill_task_runs (
      run_id UUID PRIMARY KEY, installation_id UUID NOT NULL, task_id UUID NOT NULL,
      generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('episode','claim_version')),
      repository_id UUID NOT NULL, repo_snapshot_id UUID NOT NULL,
      episode_id UUID, claim_version_id UUID,
      source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
      input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
      policy_version TEXT NOT NULL, owner_scope_kind TEXT NOT NULL CHECK (owner_scope_kind IN ('personal','team','organization')),
      authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch>0), grant_snapshot JSONB NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
        ('pending','running','candidate','cancelled','failed','stale_generation')),
      generation_run_id UUID, error_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
      UNIQUE (installation_id, task_id, generation), UNIQUE (installation_id, run_id),
      CHECK ((source_kind='episode' AND episode_id IS NOT NULL AND claim_version_id IS NULL)
        OR (source_kind='claim_version' AND claim_version_id IS NOT NULL AND episode_id IS NULL)),
      FOREIGN KEY (installation_id,task_id) REFERENCES memory_skill_tasks(installation_id,task_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id,repository_id) REFERENCES repositories(installation_id,repository_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id,repo_snapshot_id) REFERENCES repo_snapshots(installation_id,repo_snapshot_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id,episode_id) REFERENCES work_episodes(installation_id,episode_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id,claim_version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id,generation_run_id) REFERENCES memory_generation_runs(installation_id,run_id) ON DELETE CASCADE
    )`,
    `CREATE INDEX memory_skill_task_runs_pending ON memory_skill_task_runs(installation_id,state,created_at)
      WHERE state IN ('pending','running')`,
    `CREATE TABLE memory_skill_candidates (
      candidate_id UUID PRIMARY KEY, installation_id UUID NOT NULL, task_id UUID NOT NULL,
      generation BIGINT NOT NULL, archive_id UUID NOT NULL, generation_run_id UUID NOT NULL,
      document_hash TEXT NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate','superseded','revoked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (installation_id,task_id,generation), UNIQUE (installation_id,candidate_id),
      FOREIGN KEY (installation_id,task_id,generation)
        REFERENCES memory_skill_task_runs(installation_id,task_id,generation) ON DELETE CASCADE,
      FOREIGN KEY (installation_id,archive_id) REFERENCES memory_skill_archives(installation_id,archive_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id,generation_run_id) REFERENCES memory_generation_runs(installation_id,run_id) ON DELETE CASCADE
    )`,
    // Generalize the archive for governed Claim inputs. Existing episode rows remain valid.
    `ALTER TABLE memory_skill_archives ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'episode'
      CHECK (source_kind IN ('episode','claim_version'))`,
    `ALTER TABLE memory_skill_archives ADD COLUMN claim_version_id UUID`,
    `ALTER TABLE memory_skill_archives ALTER COLUMN episode_id DROP NOT NULL`,
    `ALTER TABLE memory_skill_archives ADD CONSTRAINT memory_skill_archive_source_kind_check CHECK
      ((source_kind='episode' AND episode_id IS NOT NULL AND claim_version_id IS NULL)
       OR (source_kind='claim_version' AND claim_version_id IS NOT NULL AND episode_id IS NULL))`,
    `ALTER TABLE memory_skill_archives ADD CONSTRAINT memory_skill_archive_claim_version_fk
      FOREIGN KEY (installation_id,claim_version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE`,
    `CREATE OR REPLACE FUNCTION memory_skill_archive_check_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_kind='episode' THEN
          PERFORM 1 FROM work_episodes e
          JOIN repo_snapshots s ON s.installation_id=e.installation_id AND s.repo_snapshot_id=e.repo_snapshot_id
          JOIN memory_installations i ON i.installation_id=e.installation_id
          WHERE e.installation_id=NEW.installation_id AND e.episode_id=NEW.episode_id
            AND e.repository_id=NEW.repository_id AND e.repo_snapshot_id=NEW.repo_snapshot_id
            AND s.repository_id=NEW.repository_id AND e.state='ready' AND e.outcome='completed'
            AND encode(e.source_digest,'hex')=NEW.source_digest AND i.relay_status='active'
            AND i.local_status NOT IN ('purging','purged','integrity_error')
            AND NOT EXISTS (SELECT 1 FROM memory_repository_tombstones rt
              WHERE rt.installation_id=NEW.installation_id AND rt.repository_id=NEW.repository_id)
          FOR SHARE OF e,s,i;
        ELSE
          PERFORM 1 FROM knowledge_versions v JOIN knowledge_claims c USING(installation_id,claim_id)
          JOIN repo_snapshots s ON s.installation_id=v.installation_id AND s.repo_snapshot_id=NEW.repo_snapshot_id
          WHERE v.installation_id=NEW.installation_id AND v.version_id=NEW.claim_version_id
            AND c.current_version_id=v.version_id AND c.state='active' AND s.repository_id=NEW.repository_id
            AND (v.valid_from IS NULL OR v.valid_from<=NOW()) AND (v.valid_until IS NULL OR v.valid_until>NOW())
            AND NOT EXISTS (SELECT 1 FROM memory_repository_tombstones rt
              WHERE rt.installation_id=NEW.installation_id AND rt.repository_id=NEW.repository_id)
          FOR SHARE OF c,v,s;
        END IF;
        IF NOT FOUND THEN RAISE EXCEPTION 'skill_archive_source_invalid'; END IF;
        NEW.created_transaction:=pg_current_xact_id(); NEW.generated_at:=NOW(); RETURN NEW;
      END $$`,
    `ALTER TABLE memory_skill_archive_sources ADD COLUMN evidence_id UUID`,
    `ALTER TABLE memory_skill_archive_sources ADD CONSTRAINT memory_skill_source_evidence_fk
      FOREIGN KEY (installation_id,evidence_id) REFERENCES knowledge_evidence(installation_id,evidence_id) ON DELETE CASCADE`,
    `CREATE OR REPLACE FUNCTION memory_skill_source_check_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE a memory_skill_archives%ROWTYPE; m JSONB;
      BEGIN SELECT * INTO a FROM memory_skill_archives WHERE installation_id=NEW.installation_id AND archive_id=NEW.archive_id FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'skill_source_invalid'; END IF;
        IF a.created_transaction<>pg_current_xact_id() THEN RAISE EXCEPTION 'skill_archive_immutable'; END IF;
        IF a.source_kind='episode' THEN
          SELECT evidence_manifest->NEW.evidence_handle INTO m FROM work_episodes
            WHERE installation_id=NEW.installation_id AND episode_id=a.episode_id;
          IF NEW.evidence_id IS NOT NULL OR m IS NULL OR m->>'kind' IS DISTINCT FROM NEW.evidence_kind
            OR m->>'excerpt_hash' IS DISTINCT FROM NEW.excerpt_hash
            OR m->>'source_event_id' IS DISTINCT FROM NEW.source_event_id::text
            OR m->>'artifact_id' IS DISTINCT FROM NEW.artifact_id::text
            OR COALESCE((m->>'omitted')::boolean,FALSE) OR COALESCE((m->>'excerpt_length')::integer,0)<=0
          THEN RAISE EXCEPTION 'skill_source_invalid'; END IF;
        ELSE
          PERFORM 1 FROM knowledge_evidence e WHERE e.installation_id=NEW.installation_id
            AND e.evidence_id=NEW.evidence_id AND e.version_id=a.claim_version_id
            AND e.evidence_kind=NEW.evidence_kind AND encode(e.excerpt_hash,'hex')=NEW.excerpt_hash
            AND e.source_event_id IS NOT DISTINCT FROM NEW.source_event_id
            AND e.artifact_id IS NOT DISTINCT FROM NEW.artifact_id FOR SHARE;
          IF NOT FOUND THEN RAISE EXCEPTION 'skill_source_invalid'; END IF;
        END IF;
        IF NOT (a.document->'source_tokens' ? NEW.source_token) THEN RAISE EXCEPTION 'skill_source_invalid'; END IF;
        RETURN NEW; END $$`,
    `CREATE OR REPLACE FUNCTION memory_skill_episode_invalidate_archives() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state<>'ready' OR NEW.outcome IS DISTINCT FROM 'completed'
        OR NEW.repository_id IS DISTINCT FROM OLD.repository_id OR NEW.repo_snapshot_id IS DISTINCT FROM OLD.repo_snapshot_id
        OR NEW.source_digest IS DISTINCT FROM OLD.source_digest OR NEW.evidence_manifest IS DISTINCT FROM OLD.evidence_manifest
        THEN
          PERFORM 1 FROM memory_skill_tasks t WHERE t.installation_id=NEW.installation_id AND EXISTS(
            SELECT 1 FROM memory_skill_task_runs r WHERE r.installation_id=t.installation_id AND r.task_id=t.task_id AND r.episode_id=NEW.episode_id)
            ORDER BY t.task_id FOR UPDATE;
          DELETE FROM memory_skill_archives WHERE installation_id=NEW.installation_id AND episode_id=NEW.episode_id;
          UPDATE memory_skill_task_runs SET state='cancelled',error_code='source_invalidated',completed_at=NOW()
            WHERE installation_id=NEW.installation_id AND episode_id=NEW.episode_id AND state IN('pending','running');
          UPDATE memory_skill_tasks t SET state='cancelled',updated_at=NOW()
            WHERE t.installation_id=NEW.installation_id AND EXISTS(SELECT 1 FROM memory_skill_task_runs r
              WHERE r.installation_id=t.installation_id AND r.task_id=t.task_id AND r.generation=t.current_generation
                AND r.episode_id=NEW.episode_id AND r.state='cancelled');
          UPDATE memory_generation_runs g SET state='cancelled',error_code='source_invalidated',completed_at=NOW()
            FROM memory_skill_task_runs r WHERE r.installation_id=NEW.installation_id AND r.episode_id=NEW.episode_id
              AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
          UPDATE memory_jobs j SET state='completed',last_error_code='source_invalidated',completed_at=NOW(),claim_expires_at=NULL
            WHERE j.installation_id=NEW.installation_id AND j.job_type='extract_skill_candidate' AND j.state IN('pending','running')
              AND EXISTS(SELECT 1 FROM memory_skill_task_runs r WHERE r.installation_id=j.installation_id
                AND r.task_id::text=j.payload->>'task_id' AND r.generation::text=j.payload->>'generation' AND r.episode_id=NEW.episode_id);
        END IF; RETURN NULL; END $$`,
    `CREATE FUNCTION memory_skill_archive_invalidate_task() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM memory_skill_tasks WHERE installation_id=OLD.installation_id AND task_id=OLD.task_id FOR UPDATE;
        UPDATE memory_skill_task_runs SET state='cancelled',error_code='source_invalidated',completed_at=NOW()
          WHERE installation_id=OLD.installation_id AND task_id=OLD.task_id AND generation=OLD.generation
            AND state IN('pending','running','candidate');
        UPDATE memory_generation_runs g SET state='cancelled',error_code='source_invalidated',completed_at=NOW()
          FROM memory_skill_task_runs r WHERE r.installation_id=OLD.installation_id AND r.task_id=OLD.task_id
            AND r.generation=OLD.generation AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
        UPDATE memory_jobs SET state='completed',last_error_code='source_invalidated',completed_at=NOW(),claim_expires_at=NULL
          WHERE installation_id=OLD.installation_id AND job_type='extract_skill_candidate'
            AND payload->>'task_id'=OLD.task_id::text AND payload->>'generation'=OLD.generation::text
            AND state IN('pending','running');
        UPDATE memory_skill_tasks SET state='cancelled',updated_at=NOW()
          WHERE installation_id=OLD.installation_id AND task_id=OLD.task_id AND current_generation=OLD.generation;
        RETURN NULL;
      END $$`,
    `CREATE TRIGGER memory_skill_archive_deleted AFTER DELETE ON memory_skill_archives
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_invalidate_task()`,
    `CREATE FUNCTION memory_skill_claim_invalidate_archives() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state<>'active' OR NEW.current_version_id IS DISTINCT FROM OLD.current_version_id OR NEW.conflict_group_id IS NOT NULL THEN
          PERFORM 1 FROM memory_skill_tasks t WHERE t.installation_id=OLD.installation_id AND EXISTS(
            SELECT 1 FROM memory_skill_task_runs r JOIN knowledge_versions v ON v.installation_id=r.installation_id AND v.version_id=r.claim_version_id
            WHERE r.installation_id=t.installation_id AND r.task_id=t.task_id AND v.claim_id=OLD.claim_id)
            ORDER BY t.task_id FOR UPDATE;
          DELETE FROM memory_skill_archives a USING knowledge_versions v
            WHERE a.installation_id=OLD.installation_id AND a.claim_version_id=v.version_id
              AND v.installation_id=OLD.installation_id AND v.claim_id=OLD.claim_id;
          UPDATE memory_skill_task_runs r SET state='cancelled',error_code='claim_invalidated',completed_at=NOW()
            FROM knowledge_versions v WHERE r.installation_id=OLD.installation_id AND r.claim_version_id=v.version_id
              AND v.installation_id=OLD.installation_id AND v.claim_id=OLD.claim_id
              AND r.state IN('pending','running','candidate');
          UPDATE memory_skill_tasks t SET state='cancelled',updated_at=NOW()
            WHERE t.installation_id=OLD.installation_id AND EXISTS(SELECT 1 FROM memory_skill_task_runs r
              JOIN knowledge_versions v ON v.installation_id=r.installation_id AND v.version_id=r.claim_version_id
              WHERE r.installation_id=t.installation_id AND r.task_id=t.task_id AND r.generation=t.current_generation
                AND v.claim_id=OLD.claim_id AND r.state='cancelled');
          UPDATE memory_generation_runs g SET state='cancelled',error_code='claim_invalidated',completed_at=NOW()
            FROM memory_skill_task_runs r JOIN knowledge_versions v ON v.installation_id=r.installation_id AND v.version_id=r.claim_version_id
            WHERE r.installation_id=OLD.installation_id AND v.claim_id=OLD.claim_id
              AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
          UPDATE memory_jobs j SET state='completed',last_error_code='claim_invalidated',completed_at=NOW(),claim_expires_at=NULL
            WHERE j.installation_id=OLD.installation_id AND j.job_type='extract_skill_candidate' AND j.state IN('pending','running')
              AND EXISTS(SELECT 1 FROM memory_skill_task_runs r JOIN knowledge_versions v
                ON v.installation_id=r.installation_id AND v.version_id=r.claim_version_id
                WHERE r.installation_id=j.installation_id AND r.task_id::text=j.payload->>'task_id'
                  AND r.generation::text=j.payload->>'generation' AND v.claim_id=OLD.claim_id);
        END IF; RETURN NULL;
      END $$`,
    `CREATE TRIGGER memory_skill_claim_invalidated AFTER UPDATE OF state,current_version_id,conflict_group_id ON knowledge_claims
      FOR EACH ROW EXECUTE FUNCTION memory_skill_claim_invalidate_archives()`,
    `CREATE FUNCTION memory_skill_repository_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM memory_skill_tasks WHERE installation_id=NEW.installation_id AND repository_id=NEW.repository_id ORDER BY task_id FOR UPDATE;
        DELETE FROM memory_skill_archives WHERE installation_id=NEW.installation_id AND repository_id=NEW.repository_id;
        UPDATE memory_skill_task_runs SET state='cancelled',error_code='repository_purged',completed_at=NOW()
          WHERE installation_id=NEW.installation_id AND repository_id=NEW.repository_id AND state IN('pending','running','candidate');
        UPDATE memory_skill_tasks SET state='cancelled',updated_at=NOW()
          WHERE installation_id=NEW.installation_id AND repository_id=NEW.repository_id;
        UPDATE memory_generation_runs g SET state='cancelled',error_code='repository_purged',completed_at=NOW()
          FROM memory_skill_task_runs r WHERE r.installation_id=NEW.installation_id AND r.repository_id=NEW.repository_id
            AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
        UPDATE memory_jobs j SET state='completed',last_error_code='repository_purged',completed_at=NOW(),claim_expires_at=NULL
          WHERE j.installation_id=NEW.installation_id AND j.job_type='extract_skill_candidate' AND j.state IN('pending','running')
            AND EXISTS(SELECT 1 FROM memory_skill_tasks t WHERE t.installation_id=j.installation_id
              AND t.task_id::text=j.payload->>'task_id' AND t.repository_id=NEW.repository_id);
        RETURN NULL;
      END $$`,
    `CREATE TRIGGER memory_skill_repository_purged AFTER INSERT ON memory_repository_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_repository_tombstone()`,
    `CREATE FUNCTION memory_skill_session_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM memory_skill_tasks t WHERE t.installation_id=NEW.installation_id AND EXISTS(
          SELECT 1 FROM memory_skill_task_runs r JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id
          WHERE r.installation_id=t.installation_id AND r.task_id=t.task_id AND e.session_id=NEW.session_id)
          ORDER BY t.task_id FOR UPDATE;
        DELETE FROM memory_skill_archives a USING work_episodes e
          WHERE a.installation_id=NEW.installation_id AND a.episode_id=e.episode_id
            AND e.installation_id=NEW.installation_id AND e.session_id=NEW.session_id;
        UPDATE memory_skill_task_runs r SET state='cancelled',error_code='session_purged',completed_at=NOW()
          FROM work_episodes e WHERE r.installation_id=NEW.installation_id AND r.episode_id=e.episode_id
            AND e.installation_id=NEW.installation_id AND e.session_id=NEW.session_id
            AND r.state IN('pending','running','candidate');
        UPDATE memory_generation_runs g SET state='cancelled',error_code='session_purged',completed_at=NOW()
          FROM memory_skill_task_runs r JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id
          WHERE r.installation_id=NEW.installation_id AND e.session_id=NEW.session_id
            AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
        UPDATE memory_skill_tasks t SET state='cancelled',updated_at=NOW()
          WHERE t.installation_id=NEW.installation_id AND EXISTS(SELECT 1 FROM memory_skill_task_runs r
            JOIN work_episodes e ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id
            WHERE r.installation_id=t.installation_id AND r.task_id=t.task_id AND r.generation=t.current_generation
              AND e.session_id=NEW.session_id AND r.state='cancelled');
        UPDATE memory_jobs j SET state='completed',last_error_code='session_purged',completed_at=NOW(),claim_expires_at=NULL
          WHERE j.installation_id=NEW.installation_id AND j.job_type='extract_skill_candidate' AND j.state IN('pending','running')
            AND EXISTS(SELECT 1 FROM memory_skill_task_runs r JOIN work_episodes e
              ON e.installation_id=r.installation_id AND e.episode_id=r.episode_id
              WHERE r.installation_id=j.installation_id AND r.task_id::text=j.payload->>'task_id'
                AND r.generation::text=j.payload->>'generation' AND e.session_id=NEW.session_id);
        RETURN NULL;
      END $$`,
    `CREATE TRIGGER memory_skill_session_purged AFTER INSERT ON memory_session_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_session_tombstone()`,
  ],
} as const
