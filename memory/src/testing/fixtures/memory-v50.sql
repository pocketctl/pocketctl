-- Frozen Memory v50 schema from fee86dcf; isolated test databases only.
BEGIN;

      CREATE TABLE IF NOT EXISTS memory_schema_migrations (
        version       INTEGER PRIMARY KEY,
        applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS memory_provider_state (
        provider_id          TEXT PRIMARY KEY CHECK (provider_id = 'pocketctl-memory'),
        installation_cursor  TEXT,
        last_discovery_at    TIMESTAMPTZ,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS memory_installations (
        installation_id       UUID PRIMARY KEY,
        provider_id           TEXT NOT NULL CHECK (provider_id = 'pocketctl-memory'),
        relay_status          TEXT NOT NULL CHECK (relay_status IN
                               ('pending','active','paused','revoking','revoked')),
        local_status          TEXT NOT NULL CHECK (local_status IN
                               ('discovering','syncing','ready','degraded','purging','purged','integrity_error')),
        config_version        BIGINT NOT NULL CHECK (config_version >= 1),
        granted_scopes        JSONB NOT NULL DEFAULT '[]'::jsonb,
        subscriptions         JSONB NOT NULL DEFAULT '[]'::jsonb,
        enabled_services      JSONB NOT NULL DEFAULT '[]'::jsonb,
        event_filter          JSONB NOT NULL DEFAULT '{}'::jsonb,
        snapshot_required     BOOLEAN NOT NULL DEFAULT FALSE,
        discovery_generation  BIGINT NOT NULL DEFAULT 0,
        poll_owner            TEXT,
        poll_epoch            BIGINT NOT NULL DEFAULT 0,
        poll_expires_at       TIMESTAMPTZ,
        last_feed_id          BIGINT NOT NULL DEFAULT 0,
        last_pull_at          TIMESTAMPTZ,
        last_ack_at           TIMESTAMPTZ,
        last_error_code       TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS memory_feed_inbox (
        installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        feed_id           BIGINT NOT NULL CHECK (feed_id > 0),
        envelope_version  INTEGER NOT NULL,
        topic             TEXT NOT NULL,
        source_kind       TEXT NOT NULL,
        source_id         TEXT NOT NULL,
        session_id        TEXT,
        turn_id           TEXT,
        event_type        TEXT NOT NULL,
        recorded_at       TIMESTAMPTZ NOT NULL,
        classification    JSONB NOT NULL DEFAULT '{}'::jsonb,
        data              JSONB NOT NULL,
        payload_hash      BYTEA NOT NULL,
        projection_state  TEXT NOT NULL DEFAULT 'pending' CHECK (projection_state IN
                          ('pending','projected','quarantined','purged')),
        error_code        TEXT,
        received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        projected_at      TIMESTAMPTZ,
        PRIMARY KEY (installation_id, feed_id)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_feed_inbox_pending
        ON memory_feed_inbox (installation_id, feed_id)
        WHERE projection_state = 'pending';

      CREATE TABLE IF NOT EXISTS memory_snapshot_runs (
        run_id             UUID PRIMARY KEY,
        installation_id    UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        generation         BIGINT NOT NULL,
        state              TEXT NOT NULL CHECK (state IN ('running','completed','failed')),
        inventory_cursor   TEXT,
        sessions_seen      BIGINT NOT NULL DEFAULT 0,
        events_seen        BIGINT NOT NULL DEFAULT 0,
        error_code         TEXT,
        started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at       TIMESTAMPTZ,
        UNIQUE (installation_id, generation)
      );

      CREATE TABLE IF NOT EXISTS memory_snapshot_events (
        installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        session_id        TEXT NOT NULL,
        relay_event_id    BIGINT NOT NULL,
        event_type        TEXT NOT NULL,
        payload           JSONB NOT NULL,
        payload_hash      BYTEA NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL,
        generation        BIGINT NOT NULL,
        PRIMARY KEY (installation_id, session_id, relay_event_id)
      );

      CREATE TABLE IF NOT EXISTS source_sessions (
        installation_id     UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        session_id           TEXT NOT NULL,
        agent_type           TEXT,
        daemon_id            TEXT,
        status               TEXT,
        cwd_observation      TEXT,
        worktree_path        TEXT,
        worktree_branch      TEXT,
        first_recorded_at    TIMESTAMPTZ NOT NULL,
        last_recorded_at     TIMESTAMPTZ NOT NULL,
        last_feed_id         BIGINT,
        snapshot_generation  BIGINT,
        deleted_at           TIMESTAMPTZ,
        delete_reason        TEXT,
        PRIMARY KEY (installation_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS source_events (
        source_event_id     UUID PRIMARY KEY,
        installation_id    UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        origin              TEXT NOT NULL CHECK (origin IN ('feed','snapshot')),
        origin_position     TEXT NOT NULL,
        canonical_event_key TEXT,
        session_id          TEXT,
        turn_id             TEXT,
        event_type          TEXT NOT NULL,
        occurred_at         TIMESTAMPTZ NOT NULL,
        classification      JSONB NOT NULL DEFAULT '{}'::jsonb,
        payload             JSONB NOT NULL,
        payload_hash        BYTEA NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (installation_id, origin, origin_position)
      );

      CREATE INDEX IF NOT EXISTS idx_source_events_session_time
        ON source_events (installation_id, session_id, occurred_at, source_event_id);

      CREATE TABLE IF NOT EXISTS source_turns (
        installation_id      UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        turn_id               TEXT NOT NULL,
        session_id            TEXT NOT NULL,
        state                 TEXT NOT NULL CHECK (state IN
                              ('running','interrupt_requested','completed','interrupted','failed','abandoned')),
        origin                TEXT,
        confidence            TEXT,
        reason                TEXT,
        previous_turn_id      TEXT,
        continuation_reason   TEXT,
        actor_scope           TEXT,
        flow_scope            TEXT,
        content_class         TEXT,
        classifier_version    TEXT,
        started_at            TIMESTAMPTZ,
        terminal_at           TIMESTAMPTZ,
        first_source_event_id UUID REFERENCES source_events(source_event_id),
        last_source_event_id  UUID REFERENCES source_events(source_event_id),
        event_count           BIGINT NOT NULL DEFAULT 0,
        lifecycle_anomaly     TEXT,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (installation_id, turn_id),
        FOREIGN KEY (installation_id, session_id)
          REFERENCES source_sessions(installation_id, session_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS source_artifacts (
        artifact_id         UUID PRIMARY KEY,
        installation_id    UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        session_id          TEXT NOT NULL,
        turn_id             TEXT,
        source_event_id     UUID NOT NULL REFERENCES source_events(source_event_id) ON DELETE CASCADE,
        artifact_type       TEXT NOT NULL CHECK (artifact_type IN
                            ('file_change','tool_call','tool_result','test_result','approval','command','other')),
        identity_key        TEXT NOT NULL,
        path                TEXT,
        call_id             TEXT,
        status              TEXT,
        details             JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at         TIMESTAMPTZ NOT NULL,
        UNIQUE (installation_id, source_event_id, artifact_type, identity_key)
      );

      CREATE TABLE IF NOT EXISTS repositories (
        repository_id       UUID PRIMARY KEY,
        installation_id     UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        repository_key      TEXT NOT NULL,
        canonical_remote    TEXT,
        first_observed_at   TIMESTAMPTZ NOT NULL,
        last_observed_at    TIMESTAMPTZ NOT NULL,
        UNIQUE (installation_id, repository_key)
      );

      CREATE TABLE IF NOT EXISTS repo_snapshots (
        repo_snapshot_id    UUID PRIMARY KEY,
        installation_id    UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        repository_id       UUID NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
        commit_sha          TEXT NOT NULL,
        branch              TEXT,
        worktree_identity   TEXT,
        dirty               BOOLEAN,
        observed_at         TIMESTAMPTZ NOT NULL,
        UNIQUE (installation_id, repository_id, commit_sha, observed_at)
      );

      CREATE TABLE IF NOT EXISTS work_episodes (
        installation_id    UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        episode_id          UUID NOT NULL,
        session_id          TEXT NOT NULL,
        turn_id             TEXT NOT NULL,
        state               TEXT NOT NULL CHECK (state IN
                            ('open','stabilizing','ready','invalidated','purged')),
        outcome             TEXT CHECK (outcome IN ('completed','interrupted','failed','abandoned')),
        started_at          TIMESTAMPTZ,
        terminal_at         TIMESTAMPTZ,
        ready_at            TIMESTAMPTZ,
        event_count         BIGINT NOT NULL DEFAULT 0,
        artifact_count      BIGINT NOT NULL DEFAULT 0,
        correction_count    BIGINT NOT NULL DEFAULT 0,
        retry_count         BIGINT NOT NULL DEFAULT 0,
        tool_error_count    BIGINT NOT NULL DEFAULT 0,
        summary             JSONB NOT NULL DEFAULT '{}'::jsonb,
        compiler_version    TEXT NOT NULL,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (installation_id, episode_id),
        UNIQUE (installation_id, turn_id)
      );

      CREATE TABLE IF NOT EXISTS memory_jobs (
        job_id            UUID PRIMARY KEY,
        installation_id   UUID REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        job_type           TEXT NOT NULL CHECK (job_type IN
                           ('project_feed','compile_episode','snapshot_reconcile','session_purge',
                            'installation_purge','report_status','report_usage')),
        idempotency_key    TEXT NOT NULL,
        priority           SMALLINT NOT NULL DEFAULT 100,
        payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
        state              TEXT NOT NULL DEFAULT 'pending' CHECK (state IN
                           ('pending','running','completed','dead')),
        attempts           INTEGER NOT NULL DEFAULT 0,
        available_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_by         TEXT,
        claim_epoch        BIGINT NOT NULL DEFAULT 0,
        claim_expires_at   TIMESTAMPTZ,
        last_error_code    TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at       TIMESTAMPTZ,
        UNIQUE (installation_id, job_type, idempotency_key)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_jobs_global_idempotency
        ON memory_jobs (job_type, idempotency_key)
        WHERE installation_id IS NULL;

      CREATE INDEX IF NOT EXISTS idx_memory_jobs_claim
        ON memory_jobs (priority, available_at, created_at)
        WHERE state = 'pending';

      CREATE TABLE IF NOT EXISTS memory_dead_letters (
        job_id            UUID PRIMARY KEY,
        installation_id   UUID,
        job_type           TEXT NOT NULL,
        attempts           INTEGER NOT NULL,
        error_code         TEXT NOT NULL,
        payload_hash       BYTEA NOT NULL,
        dead_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS memory_session_tombstones (
        installation_id  UUID NOT NULL,
        session_id        TEXT NOT NULL,
        reason            TEXT NOT NULL,
        source_feed_id    BIGINT,
        purged_at         TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (installation_id, session_id)
      );

      CREATE TABLE IF NOT EXISTS memory_purge_receipts (
        request_id        UUID PRIMARY KEY,
        installation_id  UUID NOT NULL,
        reason            TEXT NOT NULL,
        receipt           TEXT NOT NULL,
        local_committed_at TIMESTAMPTZ NOT NULL,
        relay_acked_at    TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS memory_usage_outbox (
        installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        usage_id          TEXT NOT NULL,
        operation         TEXT NOT NULL,
        model             TEXT,
        input_tokens      BIGINT NOT NULL DEFAULT 0,
        output_tokens     BIGINT NOT NULL DEFAULT 0,
        embedding_tokens  BIGINT NOT NULL DEFAULT 0,
        cached_tokens     BIGINT NOT NULL DEFAULT 0,
        cost_micros       BIGINT NOT NULL DEFAULT 0,
        occurred_at       TIMESTAMPTZ NOT NULL,
        reported_at       TIMESTAMPTZ,
        attempts          INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (installation_id, usage_id)
      );
INSERT INTO memory_schema_migrations(version) VALUES (1);
COMMIT;

BEGIN;

      DELETE FROM repo_snapshots older
      USING repo_snapshots newer
      WHERE older.installation_id = newer.installation_id
        AND older.repository_id = newer.repository_id
        AND older.commit_sha = newer.commit_sha
        AND (older.observed_at, older.repo_snapshot_id)
          < (newer.observed_at, newer.repo_snapshot_id);

      ALTER TABLE repo_snapshots
        DROP CONSTRAINT IF EXISTS repo_snapshots_installation_id_repository_id_commit_sha_observed_at_key;

      ALTER TABLE repo_snapshots
        ADD CONSTRAINT repo_snapshots_installation_id_repository_id_commit_sha_key
        UNIQUE (installation_id, repository_id, commit_sha);
INSERT INTO memory_schema_migrations(version) VALUES (2);
COMMIT;

BEGIN;

      ALTER TABLE memory_snapshot_events ADD COLUMN occurred_at TIMESTAMPTZ;

      UPDATE memory_snapshot_events SET occurred_at = created_at WHERE occurred_at IS NULL;
INSERT INTO memory_schema_migrations(version) VALUES (3);
COMMIT;

BEGIN;

      DO $$
      DECLARE stale text;
      BEGIN
        FOR stale IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'repo_snapshots'::regclass
            AND contype = 'u'
            AND pg_get_constraintdef(oid) LIKE '%observed_at%'
        LOOP
          EXECUTE format('ALTER TABLE repo_snapshots DROP CONSTRAINT %I', stale);
        END LOOP;
      END $$;
INSERT INTO memory_schema_migrations(version) VALUES (4);
COMMIT;

BEGIN;

      UPDATE memory_snapshot_runs r
      SET state = 'failed', error_code = 'superseded_running', completed_at = NOW()
      WHERE r.state = 'running'
        AND r.run_id <> (
          SELECT r2.run_id FROM memory_snapshot_runs r2
          WHERE r2.installation_id = r.installation_id AND r2.state = 'running'
          ORDER BY r2.started_at DESC, r2.generation DESC
          LIMIT 1
        );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_snapshot_runs_one_running
        ON memory_snapshot_runs (installation_id)
        WHERE state = 'running';
INSERT INTO memory_schema_migrations(version) VALUES (5);
COMMIT;

BEGIN;

      ALTER TABLE memory_snapshot_runs ADD COLUMN relay_acked_at TIMESTAMPTZ;

      UPDATE memory_snapshot_runs r
      SET relay_acked_at = r.completed_at
      WHERE r.state = 'completed' AND r.relay_acked_at IS NULL
        AND NOT (
          r.generation = (
            SELECT MAX(newer.generation)
            FROM memory_snapshot_runs newer
            WHERE newer.installation_id = r.installation_id
          )
          AND EXISTS (
            SELECT 1 FROM memory_jobs j
            WHERE j.installation_id = r.installation_id
              AND j.job_type = 'snapshot_reconcile'
              AND j.state <> 'completed'
              AND j.created_at <= r.completed_at
          )
        );
INSERT INTO memory_schema_migrations(version) VALUES (6);
COMMIT;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

      ALTER TABLE work_episodes
        ADD COLUMN repository_id UUID,
        ADD COLUMN repo_snapshot_id UUID,
        ADD COLUMN branch TEXT,
        ADD COLUMN source_digest BYTEA,
        ADD COLUMN document JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN evidence_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN document_compiler_version TEXT,
        ADD COLUMN compiled_at TIMESTAMPTZ;

      ALTER TABLE source_events
        ADD CONSTRAINT source_events_installation_event_unique
        UNIQUE (installation_id, source_event_id);

      ALTER TABLE source_artifacts
        ADD CONSTRAINT source_artifacts_installation_artifact_unique
        UNIQUE (installation_id, artifact_id);

      ALTER TABLE repositories
        ADD CONSTRAINT repositories_installation_repository_unique
        UNIQUE (installation_id, repository_id);

      ALTER TABLE repo_snapshots
        ADD CONSTRAINT repo_snapshots_installation_snapshot_unique
        UNIQUE (installation_id, repo_snapshot_id);

      ALTER TABLE work_episodes
        ADD CONSTRAINT work_episodes_installation_episode_unique
        UNIQUE (installation_id, episode_id);

      ALTER TABLE work_episodes
        ADD CONSTRAINT work_episodes_repository_fk
          FOREIGN KEY (installation_id, repository_id)
          REFERENCES repositories(installation_id, repository_id),
        ADD CONSTRAINT work_episodes_snapshot_fk
          FOREIGN KEY (installation_id, repo_snapshot_id)
          REFERENCES repo_snapshots(installation_id, repo_snapshot_id);

      ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check;

      ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check
        CHECK (job_type IN
        ('project_feed','compile_episode','snapshot_reconcile','session_purge',
         'installation_purge','report_status','report_usage',
         'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims'));

      CREATE TABLE memory_feature_settings (
        installation_id UUID PRIMARY KEY
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        extraction_mode TEXT NOT NULL DEFAULT 'off'
          CHECK (extraction_mode IN ('off','shadow','enabled')),
        embedding_mode TEXT NOT NULL DEFAULT 'off'
          CHECK (embedding_mode IN ('off','shadow','enabled')),
        revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE memory_extraction_runs (
        run_id UUID PRIMARY KEY,
        installation_id UUID NOT NULL
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        episode_id UUID NOT NULL,
        episode_source_digest BYTEA NOT NULL,
        extractor_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        model_config_hash BYTEA NOT NULL,
        input_digest BYTEA NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('shadow','enabled')),
        state TEXT NOT NULL CHECK (state IN
          ('running','succeeded','failed','quarantined')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        cost_micros BIGINT NOT NULL DEFAULT 0,
        candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
        error_code TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        UNIQUE (installation_id, episode_id, episode_source_digest,
                extractor_version, model_config_hash),
        FOREIGN KEY (installation_id, episode_id)
          REFERENCES work_episodes(installation_id, episode_id) ON DELETE CASCADE
      );

      CREATE TABLE memory_candidates (
        candidate_id UUID PRIMARY KEY,
        installation_id UUID NOT NULL
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        run_id UUID NOT NULL REFERENCES memory_extraction_runs(run_id) ON DELETE CASCADE,
        episode_id UUID NOT NULL,
        ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
        claim_type TEXT NOT NULL CHECK (claim_type IN
          ('architecture_decision','repository_convention','bug_root_cause',
           'rejected_hypothesis','test_invariant','implementation_map',
           'operational_runbook','work_method','reusable_skill_candidate')),
        statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 4000),
        structured_content JSONB NOT NULL DEFAULT '{}'::jsonb,
        normalized_key TEXT NOT NULL CHECK (char_length(normalized_key) BETWEEN 1 AND 512),
        scope_kind TEXT NOT NULL CHECK (scope_kind IN
          ('installation','repository','snapshot','branch','task')),
        scope_key TEXT NOT NULL CHECK (char_length(scope_key) BETWEEN 1 AND 512),
        repository_id UUID,
        repo_snapshot_id UUID,
        branch TEXT,
        confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        freshness_at TIMESTAMPTZ NOT NULL,
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        status TEXT NOT NULL CHECK (status IN
          ('shadow','validated','duplicate','conflict','rejected_by_validator',
           'rejected','accepted')),
        validation JSONB NOT NULL DEFAULT '{}'::jsonb,
        duplicate_of_claim_id UUID,
        revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        UNIQUE (run_id, ordinal),
        UNIQUE (installation_id, candidate_id),
        FOREIGN KEY (installation_id, episode_id)
          REFERENCES work_episodes(installation_id, episode_id) ON DELETE CASCADE,
        FOREIGN KEY (installation_id, repository_id)
          REFERENCES repositories(installation_id, repository_id),
        FOREIGN KEY (installation_id, repo_snapshot_id)
          REFERENCES repo_snapshots(installation_id, repo_snapshot_id)
      );

      CREATE TABLE knowledge_claims (
        claim_id UUID PRIMARY KEY,
        installation_id UUID NOT NULL
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        claim_type TEXT NOT NULL CHECK (claim_type IN
          ('architecture_decision','repository_convention','bug_root_cause',
           'rejected_hypothesis','test_invariant','implementation_map',
           'operational_runbook','work_method','reusable_skill_candidate')),
        scope_kind TEXT NOT NULL CHECK (scope_kind IN
          ('installation','repository','snapshot','branch','task')),
        scope_key TEXT NOT NULL,
        normalized_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN
          ('active','superseded','expired','revoked')),
        current_version_id UUID,
        superseded_by_claim_id UUID,
        revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (installation_id, claim_type, scope_key, normalized_key),
        UNIQUE (installation_id, claim_id)
      );

      CREATE TABLE knowledge_versions (
        version_id UUID PRIMARY KEY,
        installation_id UUID NOT NULL,
        claim_id UUID NOT NULL,
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        statement TEXT NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 4000),
        structured_content JSONB NOT NULL DEFAULT '{}'::jsonb,
        authority TEXT NOT NULL CHECK (authority IN
          ('user_accepted','user_corrected')),
        confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        repository_id UUID,
        repo_snapshot_id UUID,
        branch TEXT,
        valid_from TIMESTAMPTZ,
        valid_until TIMESTAMPTZ,
        source_candidate_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (claim_id, version_number),
        UNIQUE (installation_id, version_id),
        FOREIGN KEY (installation_id, claim_id)
          REFERENCES knowledge_claims(installation_id, claim_id) ON DELETE CASCADE,
        FOREIGN KEY (installation_id, source_candidate_id)
          REFERENCES memory_candidates(installation_id, candidate_id)
          DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (source_candidate_id)
          REFERENCES memory_candidates(candidate_id) ON DELETE SET NULL,
        FOREIGN KEY (installation_id, repository_id)
          REFERENCES repositories(installation_id, repository_id),
        FOREIGN KEY (installation_id, repo_snapshot_id)
          REFERENCES repo_snapshots(installation_id, repo_snapshot_id)
      );

      ALTER TABLE memory_candidates
        ADD CONSTRAINT memory_candidates_duplicate_claim_fk
        FOREIGN KEY (installation_id, duplicate_of_claim_id)
        REFERENCES knowledge_claims(installation_id, claim_id)
        DEFERRABLE INITIALLY DEFERRED;

      ALTER TABLE memory_candidates
        ADD CONSTRAINT memory_candidates_duplicate_claim_delete_fk
        FOREIGN KEY (duplicate_of_claim_id)
        REFERENCES knowledge_claims(claim_id) ON DELETE SET NULL;

      ALTER TABLE knowledge_claims
        ADD CONSTRAINT knowledge_claims_current_version_fk
        FOREIGN KEY (installation_id, current_version_id)
        REFERENCES knowledge_versions(installation_id, version_id)
        DEFERRABLE INITIALLY DEFERRED;

      ALTER TABLE knowledge_claims
        ADD CONSTRAINT knowledge_claims_superseded_by_fk
        FOREIGN KEY (installation_id, superseded_by_claim_id)
        REFERENCES knowledge_claims(installation_id, claim_id)
        DEFERRABLE INITIALLY DEFERRED;

      ALTER TABLE knowledge_claims
        ADD CONSTRAINT knowledge_claims_superseded_by_delete_fk
        FOREIGN KEY (superseded_by_claim_id)
        REFERENCES knowledge_claims(claim_id) ON DELETE SET NULL;

      CREATE TABLE knowledge_evidence (
        evidence_id UUID PRIMARY KEY,
        installation_id UUID NOT NULL,
        version_id UUID NOT NULL,
        episode_id UUID NOT NULL,
        source_event_id UUID,
        artifact_id UUID,
        evidence_kind TEXT NOT NULL CHECK (evidence_kind IN
          ('event','artifact','episode')),
        locator JSONB NOT NULL DEFAULT '{}'::jsonb,
        excerpt TEXT NOT NULL CHECK (char_length(excerpt) BETWEEN 1 AND 4000),
        excerpt_hash BYTEA NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        ordinal SMALLINT NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (version_id, ordinal),
        CHECK (
          (evidence_kind = 'event' AND source_event_id IS NOT NULL) OR
          (evidence_kind = 'artifact' AND artifact_id IS NOT NULL) OR
          (evidence_kind = 'episode' AND source_event_id IS NULL AND artifact_id IS NULL)
        ),
        FOREIGN KEY (installation_id, version_id)
          REFERENCES knowledge_versions(installation_id, version_id) ON DELETE CASCADE,
        FOREIGN KEY (installation_id, episode_id)
          REFERENCES work_episodes(installation_id, episode_id) ON DELETE CASCADE,
        FOREIGN KEY (installation_id, source_event_id)
          REFERENCES source_events(installation_id, source_event_id) ON DELETE CASCADE,
        FOREIGN KEY (installation_id, artifact_id)
          REFERENCES source_artifacts(installation_id, artifact_id) ON DELETE CASCADE
      );

      CREATE TABLE claim_search_documents (
        installation_id UUID NOT NULL,
        version_id UUID NOT NULL,
        document TEXT NOT NULL,
        search_vector TSVECTOR GENERATED ALWAYS AS
          (to_tsvector('simple'::regconfig, document)) STORED,
        embedding REAL[],
        embedding_provider TEXT,
        embedding_model TEXT,
        embedding_dimensions INTEGER,
        embedding_status TEXT NOT NULL DEFAULT 'pending'
          CHECK (embedding_status IN ('pending','ready','failed','disabled')),
        indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (installation_id, version_id),
        FOREIGN KEY (installation_id, version_id)
          REFERENCES knowledge_versions(installation_id, version_id) ON DELETE CASCADE,
        CHECK (embedding IS NULL OR
          array_length(embedding, 1) = embedding_dimensions)
      );

      CREATE INDEX claim_search_documents_fts
        ON claim_search_documents USING GIN (search_vector);

      CREATE INDEX claim_search_documents_trgm
        ON claim_search_documents USING GIN (document gin_trgm_ops);

      CREATE TABLE memory_feedback (
        feedback_id UUID PRIMARY KEY,
        installation_id UUID NOT NULL
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        request_id UUID,
        candidate_id UUID,
        claim_id UUID,
        version_id UUID,
        action TEXT NOT NULL CHECK (action IN
          ('candidate_accepted','candidate_corrected','candidate_rejected',
           'claim_corrected','claim_expired','claim_revoked','claim_deleted',
           'recall_used','recall_incorrect','recall_not_useful')),
        reason_code TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY (installation_id, candidate_id)
          REFERENCES memory_candidates(installation_id, candidate_id)
          DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (candidate_id)
          REFERENCES memory_candidates(candidate_id) ON DELETE SET NULL,
        FOREIGN KEY (installation_id, claim_id)
          REFERENCES knowledge_claims(installation_id, claim_id)
          DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (claim_id)
          REFERENCES knowledge_claims(claim_id) ON DELETE SET NULL,
        FOREIGN KEY (installation_id, version_id)
          REFERENCES knowledge_versions(installation_id, version_id)
          DEFERRABLE INITIALLY DEFERRED,
        FOREIGN KEY (version_id)
          REFERENCES knowledge_versions(version_id) ON DELETE SET NULL
      );

      CREATE TABLE memory_idempotency_keys (
        installation_id UUID NOT NULL
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 64),
        key_hash BYTEA NOT NULL,
        request_hash BYTEA NOT NULL,
        response_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (installation_id, operation, key_hash),
        CHECK (expires_at > created_at)
      );

      CREATE TABLE knowledge_tombstones (
        installation_id UUID NOT NULL
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 64),
        identity_hmac BYTEA NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('privacy_delete','source_purge')),
        deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (installation_id, key_id, identity_hmac)
      );
INSERT INTO memory_schema_migrations(version) VALUES (7);
COMMIT;

BEGIN;
ALTER TABLE memory_candidates
         ADD COLUMN evidence_handles JSONB NOT NULL DEFAULT '[]'::jsonb,
         ADD CONSTRAINT memory_candidates_evidence_handles_array
           CHECK (jsonb_typeof(evidence_handles) = 'array');
INSERT INTO memory_schema_migrations(version) VALUES (8);
COMMIT;

BEGIN;
ALTER TABLE memory_feature_settings
         ADD COLUMN extraction_consent_fingerprint TEXT,
         ADD COLUMN embedding_consent_fingerprint TEXT;
INSERT INTO memory_schema_migrations(version) VALUES (9);
COMMIT;

BEGIN;
ALTER TABLE claim_search_documents
         ADD COLUMN embedding_fingerprint TEXT;
INSERT INTO memory_schema_migrations(version) VALUES (10);
COMMIT;

BEGIN;
ALTER TABLE memory_usage_outbox
         ADD COLUMN dead_lettered_at TIMESTAMPTZ,
         ADD COLUMN last_error_code TEXT;
ALTER TABLE memory_usage_outbox
         ADD CONSTRAINT memory_usage_outbox_last_error_code_bounded
         CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 128);
INSERT INTO memory_schema_migrations(version) VALUES (11);
COMMIT;

BEGIN;
ALTER TABLE knowledge_versions ADD COLUMN freshness_at TIMESTAMPTZ;
UPDATE knowledge_versions
         SET freshness_at = COALESCE(valid_from, created_at)
         WHERE freshness_at IS NULL;
ALTER TABLE knowledge_versions
         ALTER COLUMN freshness_at SET DEFAULT NOW(),
         ALTER COLUMN freshness_at SET NOT NULL;
INSERT INTO memory_schema_migrations(version) VALUES (12);
COMMIT;

BEGIN;
ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check;
ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check
         CHECK (job_type IN
         ('project_feed','compile_episode','snapshot_reconcile','session_purge',
          'installation_purge','report_status','report_usage',
          'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims',
          'recompile_extraction_policy','compile_context_shadow',
          'record_context_delivery','invalidate_context_packs'));
ALTER TABLE repositories
         ADD CONSTRAINT uq_repositories_installation_repository
         UNIQUE (installation_id, repository_id);
ALTER TABLE knowledge_claims
         ADD CONSTRAINT uq_knowledge_claims_installation_claim
         UNIQUE (installation_id, claim_id);
ALTER TABLE knowledge_versions
         ADD CONSTRAINT uq_knowledge_versions_installation_version
         UNIQUE (installation_id, version_id);
ALTER TABLE knowledge_evidence
         ADD CONSTRAINT uq_knowledge_evidence_installation_evidence
         UNIQUE (installation_id, evidence_id);
CREATE TABLE memory_policy_sets (
         policy_id UUID PRIMARY KEY,
         installation_id UUID REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         policy_kind TEXT NOT NULL CHECK (policy_kind IN ('extraction','context','ranking')),
         layer TEXT NOT NULL CHECK (layer IN ('system','organization','team','repository','user')),
         scope_key TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, policy_kind, layer, scope_key)
       );
CREATE UNIQUE INDEX uq_memory_policy_sets_global_scope
         ON memory_policy_sets (policy_kind, layer, scope_key)
         WHERE installation_id IS NULL;
CREATE TABLE memory_policy_versions (
         policy_version_id UUID PRIMARY KEY,
         policy_id UUID NOT NULL REFERENCES memory_policy_sets(policy_id) ON DELETE CASCADE,
         version_number INTEGER NOT NULL CHECK (version_number > 0),
         schema_version INTEGER NOT NULL CHECK (schema_version > 0),
         document JSONB NOT NULL,
         content_hash BYTEA NOT NULL,
         created_by TEXT NOT NULL CHECK (created_by IN ('system','user')),
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (policy_id, version_number),
         UNIQUE (policy_id, content_hash),
         UNIQUE (policy_id, policy_version_id)
       );
CREATE TABLE memory_policy_heads (
         policy_id UUID PRIMARY KEY REFERENCES memory_policy_sets(policy_id) ON DELETE CASCADE,
         active_version_id UUID NOT NULL,
         revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         FOREIGN KEY (policy_id, active_version_id)
           REFERENCES memory_policy_versions(policy_id, policy_version_id)
       );
CREATE TABLE memory_generation_runs (
         run_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         operation TEXT NOT NULL CHECK (operation IN
           ('extract_candidates','compile_context','compress_context_shadow')),
         subject_kind TEXT NOT NULL,
         subject_key_hash BYTEA NOT NULL,
         input_digest BYTEA NOT NULL,
         effective_policy_hash BYTEA NOT NULL,
         state TEXT NOT NULL CHECK (state IN
           ('queued','running','succeeded','failed','quarantined','cancelled','superseded')),
         provider TEXT,
         model TEXT,
         model_config_hash BYTEA,
         job_id UUID REFERENCES memory_jobs(job_id) ON DELETE SET NULL,
         job_claim_epoch BIGINT,
         output_kind TEXT,
         output_id UUID,
         input_tokens BIGINT NOT NULL DEFAULT 0,
         output_tokens BIGINT NOT NULL DEFAULT 0,
         cached_tokens BIGINT NOT NULL DEFAULT 0,
         cost_micros BIGINT NOT NULL DEFAULT 0,
         duration_ms INTEGER,
         error_code TEXT,
         started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         completed_at TIMESTAMPTZ
       );
CREATE TABLE memory_generation_run_policies (
         run_id UUID NOT NULL REFERENCES memory_generation_runs(run_id) ON DELETE CASCADE,
         ordinal SMALLINT NOT NULL,
         policy_version_id UUID NOT NULL REFERENCES memory_policy_versions(policy_version_id),
         PRIMARY KEY (run_id, ordinal),
         UNIQUE (run_id, policy_version_id)
       );
ALTER TABLE memory_extraction_runs ADD COLUMN generation_run_id UUID;
INSERT INTO memory_generation_runs
         (run_id, installation_id, operation, subject_kind, subject_key_hash,
          input_digest, effective_policy_hash, state, provider, model,
          model_config_hash, input_tokens, output_tokens, cost_micros,
          error_code, started_at, completed_at)
       WITH ranked_legacy_runs AS (
         SELECT er.*, ROW_NUMBER() OVER (
           PARTITION BY er.installation_id, er.episode_id, er.episode_source_digest
           ORDER BY CASE er.state
             WHEN 'succeeded' THEN 0
             WHEN 'quarantined' THEN 1
             WHEN 'running' THEN 2
             ELSE 3
           END,
           er.completed_at DESC NULLS LAST, er.started_at DESC, er.run_id DESC
         ) AS active_rank
         FROM memory_extraction_runs er
       )
       SELECT
         er.run_id, er.installation_id, 'extract_candidates', 'episode',
         decode(md5(er.episode_id::text), 'hex'),
         er.episode_source_digest,
         decode(md5('phase1:no-policy'), 'hex'),
         CASE
           WHEN er.state IN ('queued','running','succeeded','quarantined')
             AND er.active_rank > 1 THEN 'superseded'
           ELSE er.state
         END,
         er.provider, er.model,
         er.model_config_hash, er.input_tokens, er.output_tokens, er.cost_micros,
         er.error_code, er.started_at, er.completed_at
       FROM ranked_legacy_runs er;
UPDATE memory_extraction_runs er
       SET generation_run_id = er.run_id
       WHERE er.generation_run_id IS NULL;
CREATE UNIQUE INDEX uq_generation_runs_active
         ON memory_generation_runs
           (installation_id, operation, subject_kind, subject_key_hash, input_digest, effective_policy_hash)
         WHERE state IN ('queued','running','succeeded','quarantined');
CREATE UNIQUE INDEX uq_extraction_runs_generation_run
         ON memory_extraction_runs(generation_run_id)
         WHERE generation_run_id IS NOT NULL;
CREATE TABLE memory_context_settings (
         setting_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         scope_kind TEXT NOT NULL CHECK (scope_kind IN ('installation','repository','session')),
         scope_key TEXT NOT NULL,
         agent TEXT,
         mode TEXT NOT NULL CHECK (mode IN ('off','shadow','enabled')),
         max_tokens INTEGER CHECK (max_tokens BETWEEN 1 AND 2000),
         revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, scope_kind, scope_key, agent)
       );
CREATE UNIQUE INDEX uq_memory_context_settings_default_agent
         ON memory_context_settings (installation_id, scope_kind, scope_key)
         WHERE agent IS NULL;
CREATE TABLE memory_context_loadouts (
         loadout_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         repository_id UUID,
         agent TEXT,
         revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, repository_id, agent),
         UNIQUE (loadout_id, installation_id),
         FOREIGN KEY (installation_id, repository_id)
           REFERENCES repositories(installation_id, repository_id)
       );
CREATE UNIQUE INDEX uq_memory_context_loadouts_default_agent
         ON memory_context_loadouts (installation_id, repository_id)
         WHERE repository_id IS NOT NULL AND agent IS NULL;
CREATE UNIQUE INDEX uq_memory_context_loadouts_default_repository
         ON memory_context_loadouts (installation_id, agent)
         WHERE repository_id IS NULL AND agent IS NOT NULL;
CREATE UNIQUE INDEX uq_memory_context_loadouts_defaults
         ON memory_context_loadouts (installation_id)
         WHERE repository_id IS NULL AND agent IS NULL;
CREATE TABLE memory_context_loadout_items (
         loadout_id UUID NOT NULL,
         item_id UUID NOT NULL,
         asset_kind TEXT NOT NULL CHECK (asset_kind IN
           ('claim','persona','runbook','wiki','skill')),
         installation_id UUID NOT NULL,
         claim_id UUID,
         external_asset_ref TEXT,
         representation TEXT NOT NULL CHECK (representation IN
           ('summary','on_demand','reference')),
         priority SMALLINT NOT NULL CHECK (priority BETWEEN 0 AND 100),
         PRIMARY KEY (loadout_id, item_id),
         CHECK (
           (asset_kind IN ('claim','persona','runbook')
             AND claim_id IS NOT NULL AND external_asset_ref IS NULL)
           OR
           (asset_kind IN ('wiki','skill')
             AND claim_id IS NULL AND external_asset_ref IS NOT NULL)
         ),
         FOREIGN KEY (loadout_id, installation_id)
           REFERENCES memory_context_loadouts(loadout_id, installation_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, claim_id)
           REFERENCES knowledge_claims(installation_id, claim_id) ON DELETE CASCADE
       );
CREATE UNIQUE INDEX uq_memory_context_loadout_items_claim
         ON memory_context_loadout_items (loadout_id, asset_kind, claim_id)
         WHERE claim_id IS NOT NULL;
CREATE UNIQUE INDEX uq_memory_context_loadout_items_external
         ON memory_context_loadout_items (loadout_id, asset_kind, external_asset_ref)
         WHERE external_asset_ref IS NOT NULL;
CREATE TABLE memory_retrieval_trajectories (
         trajectory_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         request_hmac BYTEA NOT NULL,
         request_key_id TEXT NOT NULL,
         repository_id UUID,
         repo_snapshot_id UUID,
         branch TEXT,
         ranking_policy_version_id UUID REFERENCES memory_policy_versions(policy_version_id),
         backend_plan JSONB NOT NULL,
         result_state TEXT NOT NULL CHECK (result_state IN
           ('completed','empty','degraded','retrieval_failed')),
         degraded_components TEXT[] NOT NULL DEFAULT '{}',
         started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         ended_at TIMESTAMPTZ
       );
CREATE TABLE memory_retrieval_stages (
         trajectory_id UUID NOT NULL REFERENCES memory_retrieval_trajectories(trajectory_id) ON DELETE CASCADE,
         ordinal SMALLINT NOT NULL,
         stage TEXT NOT NULL,
         outcome TEXT NOT NULL,
         candidate_count INTEGER NOT NULL DEFAULT 0,
         duration_ms INTEGER NOT NULL DEFAULT 0,
         degraded_reason TEXT,
         PRIMARY KEY (trajectory_id, ordinal)
       );
CREATE TABLE memory_retrieval_candidates (
         trajectory_id UUID NOT NULL REFERENCES memory_retrieval_trajectories(trajectory_id) ON DELETE CASCADE,
         installation_id UUID NOT NULL,
         version_id UUID NOT NULL,
         metadata_rank INTEGER,
         lexical_rank INTEGER,
         vector_rank INTEGER,
         fused_score REAL NOT NULL,
         authority_score REAL NOT NULL DEFAULT 0,
         freshness_score REAL NOT NULL DEFAULT 0,
         scope_score REAL NOT NULL DEFAULT 0,
         loadout_score REAL NOT NULL DEFAULT 0,
         estimated_tokens INTEGER NOT NULL DEFAULT 0,
         decision TEXT NOT NULL CHECK (decision IN ('selected','dropped','pruned','excluded','shadowed')),
         reason_code TEXT NOT NULL,
         final_ordinal INTEGER,
         PRIMARY KEY (trajectory_id, version_id),
         FOREIGN KEY (installation_id, version_id)
           REFERENCES knowledge_versions(installation_id, version_id) ON DELETE CASCADE
       );
CREATE TABLE memory_context_packs (
         pack_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         generation_run_id UUID UNIQUE REFERENCES memory_generation_runs(run_id) ON DELETE SET NULL,
         session_id TEXT NOT NULL,
         client_request_id TEXT NOT NULL,
         agent TEXT NOT NULL,
         mode TEXT NOT NULL CHECK (mode IN ('shadow','enabled')),
         effective_policy_hash BYTEA NOT NULL,
         input_digest BYTEA NOT NULL,
         policy_revision BIGINT NOT NULL DEFAULT 1,
         settings_revision BIGINT NOT NULL DEFAULT 1,
         loadout_revision BIGINT NOT NULL DEFAULT 1,
         stable_text TEXT NOT NULL DEFAULT '',
         dynamic_text TEXT NOT NULL DEFAULT '',
         stable_hash BYTEA,
         dynamic_hash BYTEA,
         stable_tokens INTEGER NOT NULL DEFAULT 0,
         dynamic_tokens INTEGER NOT NULL DEFAULT 0,
         stable_cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
         state TEXT NOT NULL CHECK (state IN
           ('compiling','ready','shadow','empty','failed','invalidated')),
         error_code TEXT,
         generated_at TIMESTAMPTZ,
         invalidated_at TIMESTAMPTZ,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
CREATE UNIQUE INDEX uq_context_packs_active
         ON memory_context_packs
           (installation_id, session_id, client_request_id, effective_policy_hash, input_digest)
         WHERE state <> 'invalidated';
CREATE TABLE memory_context_pack_items (
         pack_id UUID NOT NULL REFERENCES memory_context_packs(pack_id) ON DELETE CASCADE,
         item_id UUID NOT NULL,
         installation_id UUID NOT NULL,
         claim_id UUID NOT NULL,
         version_id UUID NOT NULL,
         claim_type TEXT NOT NULL,
         layer TEXT NOT NULL CHECK (layer IN ('L2','L3')),
         section TEXT NOT NULL CHECK (section IN ('stable','dynamic')),
         representation TEXT NOT NULL CHECK (representation IN ('summary','on_demand','reference')),
         rendered_text TEXT NOT NULL,
         reason_codes TEXT[] NOT NULL DEFAULT '{}',
         token_count INTEGER NOT NULL DEFAULT 0,
         ordinal SMALLINT NOT NULL,
         PRIMARY KEY (pack_id, item_id),
         FOREIGN KEY (installation_id, claim_id)
           REFERENCES knowledge_claims(installation_id, claim_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, version_id)
           REFERENCES knowledge_versions(installation_id, version_id) ON DELETE CASCADE
       );
CREATE TABLE memory_context_pack_evidence (
         pack_id UUID NOT NULL,
         item_id UUID NOT NULL,
         installation_id UUID NOT NULL,
         evidence_id UUID NOT NULL,
         occurred_at TIMESTAMPTZ,
         PRIMARY KEY (pack_id, item_id, evidence_id),
         FOREIGN KEY (pack_id, item_id)
           REFERENCES memory_context_pack_items(pack_id, item_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, evidence_id)
           REFERENCES knowledge_evidence(installation_id, evidence_id) ON DELETE CASCADE
       );
CREATE TABLE memory_context_injections (
         injection_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         pack_id UUID NOT NULL REFERENCES memory_context_packs(pack_id) ON DELETE CASCADE,
         session_id TEXT NOT NULL,
         client_request_id TEXT NOT NULL,
         agent TEXT NOT NULL,
         adapter TEXT NOT NULL,
         adapter_version TEXT,
         admission_nonce_hmac BYTEA NOT NULL,
         state TEXT NOT NULL CHECK (state IN
           ('prepared','admitted','delivered','skipped','delivery_failed','expired')),
         outcome_code TEXT,
         admitted_at TIMESTAMPTZ,
         admission_expires_at TIMESTAMPTZ,
         delivered_at TIMESTAMPTZ,
         usage_input_tokens BIGINT NOT NULL DEFAULT 0,
         usage_output_tokens BIGINT NOT NULL DEFAULT 0,
         usage_cached_tokens BIGINT NOT NULL DEFAULT 0,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, session_id, client_request_id, pack_id)
       );
CREATE UNIQUE INDEX uq_context_admission_active
         ON memory_context_injections(installation_id, session_id, client_request_id)
         WHERE state IN ('prepared','admitted');
CREATE TABLE memory_context_feedback (
         feedback_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         injection_id UUID REFERENCES memory_context_injections(injection_id) ON DELETE CASCADE,
         pack_id UUID REFERENCES memory_context_packs(pack_id) ON DELETE CASCADE,
         item_id UUID,
         actor TEXT NOT NULL CHECK (actor IN ('user','agent')),
         action TEXT NOT NULL CHECK (action IN ('used','ignored','incorrect','harmful')),
         reason_code TEXT,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         CHECK (injection_id IS NOT NULL OR pack_id IS NOT NULL)
       );
INSERT INTO memory_schema_migrations(version) VALUES (13);
COMMIT;

BEGIN;
ALTER TABLE memory_extraction_runs
         ADD COLUMN IF NOT EXISTS effective_policy_hash BYTEA
         NOT NULL DEFAULT decode(md5('phase1:no-policy'), 'hex');
ALTER TABLE memory_extraction_runs
         DROP CONSTRAINT IF EXISTS
         memory_extraction_runs_installation_id_episode_id_episode_s_key;
ALTER TABLE memory_extraction_runs
         ADD CONSTRAINT memory_extraction_runs_policy_bound_key
         UNIQUE (installation_id, episode_id, episode_source_digest,
                 extractor_version, model_config_hash, effective_policy_hash);
INSERT INTO memory_schema_migrations(version) VALUES (14);
COMMIT;

BEGIN;
ALTER TABLE memory_context_packs
         ADD COLUMN IF NOT EXISTS repository_id UUID;
ALTER TABLE memory_context_packs
         ADD COLUMN IF NOT EXISTS settings_fingerprint BYTEA;
ALTER TABLE memory_context_packs
         ADD COLUMN IF NOT EXISTS loadout_fingerprint BYTEA;
ALTER TABLE memory_context_packs
         ADD CONSTRAINT memory_context_packs_repository_fk
         FOREIGN KEY (installation_id, repository_id)
         REFERENCES repositories(installation_id, repository_id);
INSERT INTO memory_schema_migrations(version) VALUES (15);
COMMIT;

BEGIN;
ALTER TABLE memory_context_packs
         ADD COLUMN IF NOT EXISTS trajectory_id UUID
         REFERENCES memory_retrieval_trajectories(trajectory_id) ON DELETE SET NULL;
INSERT INTO memory_schema_migrations(version) VALUES (16);
COMMIT;

BEGIN;
CREATE INDEX IF NOT EXISTS knowledge_claims_active_installation_idx
         ON knowledge_claims (installation_id, claim_id)
         WHERE state = 'active';
CREATE INDEX IF NOT EXISTS knowledge_versions_applicability_idx
         ON knowledge_versions (installation_id, claim_id, created_at);
CREATE INDEX IF NOT EXISTS knowledge_evidence_installation_version_idx
         ON knowledge_evidence (installation_id, version_id);
INSERT INTO memory_schema_migrations(version) VALUES (17);
COMMIT;

BEGIN;
INSERT INTO memory_jobs
         (job_id, installation_id, job_type, idempotency_key, priority, payload)
       SELECT gen_random_uuid(), w.installation_id, 'compile_episode',
              'compile_episode:' || w.turn_id, 80, '{}'::jsonb
       FROM work_episodes w
       WHERE w.repository_id IS NULL
         AND w.state = 'ready'
         AND w.terminal_at IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM source_events e
           JOIN repositories r
             ON r.installation_id = e.installation_id
            AND r.repository_key = e.payload->>'repository_id'
           WHERE e.installation_id = w.installation_id
             AND e.session_id = w.session_id
             AND e.turn_id IS NULL
             AND e.event_type IN ('session_created', 'session_discovered')
             AND e.payload->>'repository_id' IS NOT NULL
             AND e.occurred_at <= w.terminal_at
         )
       ON CONFLICT (installation_id, job_type, idempotency_key) DO UPDATE SET
         state = 'pending',
         attempts = 0,
         available_at = NOW(),
         claimed_by = NULL,
         claim_expires_at = NULL,
         last_error_code = NULL,
         completed_at = NULL
       WHERE memory_jobs.state IN ('completed', 'dead');
INSERT INTO memory_schema_migrations(version) VALUES (18);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS memory_owner_scopes (
         installation_id     UUID PRIMARY KEY REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         owner_scope_kind    TEXT NOT NULL CHECK (owner_scope_kind IN ('personal', 'team', 'organization')),
         owner_scope_id      UUID NOT NULL,
         parent_organization_id UUID,
         state               TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'dissolving', 'dissolved')),
         authorization_epoch BIGINT NOT NULL DEFAULT 1 CHECK (authorization_epoch > 0),
         last_feed_id        BIGINT NOT NULL DEFAULT 0,
         updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
CREATE UNIQUE INDEX IF NOT EXISTS memory_owner_scopes_shared_scope_idx
         ON memory_owner_scopes (owner_scope_kind, owner_scope_id)
         WHERE owner_scope_kind IN ('team', 'organization');
CREATE TABLE IF NOT EXISTS memory_scope_memberships (
         installation_id     UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         membership_id       UUID NOT NULL,
         roles               TEXT[] NOT NULL DEFAULT '{}',
         state               TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('invited', 'active', 'suspended', 'revoked')),
         membership_revision BIGINT NOT NULL DEFAULT 1 CHECK (membership_revision > 0),
         valid_from          TIMESTAMPTZ,
         valid_until         TIMESTAMPTZ,
         last_feed_id        BIGINT NOT NULL DEFAULT 0,
         updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, membership_id)
       );
CREATE TABLE IF NOT EXISTS memory_scope_tombstones (
         owner_scope_kind    TEXT NOT NULL CHECK (owner_scope_kind IN ('team', 'organization')),
         owner_scope_id      UUID NOT NULL,
         authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch > 0),
         reason              TEXT NOT NULL,
         tombstoned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (owner_scope_kind, owner_scope_id)
       );
INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id)
       SELECT installation_id, 'personal', installation_id FROM memory_installations
       ON CONFLICT (installation_id) DO NOTHING;
INSERT INTO memory_schema_migrations(version) VALUES (19);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS memory_review_policy_sets (
         policy_id          UUID PRIMARY KEY,
         installation_id    UUID NOT NULL UNIQUE REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
CREATE TABLE IF NOT EXISTS memory_review_policy_versions (
         policy_version_id  UUID PRIMARY KEY,
         policy_id          UUID NOT NULL REFERENCES memory_review_policy_sets(policy_id) ON DELETE CASCADE,
         version_number     BIGINT NOT NULL CHECK (version_number > 0),
         document           JSONB NOT NULL,
         content_hash       TEXT NOT NULL,
         created_by_membership_id UUID,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (policy_id, version_number)
       );
CREATE TABLE IF NOT EXISTS memory_review_policy_heads (
         policy_id          UUID PRIMARY KEY REFERENCES memory_review_policy_sets(policy_id) ON DELETE CASCADE,
         active_version_id  UUID NOT NULL REFERENCES memory_review_policy_versions(policy_version_id),
         revision           BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
CREATE TABLE IF NOT EXISTS memory_promotion_candidates (
         candidate_id       UUID PRIMARY KEY,
         target_installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         source_installation_id UUID NOT NULL,
         source_scope_kind  TEXT NOT NULL CHECK (source_scope_kind IN ('personal', 'team')),
         source_claim_id    UUID NOT NULL,
         source_version_id  UUID NOT NULL,
         source_content_hash TEXT NOT NULL,
         target_claim_type  TEXT NOT NULL,
         scope_kind         TEXT NOT NULL DEFAULT 'installation'
                            CHECK (scope_kind IN ('installation','repository','snapshot','branch','task')),
         scope_key          TEXT NOT NULL DEFAULT '',
         normalized_key     TEXT NOT NULL,
         state              TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN
                            ('proposed','changes_requested','approved','rejected','withdrawn','expired','conflict','published')),
         conflict_group_id  UUID,
         duplicate_of_claim_id UUID,
         expires_at         TIMESTAMPTZ NOT NULL,
         revision           BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         created_by_membership_id UUID,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (target_installation_id, candidate_id),
         CHECK (source_installation_id <> target_installation_id)
       );
CREATE INDEX IF NOT EXISTS memory_promotion_candidates_target_state_idx
         ON memory_promotion_candidates (target_installation_id, state, created_at);
CREATE TABLE IF NOT EXISTS memory_promotion_candidate_versions (
         candidate_revision_id UUID PRIMARY KEY,
         candidate_id       UUID NOT NULL REFERENCES memory_promotion_candidates(candidate_id) ON DELETE CASCADE,
         revision_number    BIGINT NOT NULL CHECK (revision_number > 0),
         statement          TEXT NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 4000),
         structured_content JSONB NOT NULL DEFAULT '{}'::jsonb,
         content_hash       TEXT NOT NULL,
         review_policy_version_id UUID NOT NULL REFERENCES memory_review_policy_versions(policy_version_id),
         created_by_membership_id UUID,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (candidate_id, revision_number)
       );
CREATE TABLE IF NOT EXISTS memory_promotion_evidence (
         candidate_revision_id UUID NOT NULL REFERENCES memory_promotion_candidate_versions(candidate_revision_id) ON DELETE CASCADE,
         ordinal            INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
         evidence_kind      TEXT NOT NULL,
         excerpt            TEXT NOT NULL CHECK (char_length(excerpt) BETWEEN 1 AND 4000),
         excerpt_hash       TEXT NOT NULL,
         sanitized_locator  TEXT,
         source_evidence_hash TEXT NOT NULL,
         occurred_at        TIMESTAMPTZ,
         PRIMARY KEY (candidate_revision_id, ordinal)
       );
CREATE TABLE IF NOT EXISTS memory_review_decisions (
         decision_id        UUID PRIMARY KEY,
         candidate_revision_id UUID NOT NULL REFERENCES memory_promotion_candidate_versions(candidate_revision_id) ON DELETE CASCADE,
         membership_id      UUID NOT NULL,
         membership_revision BIGINT NOT NULL CHECK (membership_revision > 0),
         decision           TEXT NOT NULL CHECK (decision IN ('approve','request_changes','reject')),
         reason_code        TEXT,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (candidate_revision_id, membership_id)
       );
CREATE TABLE IF NOT EXISTS memory_authority_records (
         authority_id       UUID PRIMARY KEY,
         installation_id    UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         version_id         UUID NOT NULL,
         candidate_revision_id UUID NOT NULL,
         review_policy_version_id UUID NOT NULL REFERENCES memory_review_policy_versions(policy_version_id),
         counted_decision_ids UUID[] NOT NULL,
         publisher_membership_id UUID,
         source_scope_kind  TEXT NOT NULL,
         source_content_hash TEXT NOT NULL,
         published_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, version_id)
       );
CREATE TABLE IF NOT EXISTS memory_governance_events (
         event_id           UUID PRIMARY KEY,
         installation_id    UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         actor_membership_id UUID,
         action             TEXT NOT NULL,
         target_kind        TEXT NOT NULL,
         target_id          UUID,
         request_hash       TEXT,
         previous_state     TEXT,
         next_state         TEXT,
         metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
CREATE INDEX IF NOT EXISTS memory_governance_events_page_idx
         ON memory_governance_events (installation_id, created_at DESC, event_id);
CREATE TABLE IF NOT EXISTS memory_transfer_runs (
         transfer_id        UUID PRIMARY KEY,
         source_installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         target_installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         state              TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed','failed')),
         source_revision    BIGINT,
         created_by_membership_id UUID,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         completed_at       TIMESTAMPTZ,
         CHECK (source_installation_id <> target_installation_id)
       );
ALTER TABLE knowledge_claims
         ADD COLUMN IF NOT EXISTS owner_scope_kind TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE knowledge_claims
         ADD COLUMN IF NOT EXISTS owner_scope_id UUID;
ALTER TABLE knowledge_claims
         ADD COLUMN IF NOT EXISTS conflict_group_id UUID;
ALTER TABLE knowledge_claims
         ADD COLUMN IF NOT EXISTS conflict_variant INTEGER NOT NULL DEFAULT 0;
UPDATE knowledge_claims SET owner_scope_id = installation_id WHERE owner_scope_id IS NULL;
CREATE OR REPLACE FUNCTION knowledge_claim_personal_scope() RETURNS trigger AS $fn$
         BEGIN
           IF NEW.owner_scope_kind = 'personal' AND NEW.owner_scope_id IS NULL THEN
             NEW.owner_scope_id := NEW.installation_id;
           END IF;
           RETURN NEW;
         END;
         $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_knowledge_claims_owner_scope ON knowledge_claims;
CREATE TRIGGER trg_knowledge_claims_owner_scope
         BEFORE INSERT OR UPDATE ON knowledge_claims
         FOR EACH ROW EXECUTE FUNCTION knowledge_claim_personal_scope();
ALTER TABLE knowledge_versions
         ADD COLUMN IF NOT EXISTS source_promotion_candidate_id UUID;
ALTER TABLE knowledge_evidence
         ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE knowledge_evidence DROP CONSTRAINT IF EXISTS knowledge_evidence_visibility_check;
ALTER TABLE knowledge_evidence
         ADD CONSTRAINT knowledge_evidence_visibility_check CHECK (visibility IN ('personal','shared'));
ALTER TABLE knowledge_evidence
         ADD COLUMN IF NOT EXISTS source_evidence_hash TEXT;
ALTER TABLE knowledge_evidence
         ADD COLUMN IF NOT EXISTS contributor_membership_id UUID;
ALTER TABLE knowledge_versions DROP CONSTRAINT IF EXISTS knowledge_versions_authority_check;
ALTER TABLE knowledge_versions
         ADD CONSTRAINT knowledge_versions_authority_check CHECK (authority IN
           ('user_accepted','user_corrected','team_reviewed','team_published',
            'organization_reviewed','organization_published'));
ALTER TABLE memory_jobs DROP CONSTRAINT IF EXISTS memory_jobs_job_type_check;
ALTER TABLE memory_jobs
         ADD CONSTRAINT memory_jobs_job_type_check CHECK (job_type IN
           ('project_feed','compile_episode','snapshot_reconcile','session_purge',
            'installation_purge','report_status','report_usage',
            'extract_candidates','index_claim_version','rebuild_claim_index',
            'expire_claims','recompile_extraction_policy',
            'compile_context_shadow','record_context_delivery','invalidate_context_packs',
            'expire_promotion_candidates','index_shared_claim',
            'invalidate_scope_authorization','transfer_scope_claims'));
INSERT INTO memory_schema_migrations(version) VALUES (20);
COMMIT;

BEGIN;
ALTER TABLE knowledge_claims
         DROP CONSTRAINT IF EXISTS uq_knowledge_claims_installation_claim;
ALTER TABLE knowledge_claims
         DROP CONSTRAINT IF EXISTS knowledge_claims_installation_id_claim_type_scope_key_norma_key;
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_claims_active_identity_variant_idx
         ON knowledge_claims (installation_id, claim_type, scope_key, normalized_key, conflict_variant)
         WHERE state = 'active';
CREATE INDEX IF NOT EXISTS knowledge_claims_conflict_group_idx
         ON knowledge_claims (installation_id, conflict_group_id)
         WHERE conflict_group_id IS NOT NULL;
INSERT INTO memory_schema_migrations(version) VALUES (21);
COMMIT;

BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS memory_transfer_runs_source_once_idx
         ON memory_transfer_runs (source_installation_id);
INSERT INTO memory_schema_migrations(version) VALUES (22);
COMMIT;

BEGIN;
ALTER TABLE memory_promotion_candidate_versions
         ADD COLUMN IF NOT EXISTS parent_review_policy_version_id UUID
         REFERENCES memory_review_policy_versions(policy_version_id) ON DELETE RESTRICT;
ALTER TABLE memory_authority_records
         ADD COLUMN IF NOT EXISTS parent_review_policy_version_id UUID
         REFERENCES memory_review_policy_versions(policy_version_id) ON DELETE RESTRICT;
INSERT INTO memory_schema_migrations(version) VALUES (23);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS memory_provider_budget_reservations (
         reservation_id       UUID PRIMARY KEY,
         budget_key           TEXT NOT NULL CHECK (char_length(budget_key) BETWEEN 1 AND 128),
         provider_kind        TEXT NOT NULL CHECK (provider_kind IN ('text', 'embedding')),
         state                TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled')),
         reserved_input_tokens BIGINT NOT NULL CHECK (reserved_input_tokens >= 0),
         reserved_output_tokens BIGINT NOT NULL CHECK (reserved_output_tokens >= 0),
         actual_input_tokens  BIGINT NOT NULL DEFAULT 0 CHECK (actual_input_tokens >= 0),
         actual_output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (actual_output_tokens >= 0),
         created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         settled_at           TIMESTAMPTZ
       );
CREATE INDEX IF NOT EXISTS memory_provider_budget_reservations_key_kind_idx
         ON memory_provider_budget_reservations (budget_key, provider_kind);
INSERT INTO memory_schema_migrations(version) VALUES (24);
COMMIT;

BEGIN;
DO $$
       BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'repositories_installation_repository_uni'
             AND conrelid = 'repositories'::regclass
         ) THEN
           ALTER TABLE repositories
             ADD CONSTRAINT repositories_installation_repository_uni
             UNIQUE (installation_id, repository_id);
         END IF;
       END $$;
CREATE TABLE IF NOT EXISTS memory_source_snapshots (
         snapshot_id          UUID PRIMARY KEY,
         installation_id      UUID NOT NULL,
         repository_id        UUID NOT NULL,
         commit_sha           TEXT NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}$' OR commit_sha ~ '^[0-9a-f]{64}$'),
         git_object_format    TEXT NOT NULL CHECK (git_object_format IN ('sha1','sha256')),
         manifest_hash        TEXT NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
         state                TEXT NOT NULL DEFAULT 'staging' CHECK (state IN
                              ('staging','ready','parsing','active','superseded','failed','purged')),
         generation           BIGINT NOT NULL CHECK (generation >= 0),
         parser_matrix_version TEXT NOT NULL,
         file_count           BIGINT NOT NULL CHECK (file_count >= 0),
         byte_count           BIGINT NOT NULL CHECK (byte_count >= 0),
         created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         completed_at         TIMESTAMPTZ,
         UNIQUE (installation_id, snapshot_id),
         UNIQUE (installation_id, repository_id, commit_sha, manifest_hash),
         FOREIGN KEY (installation_id, repository_id)
           REFERENCES repositories (installation_id, repository_id) ON DELETE CASCADE
       );
CREATE INDEX IF NOT EXISTS memory_source_snapshots_repo_state_idx
         ON memory_source_snapshots (installation_id, repository_id, state);
CREATE TABLE IF NOT EXISTS memory_source_blobs (
         installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         blob_hash        TEXT NOT NULL CHECK (blob_hash ~ '^[0-9a-f]{64}$'),
         byte_count       BIGINT NOT NULL CHECK (byte_count >= 0),
         utf8_content     TEXT NOT NULL,
         created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, blob_hash)
       );
CREATE TABLE IF NOT EXISTS memory_source_snapshot_entries (
         snapshot_id      UUID NOT NULL,
         installation_id  UUID NOT NULL,
         path             TEXT NOT NULL CHECK (
                            path <> '' AND char_length(path) <= 1024
                            AND path NOT LIKE '/%'
                            AND path NOT LIKE '%//%'
                            AND path NOT LIKE '%.git/%'
                            AND NOT (string_to_array(path, '/') && ARRAY['.', '..'])),
         blob_hash        TEXT NOT NULL,
         language         TEXT NOT NULL,
         capability       TEXT NOT NULL CHECK (capability IN ('symbols_and_edges','file_only')),
         byte_count       BIGINT NOT NULL CHECK (byte_count >= 0),
         mode             TEXT NOT NULL CHECK (mode IN ('100644','100755')),
         PRIMARY KEY (snapshot_id, path),
         FOREIGN KEY (installation_id, snapshot_id)
           REFERENCES memory_source_snapshots (installation_id, snapshot_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, blob_hash)
           REFERENCES memory_source_blobs (installation_id, blob_hash) ON DELETE RESTRICT
       );
CREATE INDEX IF NOT EXISTS memory_source_snapshot_entries_blob_idx
         ON memory_source_snapshot_entries (installation_id, blob_hash);
CREATE TABLE IF NOT EXISTS memory_source_snapshot_tombstones (
         installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         snapshot_id      UUID NOT NULL,
         repository_id    UUID NOT NULL,
         commit_sha       TEXT NOT NULL,
         reason_code      TEXT NOT NULL,
         tombstoned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, snapshot_id)
       );
CREATE TABLE IF NOT EXISTS memory_repository_tombstones (
         installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         repository_id    UUID NOT NULL,
         reason_code      TEXT NOT NULL,
         tombstoned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, repository_id)
       );
INSERT INTO memory_schema_migrations(version) VALUES (25);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS memory_code_graph_versions (
         graph_version_id  UUID PRIMARY KEY,
         installation_id   UUID NOT NULL,
         repository_id     UUID NOT NULL,
         snapshot_id       UUID NOT NULL,
         generation        BIGINT NOT NULL CHECK (generation >= 1),
         parser_version    TEXT NOT NULL,
         state             TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN
                           ('candidate','active','superseded','failed','purged')),
         coverage          TEXT NOT NULL CHECK (coverage IN
                           ('complete','partial','unsupported','degraded')),
         content_hash      TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
         created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         activated_at      TIMESTAMPTZ,
         UNIQUE (installation_id, graph_version_id),
         UNIQUE (installation_id, snapshot_id, parser_version, generation),
         FOREIGN KEY (installation_id, repository_id)
           REFERENCES repositories (installation_id, repository_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, snapshot_id)
           REFERENCES memory_source_snapshots (installation_id, snapshot_id) ON DELETE CASCADE
       );
CREATE INDEX IF NOT EXISTS memory_code_graph_versions_repo_state_idx
         ON memory_code_graph_versions (installation_id, repository_id, state);
CREATE TABLE IF NOT EXISTS memory_code_graph_heads (
         installation_id         UUID NOT NULL,
         repository_id           UUID NOT NULL,
         active_graph_version_id UUID NOT NULL,
         revision                BIGINT NOT NULL CHECK (revision >= 1),
         updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, repository_id),
         FOREIGN KEY (installation_id, repository_id)
           REFERENCES repositories (installation_id, repository_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, active_graph_version_id)
           REFERENCES memory_code_graph_versions (installation_id, graph_version_id) ON DELETE CASCADE
       );
CREATE TABLE IF NOT EXISTS memory_code_nodes (
         graph_version_id UUID NOT NULL,
         installation_id  UUID NOT NULL,
         node_id          UUID NOT NULL,
         kind             TEXT NOT NULL CHECK (kind IN
                          ('repository','file','symbol','external_package')),
         stable_key       TEXT NOT NULL,
         path             TEXT,
         name             TEXT NOT NULL,
         symbol_kind      TEXT,
         start_line       INTEGER CHECK (start_line IS NULL OR start_line >= 1),
         start_column     INTEGER CHECK (start_column IS NULL OR start_column >= 1),
         end_line         INTEGER CHECK (end_line IS NULL OR end_line >= 1),
         end_column       INTEGER CHECK (end_column IS NULL OR end_column >= 1),
         signature_hash   TEXT,
         metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
         PRIMARY KEY (graph_version_id, node_id),
         UNIQUE (graph_version_id, stable_key),
         FOREIGN KEY (installation_id, graph_version_id)
           REFERENCES memory_code_graph_versions (installation_id, graph_version_id) ON DELETE CASCADE
       );
CREATE INDEX IF NOT EXISTS memory_code_nodes_path_idx
         ON memory_code_nodes (graph_version_id, path);
CREATE TABLE IF NOT EXISTS memory_code_edges (
         graph_version_id UUID NOT NULL,
         installation_id  UUID NOT NULL,
         edge_id          UUID NOT NULL,
         kind             TEXT NOT NULL CHECK (kind IN
                          ('definition','reference','import','call','dependency','test')),
         from_node_id     UUID NOT NULL,
         to_node_id       UUID NOT NULL,
         source_path      TEXT NOT NULL,
         source_line      INTEGER CHECK (source_line IS NULL OR source_line >= 1),
         resolution       TEXT NOT NULL CHECK (resolution IN ('resolved','unresolved','dynamic')),
         metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
         PRIMARY KEY (graph_version_id, edge_id),
         FOREIGN KEY (installation_id, graph_version_id)
           REFERENCES memory_code_graph_versions (installation_id, graph_version_id) ON DELETE CASCADE,
         FOREIGN KEY (graph_version_id, from_node_id)
           REFERENCES memory_code_nodes (graph_version_id, node_id) ON DELETE CASCADE,
         FOREIGN KEY (graph_version_id, to_node_id)
           REFERENCES memory_code_nodes (graph_version_id, node_id) ON DELETE CASCADE
       );
CREATE INDEX IF NOT EXISTS memory_code_edges_from_idx
         ON memory_code_edges (graph_version_id, from_node_id, kind);
CREATE INDEX IF NOT EXISTS memory_code_edges_to_idx
         ON memory_code_edges (graph_version_id, to_node_id, kind);
INSERT INTO memory_schema_migrations(version) VALUES (26);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS memory_wikis (
         wiki_id         UUID PRIMARY KEY,
         installation_id UUID NOT NULL,
         repository_id   UUID NOT NULL,
         generation      BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
         created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, wiki_id),
         UNIQUE (installation_id, repository_id),
         FOREIGN KEY (installation_id, repository_id)
           REFERENCES repositories (installation_id, repository_id) ON DELETE CASCADE
       );
CREATE TABLE IF NOT EXISTS memory_wiki_build_runs (
         run_id             UUID PRIMARY KEY,
         installation_id    UUID NOT NULL,
         wiki_id            UUID NOT NULL,
         generation         BIGINT NOT NULL CHECK (generation >= 1),
         source_snapshot_id UUID NOT NULL,
         graph_version_id   UUID,
         state              TEXT NOT NULL CHECK (state IN
                            ('queued','running','validating','candidate','published',
                             'failed','superseded','cancelled','stale_generation')),
         input_digest       TEXT NOT NULL,
         prompt_version     TEXT,
         model_version      TEXT,
         policy_version     TEXT,
         parser_version     TEXT,
         budget_reservation_id UUID,
         error_code         TEXT,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         started_at         TIMESTAMPTZ,
         completed_at       TIMESTAMPTZ,
         UNIQUE (installation_id, run_id),
         UNIQUE (installation_id, wiki_id, generation),
         FOREIGN KEY (installation_id, wiki_id)
           REFERENCES memory_wikis (installation_id, wiki_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, source_snapshot_id)
           REFERENCES memory_source_snapshots (installation_id, snapshot_id) ON DELETE CASCADE
       );
CREATE UNIQUE INDEX IF NOT EXISTS memory_wiki_build_runs_one_active_idx
         ON memory_wiki_build_runs (wiki_id)
         WHERE state IN ('queued','running','validating');
CREATE TABLE IF NOT EXISTS memory_wiki_versions (
         wiki_version_id    UUID PRIMARY KEY,
         installation_id    UUID NOT NULL,
         wiki_id            UUID NOT NULL,
         revision           BIGINT NOT NULL CHECK (revision >= 1),
         source_snapshot_id UUID NOT NULL,
         graph_version_id   UUID NOT NULL,
         build_run_id       UUID,
         state              TEXT NOT NULL DEFAULT 'active' CHECK (state IN
                            ('active','superseded','purged')),
         content_hash       TEXT NOT NULL,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, wiki_version_id),
         UNIQUE (installation_id, wiki_id, revision),
         FOREIGN KEY (installation_id, wiki_id)
           REFERENCES memory_wikis (installation_id, wiki_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, source_snapshot_id)
           REFERENCES memory_source_snapshots (installation_id, snapshot_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, graph_version_id)
           REFERENCES memory_code_graph_versions (installation_id, graph_version_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, build_run_id)
           REFERENCES memory_wiki_build_runs (installation_id, run_id) ON DELETE SET NULL
       );
CREATE UNIQUE INDEX IF NOT EXISTS memory_wiki_versions_one_active_idx
         ON memory_wiki_versions (installation_id, wiki_id)
         WHERE state = 'active';
CREATE TABLE IF NOT EXISTS memory_wiki_heads (
         installation_id UUID NOT NULL,
         repository_id   UUID NOT NULL,
         wiki_id         UUID NOT NULL,
         active_version_id UUID NOT NULL,
         revision        BIGINT NOT NULL CHECK (revision >= 1),
         updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, repository_id),
         FOREIGN KEY (installation_id, repository_id)
           REFERENCES repositories (installation_id, repository_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, wiki_id)
           REFERENCES memory_wikis (installation_id, wiki_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, active_version_id)
           REFERENCES memory_wiki_versions (installation_id, wiki_version_id) ON DELETE CASCADE
       );
CREATE TABLE IF NOT EXISTS memory_wiki_pages (
         wiki_version_id UUID NOT NULL,
         installation_id UUID NOT NULL,
         page_id         UUID NOT NULL,
         page_key        TEXT NOT NULL CHECK (page_key <> '' AND char_length(page_key) <= 128),
         title           TEXT NOT NULL CHECK (char_length(title) <= 200),
         position        INTEGER NOT NULL CHECK (position >= 0),
         PRIMARY KEY (wiki_version_id, page_id),
         UNIQUE (wiki_version_id, page_key),
         FOREIGN KEY (installation_id, wiki_version_id)
           REFERENCES memory_wiki_versions (installation_id, wiki_version_id) ON DELETE CASCADE
       );
CREATE TABLE IF NOT EXISTS memory_wiki_sections (
         wiki_version_id UUID NOT NULL,
         installation_id UUID NOT NULL,
         section_id      UUID NOT NULL,
         page_id         UUID NOT NULL,
         section_key     TEXT NOT NULL CHECK (section_key <> '' AND char_length(section_key) <= 128),
         heading         TEXT NOT NULL CHECK (char_length(heading) <= 200),
         markdown        TEXT NOT NULL,
         authority       TEXT NOT NULL CHECK (authority IN ('generated','manual','locked')),
         coverage        TEXT NOT NULL CHECK (coverage IN
                         ('complete','partial','unsupported','degraded')),
         position        INTEGER NOT NULL CHECK (position >= 0),
         PRIMARY KEY (wiki_version_id, section_id),
         UNIQUE (wiki_version_id, page_id, section_key),
         FOREIGN KEY (installation_id, wiki_version_id)
           REFERENCES memory_wiki_versions (installation_id, wiki_version_id) ON DELETE CASCADE,
         FOREIGN KEY (wiki_version_id, page_id)
           REFERENCES memory_wiki_pages (wiki_version_id, page_id) ON DELETE CASCADE
       );
CREATE INDEX IF NOT EXISTS memory_wiki_sections_key_idx
         ON memory_wiki_sections (wiki_version_id, section_key);
CREATE TABLE IF NOT EXISTS memory_wiki_source_bindings (
         wiki_version_id    UUID NOT NULL,
         installation_id    UUID NOT NULL,
         section_id         UUID NOT NULL,
         binding_id         UUID NOT NULL,
         source_kind        TEXT NOT NULL CHECK (source_kind IN
                            ('file','symbol','claim_version','evidence')),
         source_token       TEXT NOT NULL,
         source_snapshot_id UUID,
         commit_sha         TEXT,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (wiki_version_id, binding_id),
         FOREIGN KEY (installation_id, wiki_version_id)
           REFERENCES memory_wiki_versions (installation_id, wiki_version_id) ON DELETE CASCADE,
         FOREIGN KEY (wiki_version_id, section_id)
           REFERENCES memory_wiki_sections (wiki_version_id, section_id) ON DELETE CASCADE
       );
CREATE INDEX IF NOT EXISTS memory_wiki_source_bindings_section_idx
         ON memory_wiki_source_bindings (wiki_version_id, section_id);
CREATE TABLE IF NOT EXISTS memory_wiki_manual_section_versions (
         manual_version_id  UUID PRIMARY KEY,
         installation_id    UUID NOT NULL,
         wiki_id            UUID NOT NULL,
         section_key        TEXT NOT NULL,
         markdown           TEXT NOT NULL,
         content_hash       TEXT NOT NULL,
         actor_scope_kind   TEXT NOT NULL,
         actor_scope_id     TEXT NOT NULL,
         reason_code        TEXT,
         previous_version_id UUID,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, manual_version_id),
         FOREIGN KEY (installation_id, wiki_id)
           REFERENCES memory_wikis (installation_id, wiki_id) ON DELETE CASCADE
       );
CREATE TABLE IF NOT EXISTS memory_wiki_manual_section_heads (
         installation_id  UUID NOT NULL,
         wiki_id          UUID NOT NULL,
         section_key      TEXT NOT NULL,
         current_version_id UUID NOT NULL,
         locked           BOOLEAN NOT NULL DEFAULT FALSE,
         lock_version     BIGINT NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
         updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, wiki_id, section_key),
         FOREIGN KEY (installation_id, wiki_id)
           REFERENCES memory_wikis (installation_id, wiki_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, current_version_id)
           REFERENCES memory_wiki_manual_section_versions (installation_id, manual_version_id) ON DELETE CASCADE
       );
CREATE TABLE IF NOT EXISTS memory_wiki_stale_marks (
         installation_id   UUID NOT NULL,
         wiki_id           UUID NOT NULL,
         section_key       TEXT NOT NULL,
         reason            TEXT NOT NULL,
         source_snapshot_id UUID,
         graph_version_id  UUID,
         marked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         cleared_at        TIMESTAMPTZ,
         PRIMARY KEY (installation_id, wiki_id, section_key),
         FOREIGN KEY (installation_id, wiki_id)
           REFERENCES memory_wikis (installation_id, wiki_id) ON DELETE CASCADE
       );
CREATE TABLE IF NOT EXISTS memory_wiki_audit_events (
         audit_id         UUID PRIMARY KEY,
         installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         wiki_id          UUID NOT NULL,
         action           TEXT NOT NULL,
         result           TEXT NOT NULL,
         reason_code      TEXT,
         old_content_hash TEXT,
         new_content_hash TEXT,
         actor_scope_kind TEXT NOT NULL,
         actor_scope_id   TEXT NOT NULL,
         head_revision    BIGINT,
         created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         FOREIGN KEY (installation_id, wiki_id)
           REFERENCES memory_wikis (installation_id, wiki_id) ON DELETE CASCADE
       );
CREATE INDEX IF NOT EXISTS memory_wiki_audit_events_wiki_idx
         ON memory_wiki_audit_events (installation_id, wiki_id, created_at);
INSERT INTO memory_schema_migrations(version) VALUES (27);
COMMIT;

BEGIN;
ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check;
ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check
        CHECK (job_type IN
        ('project_feed','compile_episode','snapshot_reconcile','session_purge',
         'installation_purge','report_status','report_usage',
         'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims',
         'recompile_extraction_policy','compile_context_shadow','record_context_delivery',
         'invalidate_context_packs','expire_promotion_candidates','index_shared_claim',
         'invalidate_scope_authorization','transfer_scope_claims','parse_code_snapshot'));
INSERT INTO memory_schema_migrations(version) VALUES (28);
COMMIT;

BEGIN;
ALTER TABLE memory_generation_runs
         DROP CONSTRAINT IF EXISTS memory_generation_runs_operation_check;
ALTER TABLE memory_generation_runs
         ADD CONSTRAINT memory_generation_runs_operation_check CHECK (operation IN
           ('extract_candidates','compile_context','compress_context_shadow','build_wiki'));
ALTER TABLE memory_jobs DROP CONSTRAINT IF EXISTS memory_jobs_job_type_check;
ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check
        CHECK (job_type IN
        ('project_feed','compile_episode','snapshot_reconcile','session_purge',
         'installation_purge','report_status','report_usage',
         'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims',
         'recompile_extraction_policy','compile_context_shadow','record_context_delivery',
         'invalidate_context_packs','expire_promotion_candidates','index_shared_claim',
         'invalidate_scope_authorization','transfer_scope_claims','parse_code_snapshot',
         'build_wiki'));
ALTER TABLE memory_wiki_build_runs
         ADD COLUMN IF NOT EXISTS generation_run_id UUID UNIQUE
           REFERENCES memory_generation_runs(run_id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS memory_wiki_build_sources (
         run_id             UUID NOT NULL,
         installation_id    UUID NOT NULL,
         source_token       TEXT NOT NULL CHECK (source_token <> '' AND char_length(source_token) <= 256),
         ordinal            INTEGER NOT NULL CHECK (ordinal >= 0),
         source_kind        TEXT NOT NULL CHECK (source_kind IN
                            ('file','symbol','claim_version','evidence')),
         stable_key         TEXT NOT NULL CHECK (stable_key <> ''),
         source_ref_id      UUID,
         source_snapshot_id UUID,
         commit_sha         TEXT,
         path               TEXT,
         content_hash       TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
         excerpt            TEXT,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (run_id, source_token),
         UNIQUE (run_id, ordinal),
         FOREIGN KEY (installation_id, run_id)
           REFERENCES memory_wiki_build_runs (installation_id, run_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, source_snapshot_id)
           REFERENCES memory_source_snapshots (installation_id, snapshot_id) ON DELETE CASCADE
       );
CREATE INDEX IF NOT EXISTS memory_wiki_build_sources_ref_idx
         ON memory_wiki_build_sources (installation_id, source_kind, source_ref_id);
CREATE TABLE IF NOT EXISTS memory_wiki_build_candidates (
         run_id          UUID PRIMARY KEY,
         installation_id UUID NOT NULL,
         wiki_id         UUID NOT NULL,
         document        JSONB NOT NULL,
         content_hash    TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
         validated_at    TIMESTAMPTZ NOT NULL,
         created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, run_id),
         FOREIGN KEY (installation_id, run_id)
           REFERENCES memory_wiki_build_runs (installation_id, run_id) ON DELETE CASCADE,
         FOREIGN KEY (installation_id, wiki_id)
           REFERENCES memory_wikis (installation_id, wiki_id) ON DELETE CASCADE
       );
INSERT INTO memory_schema_migrations(version) VALUES (29);
COMMIT;

BEGIN;
CREATE TABLE IF NOT EXISTS memory_phase4_authorization_audit_events (
         audit_id             UUID PRIMARY KEY,
         installation_id      UUID NOT NULL
           REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         action               TEXT NOT NULL CHECK (action IN
                              ('source_upload','publish','manual_edit','unlock')),
         result               TEXT NOT NULL CHECK (result = 'unauthorized'),
         actor_scope_kind     TEXT NOT NULL CHECK (actor_scope_kind IN ('team','organization')),
         actor_scope_id       UUID NOT NULL,
         membership_id        UUID NOT NULL,
         membership_revision  BIGINT NOT NULL CHECK (membership_revision >= 1),
         authorization_epoch  BIGINT NOT NULL CHECK (authorization_epoch >= 1),
         created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
CREATE INDEX IF NOT EXISTS memory_phase4_authorization_audit_events_installation_idx
         ON memory_phase4_authorization_audit_events (installation_id, created_at);
INSERT INTO memory_schema_migrations(version) VALUES (30);
COMMIT;

BEGIN;
CREATE TABLE memory_skill_archives (
      archive_id UUID PRIMARY KEY,
      installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      repository_id UUID NOT NULL,
      repo_snapshot_id UUID NOT NULL,
      episode_id UUID NOT NULL,
      task_id UUID NOT NULL,
      generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
      candidate_key TEXT NOT NULL CHECK (candidate_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
      policy_version TEXT NOT NULL CHECK (policy_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
      source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
      input_digest TEXT NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
      content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      document_hash TEXT NOT NULL CHECK (document_hash ~ '^[0-9a-f]{64}$'),
      document JSONB NOT NULL CHECK ((jsonb_typeof(document) = 'object'
        AND document->>'schema_version' = 'skill-candidate.v1'
        AND jsonb_typeof(document->'source_tokens') = 'array'
        AND jsonb_array_length(document->'source_tokens') BETWEEN 1 AND 64
        AND char_length(document::text) <= 32000) IS TRUE),
      created_transaction XID8 NOT NULL DEFAULT pg_current_xact_id(),
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (installation_id, archive_id),
      UNIQUE (installation_id, task_id, generation),
      FOREIGN KEY (installation_id, repository_id)
        REFERENCES repositories(installation_id, repository_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id, repo_snapshot_id)
        REFERENCES repo_snapshots(installation_id, repo_snapshot_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id, episode_id)
        REFERENCES work_episodes(installation_id, episode_id) ON DELETE CASCADE
    );
CREATE INDEX memory_skill_archives_source_idx
      ON memory_skill_archives (installation_id, episode_id);
CREATE INDEX memory_skill_archives_repository_idx
      ON memory_skill_archives (installation_id, repository_id, candidate_key, generation DESC);
CREATE TABLE memory_skill_archive_sources (
      installation_id UUID NOT NULL,
      archive_id UUID NOT NULL,
      source_token TEXT NOT NULL CHECK (source_token ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
      evidence_handle TEXT NOT NULL CHECK (char_length(evidence_handle) BETWEEN 1 AND 256),
      excerpt_hash TEXT NOT NULL CHECK (excerpt_hash ~ '^([0-9a-f]{16}|[0-9a-f]{64})$'),
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('event','artifact','episode')),
      source_event_id UUID,
      artifact_id UUID,
      PRIMARY KEY (installation_id, archive_id, source_token),
      UNIQUE (installation_id, archive_id, evidence_handle),
      CHECK ((evidence_kind='event' AND source_event_id IS NOT NULL AND artifact_id IS NULL)
        OR (evidence_kind='artifact' AND artifact_id IS NOT NULL)
        OR (evidence_kind='episode' AND source_event_id IS NULL AND artifact_id IS NULL)),
      FOREIGN KEY (installation_id, archive_id)
        REFERENCES memory_skill_archives(installation_id, archive_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id, source_event_id)
        REFERENCES source_events(installation_id, source_event_id) ON DELETE CASCADE,
      FOREIGN KEY (installation_id, artifact_id)
        REFERENCES source_artifacts(installation_id, artifact_id) ON DELETE CASCADE
    );
CREATE FUNCTION memory_skill_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'skill_archive_immutable'; END
    $$;
CREATE TRIGGER memory_skill_archive_no_update BEFORE UPDATE ON memory_skill_archives
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_immutable();
CREATE TRIGGER memory_skill_source_no_update BEFORE UPDATE ON memory_skill_archive_sources
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_immutable();
CREATE FUNCTION memory_skill_archive_check_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM work_episodes e
        JOIN repo_snapshots s ON s.installation_id=e.installation_id AND s.repo_snapshot_id=e.repo_snapshot_id
        JOIN memory_installations i ON i.installation_id=e.installation_id
        WHERE e.installation_id=NEW.installation_id AND e.episode_id=NEW.episode_id
          AND e.repository_id=NEW.repository_id AND e.repo_snapshot_id=NEW.repo_snapshot_id
          AND s.repository_id=NEW.repository_id
          AND e.state='ready' AND e.outcome='completed'
          AND encode(e.source_digest,'hex')=NEW.source_digest
          AND i.relay_status='active' AND i.local_status NOT IN ('purging','purged','integrity_error')
          AND NOT EXISTS (SELECT 1 FROM memory_repository_tombstones rt
            WHERE rt.installation_id=NEW.installation_id AND rt.repository_id=NEW.repository_id)
        FOR SHARE OF e, s, i;
        IF NOT FOUND THEN RAISE EXCEPTION 'skill_archive_source_invalid'; END IF;
        -- The transaction marker is server-owned; callers cannot extend an
        -- immutable archive by supplying a future transaction identifier.
        NEW.created_transaction := pg_current_xact_id();
        NEW.generated_at := NOW();
        RETURN NEW;
      END
    $$;
CREATE TRIGGER memory_skill_archive_source_guard BEFORE INSERT ON memory_skill_archives
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_check_source();
CREATE FUNCTION memory_skill_source_check_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE archive_row memory_skill_archives%ROWTYPE; manifest_entry JSONB;
      BEGIN
        SELECT * INTO archive_row FROM memory_skill_archives
          WHERE installation_id=NEW.installation_id AND archive_id=NEW.archive_id FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'skill_source_invalid'; END IF;
        IF archive_row.created_transaction <> pg_current_xact_id() THEN
          RAISE EXCEPTION 'skill_archive_immutable';
        END IF;
        SELECT evidence_manifest->NEW.evidence_handle INTO manifest_entry FROM work_episodes
          WHERE installation_id=NEW.installation_id AND episode_id=archive_row.episode_id;
        IF manifest_entry IS NULL
          OR manifest_entry->>'kind' IS DISTINCT FROM NEW.evidence_kind
          OR manifest_entry->>'excerpt_hash' IS DISTINCT FROM NEW.excerpt_hash
          OR manifest_entry->>'source_event_id' IS DISTINCT FROM NEW.source_event_id::text
          OR manifest_entry->>'artifact_id' IS DISTINCT FROM NEW.artifact_id::text
          OR COALESCE((manifest_entry->>'omitted')::boolean, FALSE)
          OR COALESCE((manifest_entry->>'excerpt_length')::integer, 0) <= 0
          OR NOT (archive_row.document->'source_tokens' ? NEW.source_token)
        THEN RAISE EXCEPTION 'skill_source_invalid'; END IF;
        RETURN NEW;
      END
    $$;
CREATE TRIGGER memory_skill_source_manifest_guard BEFORE INSERT ON memory_skill_archive_sources
      FOR EACH ROW EXECUTE FUNCTION memory_skill_source_check_manifest();
CREATE FUNCTION memory_skill_archive_check_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE doc JSONB; actual BIGINT; expected BIGINT;
      BEGIN
        SELECT document INTO doc FROM memory_skill_archives
          WHERE installation_id=NEW.installation_id AND archive_id=NEW.archive_id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT count(*) INTO actual FROM memory_skill_archive_sources
          WHERE installation_id=NEW.installation_id AND archive_id=NEW.archive_id;
        SELECT count(DISTINCT value) INTO expected FROM jsonb_array_elements_text(doc->'source_tokens');
        IF actual <> expected OR expected <> jsonb_array_length(doc->'source_tokens') THEN
          RAISE EXCEPTION 'skill_archive_sources_incomplete';
        END IF;
        RETURN NULL;
      END
    $$;
CREATE CONSTRAINT TRIGGER memory_skill_archive_sources_complete AFTER INSERT ON memory_skill_archives
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_check_complete();
CREATE FUNCTION memory_skill_source_delete_archive() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM memory_skill_archives WHERE installation_id=OLD.installation_id AND archive_id=OLD.archive_id;
        RETURN NULL;
      END
    $$;
CREATE TRIGGER memory_skill_source_delete_parent AFTER DELETE ON memory_skill_archive_sources
      FOR EACH ROW EXECUTE FUNCTION memory_skill_source_delete_archive();
CREATE FUNCTION memory_skill_episode_invalidate_archives() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state <> 'ready' OR NEW.outcome IS DISTINCT FROM 'completed'
          OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
          OR NEW.repo_snapshot_id IS DISTINCT FROM OLD.repo_snapshot_id
          OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
          OR NEW.evidence_manifest IS DISTINCT FROM OLD.evidence_manifest
        THEN DELETE FROM memory_skill_archives
          WHERE installation_id=NEW.installation_id AND episode_id=NEW.episode_id;
        END IF;
        RETURN NULL;
      END
    $$;
CREATE TRIGGER memory_skill_episode_invalidated AFTER UPDATE OF state, outcome,
      repository_id, repo_snapshot_id, source_digest, evidence_manifest ON work_episodes
      FOR EACH ROW EXECUTE FUNCTION memory_skill_episode_invalidate_archives();
INSERT INTO memory_schema_migrations(version) VALUES (31);
COMMIT;

BEGIN;
ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check;
ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check CHECK (job_type IN
      ('project_feed','compile_episode','snapshot_reconcile','session_purge','installation_purge',
       'report_status','report_usage','extract_candidates','index_claim_version','rebuild_claim_index',
       'expire_claims','recompile_extraction_policy','compile_context_shadow','record_context_delivery',
       'invalidate_context_packs','expire_promotion_candidates','index_shared_claim',
       'invalidate_scope_authorization','transfer_scope_claims','parse_code_snapshot','build_wiki',
       'extract_skill_candidate'));
ALTER TABLE memory_generation_runs DROP CONSTRAINT memory_generation_runs_operation_check;
ALTER TABLE memory_generation_runs ADD CONSTRAINT memory_generation_runs_operation_check CHECK (operation IN
      ('extract_candidates','compile_context','compress_context_shadow','build_wiki','extract_skill_candidate'));
ALTER TABLE memory_generation_runs ADD CONSTRAINT memory_generation_runs_installation_run_unique
      UNIQUE(installation_id,run_id);
ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_installation_job_unique UNIQUE(installation_id,job_id);
ALTER TABLE memory_generation_runs ADD CONSTRAINT memory_generation_runs_installation_job_fk
      FOREIGN KEY(installation_id,job_id) REFERENCES memory_jobs(installation_id,job_id)
      DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE memory_generation_runs ADD CONSTRAINT memory_generation_runs_job_delete_fk
      FOREIGN KEY(job_id) REFERENCES memory_jobs(job_id) ON DELETE SET NULL;
CREATE TABLE memory_skill_tasks (
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
    );
CREATE TABLE memory_skill_task_runs (
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
    );
CREATE INDEX memory_skill_task_runs_pending ON memory_skill_task_runs(installation_id,state,created_at)
      WHERE state IN ('pending','running');
CREATE TABLE memory_skill_candidates (
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
    );
ALTER TABLE memory_skill_archives ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'episode'
      CHECK (source_kind IN ('episode','claim_version'));
ALTER TABLE memory_skill_archives ADD COLUMN claim_version_id UUID;
ALTER TABLE memory_skill_archives ALTER COLUMN episode_id DROP NOT NULL;
ALTER TABLE memory_skill_archives ADD CONSTRAINT memory_skill_archive_source_kind_check CHECK
      ((source_kind='episode' AND episode_id IS NOT NULL AND claim_version_id IS NULL)
       OR (source_kind='claim_version' AND claim_version_id IS NOT NULL AND episode_id IS NULL));
ALTER TABLE memory_skill_archives ADD CONSTRAINT memory_skill_archive_claim_version_fk
      FOREIGN KEY (installation_id,claim_version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION memory_skill_archive_check_source() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$;
ALTER TABLE memory_skill_archive_sources ADD COLUMN evidence_id UUID;
ALTER TABLE memory_skill_archive_sources ADD CONSTRAINT memory_skill_source_evidence_fk
      FOREIGN KEY (installation_id,evidence_id) REFERENCES knowledge_evidence(installation_id,evidence_id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION memory_skill_source_check_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
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
        RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION memory_skill_episode_invalidate_archives() RETURNS trigger LANGUAGE plpgsql AS $$
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
        END IF; RETURN NULL; END $$;
CREATE FUNCTION memory_skill_archive_invalidate_task() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$;
CREATE TRIGGER memory_skill_archive_deleted AFTER DELETE ON memory_skill_archives
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_invalidate_task();
CREATE FUNCTION memory_skill_claim_invalidate_archives() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$;
CREATE TRIGGER memory_skill_claim_invalidated AFTER UPDATE OF state,current_version_id,conflict_group_id ON knowledge_claims
      FOR EACH ROW EXECUTE FUNCTION memory_skill_claim_invalidate_archives();
CREATE FUNCTION memory_skill_repository_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$;
CREATE TRIGGER memory_skill_repository_purged AFTER INSERT ON memory_repository_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_repository_tombstone();
CREATE FUNCTION memory_skill_session_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$;
CREATE TRIGGER memory_skill_session_purged AFTER INSERT ON memory_session_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_session_tombstone();
INSERT INTO memory_schema_migrations(version) VALUES (32);
COMMIT;

BEGIN;
CREATE TABLE memory_skills (
      skill_id UUID PRIMARY KEY, installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      task_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,skill_id), UNIQUE(installation_id,task_id),
      FOREIGN KEY(installation_id,task_id) REFERENCES memory_skill_tasks(installation_id,task_id) ON DELETE CASCADE
    );
ALTER TABLE memory_skill_candidates ADD CONSTRAINT memory_skill_candidate_archive_identity UNIQUE(installation_id,candidate_id,archive_id);
CREATE TABLE memory_skill_versions (
      version_id UUID PRIMARY KEY, installation_id UUID NOT NULL, skill_id UUID NOT NULL,
      version_number INTEGER NOT NULL CHECK(version_number>0), candidate_id UUID NOT NULL, archive_id UUID NOT NULL,
      document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
      document_hash TEXT NOT NULL CHECK(document_hash ~ '^[0-9a-f]{64}$'),
      source_digest TEXT NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
      archive_content_hash TEXT NOT NULL CHECK(archive_content_hash ~ '^[0-9a-f]{64}$'),
      policy_snapshot JSONB NOT NULL CHECK(jsonb_typeof(policy_snapshot)='object'),
      policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
      risk TEXT NOT NULL CHECK(risk IN('low','high','unknown')),
      author_kind TEXT NOT NULL CHECK(author_kind IN('personal','membership')), author_id UUID NOT NULL,
      authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,skill_id,version_id), UNIQUE(installation_id,skill_id,version_number),
      UNIQUE(installation_id,version_id,document_hash,source_digest,policy_hash),
      FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,candidate_id,archive_id) REFERENCES memory_skill_candidates(installation_id,candidate_id,archive_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,archive_id) REFERENCES memory_skill_archives(installation_id,archive_id) ON DELETE CASCADE
    );
CREATE TABLE memory_skill_heads (
      installation_id UUID NOT NULL, skill_id UUID PRIMARY KEY, current_version_id UUID NOT NULL,
      revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
      state TEXT NOT NULL CHECK(state IN('draft','reviewed','rejected','revoked')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(installation_id,skill_id,current_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE
    );
CREATE FUNCTION memory_skill_version_check_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM memory_skills s JOIN memory_skill_candidates c ON c.installation_id=s.installation_id AND c.task_id=s.task_id
          JOIN memory_skill_archives a ON a.installation_id=c.installation_id AND a.archive_id=c.archive_id
          WHERE s.installation_id=NEW.installation_id AND s.skill_id=NEW.skill_id AND c.candidate_id=NEW.candidate_id
            AND a.archive_id=NEW.archive_id AND a.source_digest=NEW.source_digest AND a.content_hash=NEW.archive_content_hash
          FOR SHARE OF s,c,a;
        IF NOT FOUND THEN RAISE EXCEPTION 'skill_version_source_invalid'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_version_source BEFORE INSERT ON memory_skill_versions
      FOR EACH ROW EXECUTE FUNCTION memory_skill_version_check_source();
CREATE TABLE memory_skill_review_decisions (
      decision_id UUID PRIMARY KEY, installation_id UUID NOT NULL, skill_id UUID NOT NULL, version_id UUID NOT NULL,
      document_hash TEXT NOT NULL, source_digest TEXT NOT NULL, policy_hash TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')), actor_id UUID NOT NULL,
      membership_revision BIGINT, authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      decision TEXT NOT NULL CHECK(decision IN('approve','request_changes','reject')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((actor_kind='personal' AND membership_revision IS NULL) OR (actor_kind='membership' AND membership_revision>0)),
      UNIQUE(installation_id,version_id,actor_kind,actor_id),
      FOREIGN KEY(installation_id,skill_id,version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,version_id,document_hash,source_digest,policy_hash)
        REFERENCES memory_skill_versions(installation_id,version_id,document_hash,source_digest,policy_hash) ON DELETE CASCADE
    );
CREATE TABLE memory_skill_audit_events (
      event_id UUID PRIMARY KEY, installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      actor_kind TEXT CHECK(actor_kind IN('personal','membership')), actor_id UUID,
      action TEXT NOT NULL CHECK(action IN('draft','edit','approve','request_changes','reject','revoke')),
      outcome TEXT NOT NULL CHECK(outcome IN('allowed','denied')), skill_id UUID, version_id UUID,
      revision BIGINT CHECK(revision BETWEEN 1 AND 9007199254740991),
      code TEXT NOT NULL CHECK(code IN('ok','invalid_request','forbidden','not_found','revision_conflict','state_conflict',
        'source_invalid','policy_changed','self_review_denied','secret_detected','size_exceeded','source_tokens_invalid',
        'duplicate_decision','feature_disabled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK((actor_kind IS NULL)=(actor_id IS NULL))
    );
CREATE INDEX memory_skill_audit_scope_time ON memory_skill_audit_events(installation_id,created_at,event_id);
CREATE FUNCTION memory_skill_governance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'skill_governance_immutable'; END $$;
CREATE TRIGGER memory_skill_versions_immutable BEFORE UPDATE ON memory_skill_versions FOR EACH ROW EXECUTE FUNCTION memory_skill_governance_immutable();
CREATE TRIGGER memory_skill_review_decisions_immutable BEFORE UPDATE ON memory_skill_review_decisions FOR EACH ROW EXECUTE FUNCTION memory_skill_governance_immutable();
CREATE TRIGGER memory_skill_audit_events_immutable BEFORE UPDATE ON memory_skill_audit_events FOR EACH ROW EXECUTE FUNCTION memory_skill_governance_immutable();
INSERT INTO memory_schema_migrations(version) VALUES (33);
COMMIT;

BEGIN;
ALTER TABLE memory_skill_audit_events DROP CONSTRAINT memory_skill_audit_events_action_check;
ALTER TABLE memory_skill_audit_events ADD CONSTRAINT memory_skill_audit_events_action_check
      CHECK(action IN('draft','edit','approve','request_changes','reject','revoke','replay'));
ALTER TABLE memory_skill_audit_events DROP CONSTRAINT memory_skill_audit_events_code_check;
ALTER TABLE memory_skill_audit_events ADD CONSTRAINT memory_skill_audit_events_code_check CHECK(code IN(
      'ok','invalid_request','forbidden','not_found','revision_conflict','state_conflict','source_invalid','policy_changed',
      'self_review_denied','secret_detected','size_exceeded','source_tokens_invalid','duplicate_decision','feature_disabled',
      'case_invalid','version_conflict','lease_lost','runner_failed','replay_failed','replay_cancelled'));
CREATE TABLE memory_skill_replay_runs (
      run_id UUID PRIMARY KEY, sequence BIGSERIAL UNIQUE, installation_id UUID NOT NULL, skill_id UUID NOT NULL, version_id UUID NOT NULL,
      repository_id UUID NOT NULL, repo_snapshot_id UUID NOT NULL,
      head_revision BIGINT NOT NULL CHECK(head_revision>0), idempotency_key TEXT NOT NULL CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
      document_hash TEXT NOT NULL, source_digest TEXT NOT NULL, policy_hash TEXT NOT NULL,
      input_hash TEXT NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'), runner_version TEXT NOT NULL CHECK(runner_version='skill-recorded-replay.v1'),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')), actor_id UUID NOT NULL,
      state TEXT NOT NULL CHECK(state IN('running','passed','failed','cancelled')),
      attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt BETWEEN 1 AND 3), lease_token UUID NOT NULL, lease_expires_at TIMESTAMPTZ,
      error_code TEXT CHECK(error_code ~ '^[a-z][a-z0-9_]{0,63}$'), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ,
      created_transaction xid8 NOT NULL DEFAULT pg_current_xact_id(),
      UNIQUE(installation_id,run_id), UNIQUE(installation_id,skill_id,idempotency_key),
      CHECK((state='running' AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
        OR (state<>'running' AND lease_expires_at IS NULL AND completed_at IS NOT NULL)),
      FOREIGN KEY(installation_id,skill_id,version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,version_id,document_hash,source_digest,policy_hash)
        REFERENCES memory_skill_versions(installation_id,version_id,document_hash,source_digest,policy_hash) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,repo_snapshot_id) REFERENCES repo_snapshots(installation_id,repo_snapshot_id) ON DELETE CASCADE
    );
CREATE INDEX memory_skill_replay_latest ON memory_skill_replay_runs(installation_id,skill_id,sequence DESC);
CREATE FUNCTION memory_skill_replay_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM memory_skill_versions v JOIN memory_skill_archives a USING(installation_id,archive_id)
          WHERE v.installation_id=NEW.installation_id AND v.version_id=NEW.version_id
            AND a.repository_id=NEW.repository_id AND a.repo_snapshot_id=NEW.repo_snapshot_id)
          OR NEW.state<>'running' OR NEW.attempt<>1 OR NEW.created_transaction<>pg_current_xact_id()
        THEN RAISE EXCEPTION 'skill_replay_invalid_lineage'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_replay_lineage BEFORE INSERT ON memory_skill_replay_runs
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_lineage();
CREATE TABLE memory_skill_replay_cases (
      installation_id UUID NOT NULL, run_id UUID NOT NULL, case_id TEXT NOT NULL CHECK(length(case_id) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK(kind IN('historical_session','golden_task')), provenance TEXT NOT NULL CHECK(provenance IN('fixture','recorded')),
      reference_id TEXT NOT NULL CHECK(length(reference_id) BETWEEN 1 AND 200), session_id TEXT,
      input_hash TEXT NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','passed','failed','cancelled')),
      error_code TEXT CHECK(error_code ~ '^[a-z][a-z0-9_]{0,63}$'), assertion_results JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(assertion_results)='array'),
      PRIMARY KEY(installation_id,run_id,case_id),
      CHECK((kind='historical_session' AND session_id IS NOT NULL AND session_id=reference_id) OR (kind='golden_task' AND session_id IS NULL)),
      FOREIGN KEY(installation_id,run_id) REFERENCES memory_skill_replay_runs(installation_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,session_id) REFERENCES source_sessions(installation_id,session_id) ON DELETE CASCADE
    );
CREATE FUNCTION memory_skill_replay_run_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state<>'running' OR (to_jsonb(NEW)-ARRAY['state','attempt','lease_token','lease_expires_at','error_code','completed_at'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempt','lease_token','lease_expires_at','error_code','completed_at'])
        THEN RAISE EXCEPTION 'skill_replay_immutable'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_replay_run_immutable BEFORE UPDATE ON memory_skill_replay_runs
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_run_immutable();
CREATE FUNCTION memory_skill_replay_case_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state<>'pending' OR NEW.assertion_results<>'[]'::jsonb OR NEW.error_code IS NOT NULL OR NOT EXISTS(
          SELECT 1 FROM memory_skill_replay_runs WHERE installation_id=NEW.installation_id AND run_id=NEW.run_id
            AND state='running' AND created_transaction=pg_current_xact_id())
        THEN RAISE EXCEPTION 'skill_replay_case_set_closed'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_replay_case_insert BEFORE INSERT ON memory_skill_replay_cases
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_case_insert();
CREATE FUNCTION memory_skill_replay_case_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state<>'pending' OR (to_jsonb(NEW)-ARRAY['state','error_code','assertion_results'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','error_code','assertion_results'])
        THEN RAISE EXCEPTION 'skill_replay_immutable'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_replay_case_immutable BEFORE UPDATE ON memory_skill_replay_cases
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_case_immutable();
CREATE FUNCTION memory_skill_replay_case_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM memory_skill_replay_runs WHERE installation_id=OLD.installation_id AND run_id=OLD.run_id; RETURN NULL; END $$;
CREATE TRIGGER memory_skill_replay_case_deleted AFTER DELETE ON memory_skill_replay_cases
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_case_deleted();
CREATE FUNCTION memory_skill_replay_session_purged() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM memory_skill_replay_runs r WHERE r.installation_id=NEW.installation_id
        AND EXISTS(SELECT 1 FROM memory_skill_replay_cases c WHERE c.installation_id=r.installation_id AND c.run_id=r.run_id AND c.session_id=NEW.session_id);
        RETURN NULL; END $$;
CREATE TRIGGER memory_skill_replay_session_purged AFTER INSERT ON memory_session_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_replay_session_purged();
INSERT INTO memory_schema_migrations(version) VALUES (34);
COMMIT;

BEGIN;
ALTER TABLE memory_skill_audit_events DROP CONSTRAINT memory_skill_audit_events_action_check;
ALTER TABLE memory_skill_audit_events ADD CONSTRAINT memory_skill_audit_events_action_check CHECK(action IN('draft','edit','approve','request_changes','reject','revoke','replay','publish','rollback','policy','eligibility'));
ALTER TABLE memory_skill_audit_events DROP CONSTRAINT memory_skill_audit_events_code_check;
ALTER TABLE memory_skill_audit_events ADD CONSTRAINT memory_skill_audit_events_code_check CHECK(code IN('ok','invalid_request','forbidden','not_found','revision_conflict','state_conflict','source_invalid','policy_changed','self_review_denied','secret_detected','size_exceeded','source_tokens_invalid','duplicate_decision','feature_disabled','case_invalid','version_conflict','lease_lost','runner_failed','replay_failed','replay_cancelled','product_gate_closed','risk_denied','review_required','self_publish_denied','independent_successes_required','generation_invalid','budget_invalid','no_previous_version','target_revoked','publication_failed'));
ALTER TABLE memory_skill_task_runs ADD COLUMN budget_reservation_id UUID;
CREATE TABLE memory_skill_publication_policy_versions (
      version_id UUID PRIMARY KEY, installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      revision BIGINT NOT NULL CHECK(revision>0), policy JSONB NOT NULL, policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')),actor_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((policy->>'minimumIndependentSuccesses')::int>=2 AND policy->>'autoMode' IN('off','shadow') AND policy->>'canaryMode' IN('off','shadow')),
      UNIQUE(installation_id,version_id),UNIQUE(installation_id,revision));
CREATE TABLE memory_skill_publication_policy_heads (
      installation_id UUID PRIMARY KEY REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      version_id UUID NOT NULL,revision BIGINT NOT NULL CHECK(revision>0),
      FOREIGN KEY(installation_id,version_id) REFERENCES memory_skill_publication_policy_versions(installation_id,version_id));
CREATE TABLE memory_skill_publication_events (
      event_id UUID PRIMARY KEY,installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      skill_id UUID NOT NULL,version_id UUID NOT NULL,previous_version_id UUID,revision BIGINT NOT NULL CHECK(revision>0),
      mode TEXT NOT NULL CHECK(mode IN('manual','auto','rollback')),provenance TEXT NOT NULL CHECK(provenance='fixture'),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')),actor_id UUID NOT NULL,
      membership_revision BIGINT,authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),replay_run_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,event_id),UNIQUE(installation_id,skill_id,revision));
CREATE TABLE memory_skill_publication_heads (
      installation_id UUID NOT NULL,skill_id UUID NOT NULL,current_version_id UUID,previous_version_id UUID,
      revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),state TEXT NOT NULL CHECK(state IN('active','disabled')),
      publication_event_id UUID,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,skill_id),
      CHECK(state<>'active' OR current_version_id IS NOT NULL),
      FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,skill_id,current_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,skill_id,previous_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(previous_version_id) REFERENCES memory_skill_versions(version_id) ON DELETE SET NULL,
      FOREIGN KEY(installation_id,publication_event_id) REFERENCES memory_skill_publication_events(installation_id,event_id));
CREATE TABLE memory_skill_version_revocations (
      installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      skill_id UUID NOT NULL,version_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,version_id));
CREATE TRIGGER memory_skill_publication_policy_versions_immutable BEFORE UPDATE ON memory_skill_publication_policy_versions FOR EACH ROW EXECUTE FUNCTION memory_skill_governance_immutable();
CREATE TRIGGER memory_skill_publication_events_immutable BEFORE UPDATE ON memory_skill_publication_events FOR EACH ROW EXECUTE FUNCTION memory_skill_governance_immutable();
CREATE TRIGGER memory_skill_version_revocations_immutable BEFORE UPDATE ON memory_skill_version_revocations FOR EACH ROW EXECUTE FUNCTION memory_skill_governance_immutable();
CREATE FUNCTION memory_skill_publication_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state='revoked' THEN
          INSERT INTO memory_skill_version_revocations(installation_id,skill_id,version_id)
            SELECT installation_id,skill_id,version_id FROM memory_skill_versions WHERE installation_id=NEW.installation_id AND skill_id=NEW.skill_id
            ON CONFLICT DO NOTHING;
          UPDATE memory_skill_publication_heads SET state='disabled',revision=revision+1,updated_at=NOW()
            WHERE installation_id=NEW.installation_id AND skill_id=NEW.skill_id AND state='active';
        END IF; RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_publication_revoke AFTER UPDATE OF state ON memory_skill_heads
      FOR EACH ROW EXECUTE FUNCTION memory_skill_publication_revoke();
CREATE FUNCTION memory_skill_publication_target_revoked() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE memory_skill_publication_heads SET state='disabled',revision=revision+1,updated_at=NOW()
        WHERE installation_id=NEW.installation_id AND current_version_id=NEW.version_id AND state='active'; RETURN NEW; END $$;
CREATE TRIGGER memory_skill_publication_target_revoked AFTER INSERT ON memory_skill_version_revocations
      FOR EACH ROW EXECUTE FUNCTION memory_skill_publication_target_revoked();
INSERT INTO memory_schema_migrations(version) VALUES (35);
COMMIT;

BEGIN;
CREATE TABLE memory_skill_rollouts (
      installation_id UUID NOT NULL,skill_id UUID NOT NULL,revision BIGINT NOT NULL CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN('shadow','canary','disabled')),basis_points INTEGER NOT NULL CHECK(basis_points BETWEEN 0 AND 10000),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(installation_id,skill_id),
      FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE
    );
CREATE TABLE memory_skill_executions (
      execution_id UUID PRIMARY KEY,installation_id UUID NOT NULL,skill_id UUID NOT NULL,version_id UUID NOT NULL,
      repository_id UUID NOT NULL,repo_snapshot_id UUID NOT NULL,session_id TEXT NOT NULL,
      document_hash TEXT NOT NULL,source_digest TEXT NOT NULL,policy_hash TEXT NOT NULL,
      publication_revision BIGINT NOT NULL CHECK(publication_revision>0),rollout_revision BIGINT NOT NULL CHECK(rollout_revision>0),
      actor_kind TEXT NOT NULL CHECK(actor_kind IN('personal','membership')),actor_id UUID NOT NULL,
      membership_revision BIGINT NOT NULL,authorization_epoch BIGINT NOT NULL,
      assignment_bucket INTEGER NOT NULL CHECK(assignment_bucket BETWEEN 0 AND 9999),
      idempotency_key TEXT NOT NULL CHECK(idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
      input_hash TEXT NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),provenance TEXT NOT NULL DEFAULT 'fixture' CHECK(provenance='fixture'),
      state TEXT NOT NULL DEFAULT 'started' CHECK(state IN('started','succeeded','failed','taken_over','cancelled')),
      revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),receipt_key TEXT,started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),completed_at TIMESTAMPTZ,
      UNIQUE(installation_id,execution_id),UNIQUE(installation_id,actor_kind,actor_id,idempotency_key),
      CHECK((state='started' AND completed_at IS NULL AND receipt_key IS NULL) OR (state<>'started' AND completed_at IS NOT NULL)),
      FOREIGN KEY(installation_id,skill_id,version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,version_id,document_hash,source_digest,policy_hash)
        REFERENCES memory_skill_versions(installation_id,version_id,document_hash,source_digest,policy_hash) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,repo_snapshot_id) REFERENCES repo_snapshots(installation_id,repo_snapshot_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,session_id) REFERENCES source_sessions(installation_id,session_id) ON DELETE CASCADE
    );
CREATE INDEX memory_skill_executions_skill ON memory_skill_executions(installation_id,skill_id,started_at DESC);
CREATE FUNCTION memory_skill_execution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.state<>'started' OR NEW.state='started' OR NEW.revision<>OLD.revision+1 OR
          (to_jsonb(NEW)-ARRAY['state','revision','receipt_key','completed_at']) IS DISTINCT FROM
          (to_jsonb(OLD)-ARRAY['state','revision','receipt_key','completed_at'])
        THEN RAISE EXCEPTION 'skill_execution_immutable'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_execution_immutable BEFORE UPDATE ON memory_skill_executions
      FOR EACH ROW EXECUTE FUNCTION memory_skill_execution_immutable();
CREATE FUNCTION memory_skill_execution_session_purged() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM memory_skill_executions WHERE installation_id=NEW.installation_id AND session_id=NEW.session_id; RETURN NULL; END $$;
CREATE TRIGGER memory_skill_execution_session_purged AFTER INSERT ON memory_session_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_execution_session_purged();
INSERT INTO memory_schema_migrations(version) VALUES (36);
COMMIT;

BEGIN;
ALTER TABLE memory_skill_review_decisions ADD COLUMN review_outcome TEXT CHECK(review_outcome IN('accepted_as_is','light_edit','major_edit'));
ALTER TABLE memory_skill_review_decisions ADD CONSTRAINT memory_skill_review_outcome_action CHECK(review_outcome IS NULL OR decision='approve');
CREATE FUNCTION memory_skill_publication_disabled() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state='disabled' THEN
          UPDATE memory_skill_rollouts SET state='disabled',revision=revision+1,updated_at=NOW()
            WHERE installation_id=NEW.installation_id AND skill_id=NEW.skill_id AND state<>'disabled';
          UPDATE memory_skill_executions SET state='cancelled',revision=revision+1,completed_at=NOW()
            WHERE installation_id=NEW.installation_id AND skill_id=NEW.skill_id AND state='started';
        END IF; RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_publication_disabled AFTER UPDATE OF state ON memory_skill_publication_heads
      FOR EACH ROW EXECUTE FUNCTION memory_skill_publication_disabled();
CREATE FUNCTION memory_skill_forget_tasks(target_installation UUID,target_tasks UUID[]) RETURNS VOID LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM 1 FROM memory_skill_tasks WHERE installation_id=target_installation AND task_id=ANY(target_tasks) ORDER BY task_id FOR UPDATE;
        UPDATE memory_generation_runs g SET state='cancelled',error_code='skill_source_invalidated',completed_at=NOW()
          FROM memory_skill_task_runs r WHERE r.installation_id=target_installation AND r.task_id=ANY(target_tasks)
            AND r.generation_run_id=g.run_id AND g.state IN('queued','running');
        UPDATE memory_jobs SET state='completed',last_error_code='skill_source_invalidated',completed_at=NOW(),claim_expires_at=NULL
          WHERE installation_id=target_installation AND job_type='extract_skill_candidate' AND state IN('pending','running')
            AND payload->>'task_id'=ANY(ARRAY(SELECT unnest(target_tasks)::text));
        DELETE FROM memory_skill_archives WHERE installation_id=target_installation AND task_id=ANY(target_tasks);
        DELETE FROM memory_skill_tasks WHERE installation_id=target_installation AND task_id=ANY(target_tasks);
      END $$;
CREATE FUNCTION memory_skill_scope_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ids UUID[];
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state<>'active'
          OR NEW.authorization_epoch IS DISTINCT FROM OLD.authorization_epoch THEN
          SELECT ARRAY_AGG(task_id ORDER BY task_id) INTO ids FROM memory_skill_tasks WHERE installation_id=NEW.installation_id;
          PERFORM memory_skill_forget_tasks(NEW.installation_id,COALESCE(ids,ARRAY[]::UUID[]));
        END IF;
        IF NEW.state='dissolved' THEN
          DELETE FROM memory_skill_publication_policy_heads WHERE installation_id=NEW.installation_id;
          DELETE FROM memory_skill_publication_policy_versions WHERE installation_id=NEW.installation_id;
        END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_scope_invalidated AFTER UPDATE OF state,authorization_epoch ON memory_owner_scopes
      FOR EACH ROW EXECUTE FUNCTION memory_skill_scope_invalidated();
CREATE FUNCTION memory_skill_member_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.state IS DISTINCT FROM OLD.state OR NEW.membership_revision IS DISTINCT FROM OLD.membership_revision OR NEW.roles IS DISTINCT FROM OLD.roles THEN
          UPDATE memory_skill_publication_heads p SET state='disabled',revision=revision+1,updated_at=NOW()
            WHERE p.installation_id=NEW.installation_id AND p.state='active' AND (
              EXISTS(SELECT 1 FROM memory_skill_publication_events e WHERE e.installation_id=p.installation_id AND e.event_id=p.publication_event_id
                AND e.actor_kind='membership' AND e.actor_id=NEW.membership_id)
              OR EXISTS(SELECT 1 FROM memory_skill_review_decisions d WHERE d.installation_id=p.installation_id AND d.version_id=p.current_version_id
                AND d.actor_kind='membership' AND d.actor_id=NEW.membership_id));
          UPDATE memory_skill_executions e SET state='cancelled',revision=revision+1,completed_at=NOW()
            WHERE e.installation_id=NEW.installation_id AND e.state='started' AND
              ((e.actor_kind='membership' AND e.actor_id=NEW.membership_id) OR EXISTS(
                SELECT 1 FROM memory_skill_publication_heads p WHERE p.installation_id=e.installation_id AND p.skill_id=e.skill_id AND p.state='disabled'));
        END IF; RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_member_invalidated AFTER UPDATE OF state,membership_revision,roles ON memory_scope_memberships
      FOR EACH ROW EXECUTE FUNCTION memory_skill_member_invalidated();
CREATE FUNCTION memory_skill_installation_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ids UUID[];
      BEGIN
        IF NEW.relay_status IN('revoking','revoked') OR NEW.local_status IN('purging','purged','integrity_error') THEN
          SELECT ARRAY_AGG(task_id ORDER BY task_id) INTO ids FROM memory_skill_tasks WHERE installation_id=NEW.installation_id;
          PERFORM memory_skill_forget_tasks(NEW.installation_id,COALESCE(ids,ARRAY[]::UUID[]));
          DELETE FROM memory_skill_publication_policy_heads WHERE installation_id=NEW.installation_id;
          DELETE FROM memory_skill_publication_policy_versions WHERE installation_id=NEW.installation_id;
        END IF; RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_installation_invalidated AFTER UPDATE OF relay_status,local_status ON memory_installations
      FOR EACH ROW EXECUTE FUNCTION memory_skill_installation_invalidated();
CREATE FUNCTION memory_skill_snapshot_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE ids UUID[];
      BEGIN
        SELECT ARRAY_AGG(DISTINCT r.task_id) INTO ids FROM memory_skill_task_runs r JOIN repo_snapshots s USING(installation_id,repo_snapshot_id)
          WHERE r.installation_id=NEW.installation_id AND s.repository_id=NEW.repository_id AND s.commit_sha=NEW.commit_sha;
        PERFORM memory_skill_forget_tasks(NEW.installation_id,COALESCE(ids,ARRAY[]::UUID[])); RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_snapshot_invalidated AFTER INSERT ON memory_source_snapshot_tombstones
      FOR EACH ROW EXECUTE FUNCTION memory_skill_snapshot_invalidated();
CREATE FUNCTION memory_skill_archive_snapshot_fence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM repo_snapshots s JOIN memory_source_snapshot_tombstones t
          ON t.installation_id=s.installation_id AND t.repository_id=s.repository_id AND t.commit_sha=s.commit_sha
          WHERE s.installation_id=NEW.installation_id AND s.repo_snapshot_id=NEW.repo_snapshot_id)
        THEN RAISE EXCEPTION 'skill_source_snapshot_purged'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_skill_archive_snapshot_fence BEFORE INSERT ON memory_skill_archives
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_snapshot_fence();
INSERT INTO memory_schema_migrations(version) VALUES (37);
COMMIT;

BEGIN;
CREATE FUNCTION memory_skill_document_chars(document JSONB) RETURNS BIGINT
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
      END $$;
ALTER TABLE memory_skill_archives DROP CONSTRAINT memory_skill_archives_document_check;
ALTER TABLE memory_skill_archives ADD CONSTRAINT memory_skill_archives_document_check CHECK ((
      jsonb_typeof(document)='object' AND document->>'schema_version'='skill-candidate.v1'
      AND jsonb_typeof(document->'source_tokens')='array'
      AND jsonb_array_length(document->'source_tokens') BETWEEN 1 AND 64
      AND memory_skill_document_chars(document)<=32000) IS TRUE);
CREATE OR REPLACE FUNCTION memory_skill_snapshot_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$;
INSERT INTO memory_schema_migrations(version) VALUES (38);
COMMIT;

BEGIN;
ALTER TABLE memory_owner_scopes ADD CONSTRAINT memory_git_owner_identity UNIQUE(installation_id,owner_scope_kind,owner_scope_id);
ALTER TABLE knowledge_versions ADD CONSTRAINT memory_git_claim_version_identity UNIQUE(installation_id,claim_id,version_id);
ALTER TABLE memory_wiki_versions ADD CONSTRAINT memory_git_wiki_version_identity UNIQUE(installation_id,wiki_id,wiki_version_id);
CREATE TABLE memory_git_connections (
      connection_id UUID PRIMARY KEY, installation_id UUID NOT NULL, repository_id UUID NOT NULL,
      owner_scope_kind TEXT NOT NULL CHECK(owner_scope_kind IN('team','organization')), owner_scope_id UUID NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN('github','gitlab','gitee')),
      provider_repository_id TEXT NOT NULL CHECK(char_length(provider_repository_id) BETWEEN 1 AND 256),
      target_id TEXT NOT NULL CHECK(char_length(target_id) BETWEEN 1 AND 256),
      target_branch TEXT NOT NULL CHECK(char_length(target_branch) BETWEEN 1 AND 255),
      root_path TEXT NOT NULL DEFAULT '.pocketctl/knowledge/' CHECK(root_path='.pocketctl/knowledge/'),
      credential_ref TEXT NOT NULL CHECK(char_length(credential_ref) BETWEEN 1 AND 512),
      sync_mode TEXT NOT NULL DEFAULT 'off' CHECK(sync_mode IN('off','shadow','enabled')),
      write_mode TEXT NOT NULL DEFAULT 'off' CHECK(write_mode IN('off','shadow')),
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','disabled')),
      generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0), cursor TEXT CHECK(char_length(cursor)<=1024),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id), UNIQUE(installation_id,connection_id,repository_id),
      FOREIGN KEY(installation_id,repository_id) REFERENCES repositories(installation_id,repository_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,owner_scope_kind,owner_scope_id)
        REFERENCES memory_owner_scopes(installation_id,owner_scope_kind,owner_scope_id) ON DELETE CASCADE
    );
CREATE UNIQUE INDEX memory_git_one_active_connection ON memory_git_connections(installation_id,repository_id) WHERE state='active';
CREATE TABLE memory_git_actor_mappings (
      installation_id UUID NOT NULL, connection_id UUID NOT NULL,
      provider_actor_id TEXT NOT NULL CHECK(char_length(provider_actor_id) BETWEEN 1 AND 256),
      membership_id UUID NOT NULL, membership_revision BIGINT NOT NULL CHECK(membership_revision>0),
      authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(installation_id,connection_id,provider_actor_id), FOREIGN KEY(installation_id,connection_id) REFERENCES memory_git_connections(installation_id,connection_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE
    );
CREATE TABLE memory_git_asset_bindings (
      binding_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, repository_id UUID NOT NULL,
      
  kind TEXT NOT NULL CHECK(kind IN('claim','rule','wiki','skill')),
  claim_id UUID, wiki_id UUID, skill_id UUID,
  asset_id UUID GENERATED ALWAYS AS (COALESCE(claim_id,wiki_id,skill_id)) STORED,
  CHECK(num_nonnulls(claim_id,wiki_id,skill_id)=1),
  CHECK((kind IN('claim','rule') AND claim_id IS NOT NULL) OR (kind='wiki' AND wiki_id IS NOT NULL) OR (kind='skill' AND skill_id IS NOT NULL)),
  FOREIGN KEY(installation_id,claim_id) REFERENCES knowledge_claims(installation_id,claim_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,wiki_id) REFERENCES memory_wikis(installation_id,wiki_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE, path TEXT NOT NULL CHECK(char_length(path) BETWEEN 1 AND 512
  AND path LIKE '.pocketctl/knowledge/%' AND path !~ '(^|/)\.\.?(/|$)' AND strpos(path,chr(92))=0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id,binding_id,kind,asset_id),
      UNIQUE(installation_id,connection_id,asset_id), UNIQUE(installation_id,connection_id,path),
      FOREIGN KEY(installation_id,connection_id,repository_id)
        REFERENCES memory_git_connections(installation_id,connection_id,repository_id) ON DELETE CASCADE
    );
CREATE FUNCTION memory_git_binding_repository() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF num_nonnulls(NEW.claim_id,NEW.wiki_id,NEW.skill_id)<>1 OR
          NOT ((NEW.kind IN('claim','rule') AND NEW.claim_id IS NOT NULL) OR
            (NEW.kind='wiki' AND NEW.wiki_id IS NOT NULL) OR (NEW.kind='skill' AND NEW.skill_id IS NOT NULL)) THEN RETURN NEW; END IF;
        IF NEW.claim_id IS NOT NULL THEN
          PERFORM 1 FROM knowledge_claims c JOIN knowledge_versions v ON v.installation_id=c.installation_id AND v.claim_id=c.claim_id AND v.version_id=c.current_version_id
            JOIN repositories r ON r.installation_id=c.installation_id AND r.repository_id=NEW.repository_id
            WHERE c.installation_id=NEW.installation_id AND c.claim_id=NEW.claim_id
              AND (v.repository_id=r.repository_id OR (v.repository_id IS NULL AND c.scope_kind='repository' AND c.scope_key IN(r.repository_id::text,r.repository_key)))
              AND (NEW.kind<>'rule' OR c.claim_type IN('repository_convention','test_invariant')) FOR SHARE OF c,v,r;
        ELSIF NEW.wiki_id IS NOT NULL THEN
          PERFORM 1 FROM memory_wikis WHERE installation_id=NEW.installation_id AND wiki_id=NEW.wiki_id AND repository_id=NEW.repository_id FOR SHARE;
        ELSE
          PERFORM 1 FROM memory_skills s JOIN memory_skill_tasks t USING(installation_id,task_id)
            WHERE s.installation_id=NEW.installation_id AND s.skill_id=NEW.skill_id AND t.repository_id=NEW.repository_id FOR SHARE OF s,t;
        END IF;
        IF NOT FOUND THEN RAISE EXCEPTION 'git_asset_repository_mismatch'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_git_binding_repository BEFORE INSERT OR UPDATE ON memory_git_asset_bindings FOR EACH ROW EXECUTE FUNCTION memory_git_binding_repository();
CREATE UNIQUE INDEX memory_git_binding_normalized_path ON memory_git_asset_bindings(installation_id,connection_id,lower(normalize(path,NFC)));
CREATE TABLE memory_git_snapshots (
      export_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL,
      generation BIGINT NOT NULL CHECK(generation>0), schema_version TEXT NOT NULL DEFAULT 'memory-git.v1' CHECK(schema_version='memory-git.v1'),
      base_commit TEXT NOT NULL CHECK(base_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      source_digest TEXT NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'), manifest_hash TEXT NOT NULL CHECK(manifest_hash ~ '^[0-9a-f]{64}$'),
      attestation BYTEA NOT NULL CHECK(octet_length(attestation) BETWEEN 1 AND 1048576),
      asset_count INTEGER NOT NULL CHECK(asset_count BETWEEN 1 AND 256),
      created_transaction BIGINT NOT NULL DEFAULT txid_current(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      UNIQUE(installation_id,connection_id,export_id), FOREIGN KEY(installation_id,connection_id) REFERENCES memory_git_connections(installation_id,connection_id) ON DELETE CASCADE
    );
CREATE TABLE memory_git_snapshot_assets (
      installation_id UUID NOT NULL, connection_id UUID NOT NULL, export_id UUID NOT NULL, binding_id UUID NOT NULL,
      
  kind TEXT NOT NULL CHECK(kind IN('claim','rule','wiki','skill')),
  claim_id UUID, wiki_id UUID, skill_id UUID,
  asset_id UUID GENERATED ALWAYS AS (COALESCE(claim_id,wiki_id,skill_id)) STORED,
  CHECK(num_nonnulls(claim_id,wiki_id,skill_id)=1),
  CHECK((kind IN('claim','rule') AND claim_id IS NOT NULL) OR (kind='wiki' AND wiki_id IS NOT NULL) OR (kind='skill' AND skill_id IS NOT NULL)),
  FOREIGN KEY(installation_id,claim_id) REFERENCES knowledge_claims(installation_id,claim_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,wiki_id) REFERENCES memory_wikis(installation_id,wiki_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE, 
  claim_version_id UUID, wiki_version_id UUID, skill_version_id UUID,
  version_id UUID GENERATED ALWAYS AS (COALESCE(claim_version_id,wiki_version_id,skill_version_id)) STORED,
  CHECK(num_nonnulls(claim_version_id,wiki_version_id,skill_version_id)=1),
  CHECK((claim_id IS NOT NULL)=(claim_version_id IS NOT NULL) AND (wiki_id IS NOT NULL)=(wiki_version_id IS NOT NULL)
    AND (skill_id IS NOT NULL)=(skill_version_id IS NOT NULL)),
  FOREIGN KEY(installation_id,claim_id,claim_version_id) REFERENCES knowledge_versions(installation_id,claim_id,version_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,wiki_id,wiki_version_id) REFERENCES memory_wiki_versions(installation_id,wiki_id,wiki_version_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,skill_id,skill_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE, path TEXT NOT NULL CHECK(char_length(path) BETWEEN 1 AND 512
  AND path LIKE '.pocketctl/knowledge/%' AND path !~ '(^|/)\.\.?(/|$)' AND strpos(path,chr(92))=0), base_revision BIGINT NOT NULL CHECK(base_revision>0),
      source_digest TEXT NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'), content_hash TEXT NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'), file_hash TEXT NOT NULL CHECK(file_hash ~ '^[0-9a-f]{64}$'),
      base_document JSONB NOT NULL CHECK(jsonb_typeof(base_document)='object' AND octet_length(base_document::text)<=2097152),
      field_map JSONB NOT NULL CHECK(jsonb_typeof(field_map)='object' AND octet_length(field_map::text)<=262144),
      PRIMARY KEY(installation_id,export_id,binding_id), UNIQUE(installation_id,export_id,path),
      UNIQUE(installation_id,connection_id,export_id,binding_id,kind,asset_id,version_id,path),
      FOREIGN KEY(installation_id,connection_id,binding_id,kind,asset_id)
        REFERENCES memory_git_asset_bindings(installation_id,connection_id,binding_id,kind,asset_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE
    );
CREATE FUNCTION memory_git_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'git_snapshot_immutable'; END $$;
CREATE TRIGGER memory_git_snapshots_immutable BEFORE UPDATE ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_snapshot_assets_immutable BEFORE UPDATE ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE FUNCTION memory_git_snapshot_asset_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE created BIGINT;
      BEGIN
        SELECT created_transaction INTO created FROM memory_git_snapshots
          WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id AND export_id=NEW.export_id;
        IF created IS NOT NULL AND created<>txid_current() THEN RAISE EXCEPTION 'git_snapshot_immutable'; END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_git_snapshot_asset_insert BEFORE INSERT ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_asset_insert();
CREATE FUNCTION memory_git_snapshot_complete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM memory_git_snapshots s WHERE s.export_id=NEW.export_id
          AND s.asset_count<>(SELECT COUNT(*) FROM memory_git_snapshot_assets a WHERE a.installation_id=s.installation_id AND a.export_id=s.export_id))
          THEN RAISE EXCEPTION 'git_snapshot_incomplete'; END IF;
        RETURN NULL;
      END $$;
CREATE CONSTRAINT TRIGGER memory_git_snapshot_complete AFTER INSERT ON memory_git_snapshots DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_complete();
CREATE FUNCTION memory_git_snapshot_remove_incomplete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN DELETE FROM memory_git_snapshots WHERE installation_id=OLD.installation_id AND export_id=OLD.export_id; RETURN OLD; END $$;
CREATE TRIGGER memory_git_snapshot_remove_incomplete AFTER DELETE ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_remove_incomplete();
CREATE TABLE memory_git_revision_links (
      link_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, binding_id UUID NOT NULL,
      
  kind TEXT NOT NULL CHECK(kind IN('claim','rule','wiki','skill')),
  claim_id UUID, wiki_id UUID, skill_id UUID,
  asset_id UUID GENERATED ALWAYS AS (COALESCE(claim_id,wiki_id,skill_id)) STORED,
  CHECK(num_nonnulls(claim_id,wiki_id,skill_id)=1),
  CHECK((kind IN('claim','rule') AND claim_id IS NOT NULL) OR (kind='wiki' AND wiki_id IS NOT NULL) OR (kind='skill' AND skill_id IS NOT NULL)),
  FOREIGN KEY(installation_id,claim_id) REFERENCES knowledge_claims(installation_id,claim_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,wiki_id) REFERENCES memory_wikis(installation_id,wiki_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,skill_id) REFERENCES memory_skills(installation_id,skill_id) ON DELETE CASCADE, 
  claim_version_id UUID, wiki_version_id UUID, skill_version_id UUID,
  version_id UUID GENERATED ALWAYS AS (COALESCE(claim_version_id,wiki_version_id,skill_version_id)) STORED,
  CHECK(num_nonnulls(claim_version_id,wiki_version_id,skill_version_id)=1),
  CHECK((claim_id IS NOT NULL)=(claim_version_id IS NOT NULL) AND (wiki_id IS NOT NULL)=(wiki_version_id IS NOT NULL)
    AND (skill_id IS NOT NULL)=(skill_version_id IS NOT NULL)),
  FOREIGN KEY(installation_id,claim_id,claim_version_id) REFERENCES knowledge_versions(installation_id,claim_id,version_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,wiki_id,wiki_version_id) REFERENCES memory_wiki_versions(installation_id,wiki_id,wiki_version_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,skill_id,skill_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE, path TEXT NOT NULL CHECK(char_length(path) BETWEEN 1 AND 512
  AND path LIKE '.pocketctl/knowledge/%' AND path !~ '(^|/)\.\.?(/|$)' AND strpos(path,chr(92))=0),
      commit_sha TEXT NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      tree_sha TEXT NOT NULL CHECK(tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      direction TEXT NOT NULL CHECK(direction IN('export','import')), export_id UUID, proposal_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK((direction='export' AND export_id IS NOT NULL AND proposal_id IS NULL) OR (direction='import' AND proposal_id IS NOT NULL AND export_id IS NULL)),
      UNIQUE(installation_id,connection_id,commit_sha,path,direction),
      FOREIGN KEY(installation_id,connection_id,binding_id,kind,asset_id)
        REFERENCES memory_git_asset_bindings(installation_id,connection_id,binding_id,kind,asset_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id,binding_id,kind,asset_id,version_id,path)
        REFERENCES memory_git_snapshot_assets(installation_id,connection_id,export_id,binding_id,kind,asset_id,version_id,path) ON DELETE CASCADE
    );
INSERT INTO memory_schema_migrations(version) VALUES (39);
COMMIT;

BEGIN;
CREATE TABLE memory_git_runs (
      run_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, generation BIGINT NOT NULL CHECK(generation>0),
      direction TEXT NOT NULL CHECK(direction IN('export','import')), mode TEXT NOT NULL CHECK(mode IN('shadow','enabled')),
      outcome_kind TEXT NOT NULL CHECK(outcome_kind IN('fixture','shadow','consented_mpc','natural')),
      state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN('queued','preview','snapshot_ready','awaiting_approval','dispatching','pr_open','merged','closed',
        'received','verified','planned','awaiting_review','conflicted','awaiting_identity','applied','authorization_stale','reconciling','cancelled','invalidated','dead')),
      membership_id UUID NOT NULL, membership_revision BIGINT NOT NULL CHECK(membership_revision>0),
      authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0), config_version BIGINT NOT NULL CHECK(config_version>0),
      request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), export_id UUID, job_id UUID,
      http_attempts INTEGER NOT NULL DEFAULT 0 CHECK(http_attempts BETWEEN 0 AND 128),
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 5),
      byte_count BIGINT NOT NULL DEFAULT 0 CHECK(byte_count>=0), next_attempt_at TIMESTAMPTZ,
      error_code TEXT CHECK(error_code ~ '^[a-z_]{1,64}$'), dry_run_result JSONB, result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '24 hours', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(mode<>'shadow' OR state NOT IN('dispatching','pr_open','merged','applied')),
      UNIQUE(installation_id,connection_id,run_id), UNIQUE(installation_id,connection_id,generation,request_hash), FOREIGN KEY(installation_id,connection_id) REFERENCES memory_git_connections(installation_id,connection_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,job_id) REFERENCES memory_jobs(installation_id,job_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(job_id) REFERENCES memory_jobs(job_id) ON DELETE SET NULL
    );
CREATE UNIQUE INDEX memory_git_one_dispatch ON memory_git_runs(installation_id,connection_id) WHERE state IN('dispatching','reconciling');
CREATE TABLE memory_git_inbox (
      inbox_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL,
      event_id TEXT NOT NULL CHECK(char_length(event_id) BETWEEN 1 AND 256), payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
      state TEXT NOT NULL DEFAULT 'received' CHECK(state IN('received','verified','duplicate','rejected','processed','invalidated','dead')),
      run_id UUID, job_id UUID, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id,event_id), FOREIGN KEY(installation_id,connection_id) REFERENCES memory_git_connections(installation_id,connection_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_runs(installation_id,connection_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,job_id) REFERENCES memory_jobs(installation_id,job_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(job_id) REFERENCES memory_jobs(job_id) ON DELETE SET NULL
    );
CREATE TABLE memory_git_outbox (
      outbox_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, run_id UUID NOT NULL, export_id UUID NOT NULL,
      generation BIGINT NOT NULL CHECK(generation>0), operation TEXT NOT NULL CHECK(operation IN('commit','branch','pull_request','reconcile')),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','dispatching','reconciling','completed','cancelled','invalidated','dead')),
      expected_head TEXT CHECK(expected_head ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      expected_tree TEXT CHECK(expected_tree ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      remote_commit TEXT, remote_branch TEXT, remote_pr_id TEXT, next_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id,export_id,operation),
      FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_runs(installation_id,connection_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE
    );
CREATE TABLE memory_git_import_proposals (
      proposal_id UUID PRIMARY KEY, installation_id UUID NOT NULL, connection_id UUID NOT NULL, export_id UUID NOT NULL, run_id UUID,
      generation BIGINT NOT NULL CHECK(generation>0), revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
      state TEXT NOT NULL DEFAULT 'received' CHECK(state IN('received','verified','planned','awaiting_review','conflicted','awaiting_identity','applied','authorization_stale','cancelled','invalidated','dead','noop')),
      base_revision BIGINT NOT NULL CHECK(base_revision>0), base_hash TEXT NOT NULL CHECK(base_hash ~ '^[0-9a-f]{64}$'), local_hash TEXT NOT NULL CHECK(local_hash ~ '^[0-9a-f]{64}$'), proposed_hash TEXT NOT NULL CHECK(proposed_hash ~ '^[0-9a-f]{64}$'), policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
      proposed_document JSONB NOT NULL CHECK(jsonb_typeof(proposed_document)='object' AND octet_length(proposed_document::text)<=2097152),
      provider_actor_id TEXT CHECK(char_length(provider_actor_id) BETWEEN 1 AND 256), membership_id UUID, membership_revision BIGINT CHECK(membership_revision>0),
      authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0), head_commit TEXT NOT NULL CHECK(head_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,connection_id,proposal_id), UNIQUE(installation_id,proposal_id),
      UNIQUE(installation_id,proposal_id,revision,base_revision,proposed_hash,policy_hash),
      FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_runs(installation_id,connection_id,run_id) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE
    );
CREATE TABLE memory_git_conflicts (
      conflict_id UUID PRIMARY KEY, installation_id UUID NOT NULL, proposal_id UUID NOT NULL, proposal_revision BIGINT NOT NULL CHECK(proposal_revision>0),
      field TEXT NOT NULL CHECK(char_length(field) BETWEEN 1 AND 512),
      reason TEXT NOT NULL CHECK(reason IN('both_modified','delete_edit','rename_collision','locked')),
      resolution JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(installation_id,proposal_id,proposal_revision,field),
      FOREIGN KEY(installation_id,proposal_id) REFERENCES memory_git_import_proposals(installation_id,proposal_id) ON DELETE CASCADE
    );
CREATE TABLE memory_git_review_decisions (
      decision_id UUID PRIMARY KEY, installation_id UUID NOT NULL, proposal_id UUID NOT NULL,
      proposal_revision BIGINT NOT NULL CHECK(proposal_revision>0), base_revision BIGINT NOT NULL CHECK(base_revision>0),
      proposed_hash TEXT NOT NULL CHECK(proposed_hash ~ '^[0-9a-f]{64}$'), policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
      membership_id UUID NOT NULL, membership_revision BIGINT NOT NULL CHECK(membership_revision>0), authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
      decision TEXT NOT NULL CHECK(decision IN('approve','request_changes','reject')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(installation_id,proposal_id,proposal_revision,membership_id),
      FOREIGN KEY(installation_id,proposal_id,proposal_revision,base_revision,proposed_hash,policy_hash)
        REFERENCES memory_git_import_proposals(installation_id,proposal_id,revision,base_revision,proposed_hash,policy_hash) ON DELETE CASCADE,
      FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE
    );
CREATE FUNCTION memory_git_proposal_edit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.proposed_document,NEW.proposed_hash,NEW.base_revision,NEW.base_hash,NEW.local_hash,NEW.policy_hash,NEW.head_commit)
          IS DISTINCT FROM (OLD.proposed_document,OLD.proposed_hash,OLD.base_revision,OLD.base_hash,OLD.local_hash,OLD.policy_hash,OLD.head_commit)
          AND NEW.revision<=OLD.revision THEN RAISE EXCEPTION 'git_proposal_revision_required'; END IF;
        IF NEW.revision<>OLD.revision THEN
          IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'git_proposal_revision_required'; END IF;
          DELETE FROM memory_git_review_decisions WHERE installation_id=OLD.installation_id AND proposal_id=OLD.proposal_id;
          DELETE FROM memory_git_conflicts WHERE installation_id=OLD.installation_id AND proposal_id=OLD.proposal_id;
          IF NEW.state='applied' THEN RAISE EXCEPTION 'git_proposal_review_required'; END IF;
        END IF;
        RETURN NEW;
      END $$;
CREATE TRIGGER memory_git_proposal_edit BEFORE UPDATE ON memory_git_import_proposals FOR EACH ROW EXECUTE FUNCTION memory_git_proposal_edit();
ALTER TABLE memory_git_revision_links ADD CONSTRAINT memory_git_revision_proposal_fk FOREIGN KEY(installation_id,connection_id,proposal_id)
      REFERENCES memory_git_import_proposals(installation_id,connection_id,proposal_id) ON DELETE CASCADE;
CREATE TABLE memory_git_audit_events (
      event_id UUID PRIMARY KEY, installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      connection_id UUID, export_id UUID, proposal_id UUID, run_id UUID, membership_id UUID,
      membership_revision BIGINT CHECK(membership_revision>0), authorization_epoch BIGINT CHECK(authorization_epoch>0),
      old_version_id UUID, new_version_id UUID, content_hash TEXT CHECK(content_hash ~ '^[0-9a-f]{64}$'),
      action TEXT NOT NULL CHECK(action IN('connection','mapping','snapshot','import','review','apply','dispatch','reconcile','invalidate','purge')),
      outcome TEXT NOT NULL CHECK(outcome IN('allowed','denied','noop','invalidated','pending')),
      reason_code TEXT NOT NULL CHECK(reason_code IN('ok','forbidden','invalid_request','not_found','generation_conflict','authorization_stale',
        'source_invalid','identity_unknown','revision_conflict','policy_changed','self_review_denied','feature_disabled','remote_cleanup_pending','purged')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
CREATE INDEX memory_git_audit_scope_time ON memory_git_audit_events(installation_id,created_at,event_id);
CREATE TRIGGER memory_git_revision_links_immutable BEFORE UPDATE ON memory_git_revision_links FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_review_decisions_immutable BEFORE UPDATE ON memory_git_review_decisions FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_audit_events_immutable BEFORE UPDATE ON memory_git_audit_events FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
INSERT INTO memory_schema_migrations(version) VALUES (40);
COMMIT;

BEGIN;
ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check;
ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check CHECK(job_type IN
    ('project_feed','compile_episode','snapshot_reconcile','session_purge','installation_purge','report_status','report_usage',
    'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims','recompile_extraction_policy',
    'compile_context_shadow','record_context_delivery','invalidate_context_packs','expire_promotion_candidates','index_shared_claim',
    'invalidate_scope_authorization','transfer_scope_claims','parse_code_snapshot','build_wiki','extract_skill_candidate',
    'git_ingest','git_export','git_reconcile'));
CREATE TABLE memory_git_attestation_keys(
    key_id TEXT PRIMARY KEY CHECK(char_length(key_id) BETWEEN 1 AND 128),
    public_key_spki BYTEA NOT NULL CHECK(octet_length(public_key_spki) BETWEEN 1 AND 256),
    state TEXT NOT NULL CHECK(state IN('active','retired','revoked')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE FUNCTION memory_git_key_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.key_id<>OLD.key_id OR NEW.public_key_spki<>OLD.public_key_spki OR NEW.created_at<>OLD.created_at
      OR (OLD.state='revoked' AND NEW.state<>'revoked') OR (OLD.state='retired' AND NEW.state='active')
      THEN RAISE EXCEPTION 'git_key_immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER memory_git_key_transition BEFORE UPDATE ON memory_git_attestation_keys FOR EACH ROW EXECUTE FUNCTION memory_git_key_transition();
CREATE TABLE memory_git_snapshot_keys(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,export_id UUID NOT NULL,key_id TEXT NOT NULL,
    PRIMARY KEY(installation_id,connection_id,export_id),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
    FOREIGN KEY(key_id) REFERENCES memory_git_attestation_keys(key_id) ON DELETE RESTRICT);
CREATE INDEX memory_git_snapshot_signing_key ON memory_git_snapshot_keys(key_id);
CREATE TRIGGER memory_git_snapshot_keys_immutable BEFORE UPDATE ON memory_git_snapshot_keys FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_snapshot_keys_created BEFORE INSERT ON memory_git_snapshot_keys FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_asset_insert();
ALTER TABLE memory_git_connections ADD COLUMN next_poll_at TIMESTAMPTZ;
CREATE TABLE memory_git_sync_principals(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,export_id UUID NOT NULL,generation BIGINT NOT NULL,
    membership_id UUID NOT NULL,grant_facts JSONB NOT NULL CHECK(jsonb_typeof(grant_facts)='object' AND octet_length(grant_facts::text)<=65536),
    authorization_stamp JSONB NOT NULL CHECK(jsonb_typeof(authorization_stamp)='object' AND octet_length(authorization_stamp::text)<=4096),
    PRIMARY KEY(installation_id,connection_id,export_id),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE);
ALTER TABLE memory_git_runs ADD COLUMN grant_facts JSONB CHECK(jsonb_typeof(grant_facts)='object' AND octet_length(grant_facts::text)<=65536),
    ADD COLUMN change_number TEXT CHECK(change_number ~ '^[1-9][0-9]{0,14}$'),
    ADD COLUMN trigger_source TEXT CHECK(trigger_source IN('webhook','poll','preview','export')),
    ADD COLUMN merge_commit TEXT CHECK(merge_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    ADD COLUMN tree_sha TEXT CHECK(tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    ADD COLUMN provider_actor_id TEXT CHECK(char_length(provider_actor_id) BETWEEN 1 AND 256);
CREATE TABLE memory_git_run_receipts(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,generation BIGINT NOT NULL,run_id UUID NOT NULL,canonical_run_id UUID,request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
    admission_hash TEXT NOT NULL CHECK(admission_hash ~ '^[0-9a-f]{64}$'),observation INTEGER NOT NULL DEFAULT 0 CHECK(observation>=0),
    outcome_kind TEXT NOT NULL CHECK(outcome_kind IN('fixture','shadow','consented_mpc','natural')),
    state TEXT NOT NULL CHECK(state IN('received','verified','planned','duplicate','rejected','cancelled','invalidated','dead')),
    eligible BOOLEAN NOT NULL DEFAULT FALSE,unfinished BOOLEAN NOT NULL DEFAULT TRUE,
    failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 5),attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 128),
    reason_code TEXT CHECK(reason_code ~ '^[a-z_]{1,64}$'),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,run_id),UNIQUE(installation_id,connection_id,generation,request_hash),
    UNIQUE(installation_id,connection_id,generation,admission_hash,observation),
    FOREIGN KEY(installation_id,canonical_run_id) REFERENCES memory_git_run_receipts(installation_id,run_id));
CREATE TABLE memory_git_merge_receipts(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,generation BIGINT NOT NULL,commit_sha TEXT NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    run_id UUID NOT NULL,tree_sha TEXT NOT NULL CHECK(tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    PRIMARY KEY(installation_id,connection_id,generation,commit_sha),
    FOREIGN KEY(installation_id,run_id) REFERENCES memory_git_run_receipts(installation_id,run_id) ON DELETE CASCADE);
CREATE TABLE memory_git_request_reservations(
    reservation_id UUID PRIMARY KEY,installation_id UUID NOT NULL,run_id UUID NOT NULL,attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 128),
    job_id UUID NOT NULL,claim_epoch BIGINT NOT NULL,operation TEXT NOT NULL CHECK(operation IN('merge','commit','tree','poll')),
    state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','responded','failed','aborted')),counts_failure BOOLEAN NOT NULL DEFAULT FALSE,
    response_bytes BIGINT NOT NULL DEFAULT 0 CHECK(response_bytes>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(installation_id,run_id,attempt),
    FOREIGN KEY(installation_id,run_id) REFERENCES memory_git_run_receipts(installation_id,run_id) ON DELETE CASCADE);
CREATE FUNCTION memory_git_cancel_connection_runs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (NEW.generation,NEW.state,NEW.sync_mode) IS DISTINCT FROM (OLD.generation,OLD.state,OLD.sync_mode) THEN
      UPDATE memory_git_run_receipts SET state='invalidated',reason_code='connection_changed',updated_at=NOW()
        WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id AND unfinished;
      UPDATE memory_git_runs SET state='invalidated',error_code='connection_changed' WHERE installation_id=NEW.installation_id
        AND connection_id=NEW.connection_id AND state NOT IN('planned','applied','dead','cancelled','invalidated');
      UPDATE memory_jobs SET state='dead',claim_expires_at=NULL,last_error_code='connection_changed' WHERE installation_id=NEW.installation_id
        AND job_id IN(SELECT job_id FROM memory_git_runs WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id AND state='invalidated')
        AND state IN('pending','running');
      PERFORM pg_notify('memory_git_cancel',NEW.connection_id::text);
    END IF; RETURN NEW; END $$;
CREATE TRIGGER memory_git_cancel_connection AFTER UPDATE ON memory_git_connections FOR EACH ROW EXECUTE FUNCTION memory_git_cancel_connection_runs();
CREATE FUNCTION memory_git_cancel_member_runs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (NEW.state,NEW.membership_revision,NEW.roles,NEW.valid_until) IS DISTINCT FROM (OLD.state,OLD.membership_revision,OLD.roles,OLD.valid_until) THEN
      UPDATE memory_git_run_receipts p SET state='invalidated',reason_code='authorization_stale',updated_at=NOW()
        FROM memory_git_runs r WHERE p.installation_id=r.installation_id AND p.run_id=r.run_id AND r.installation_id=NEW.installation_id
        AND r.membership_id=NEW.membership_id AND p.unfinished;
      UPDATE memory_git_runs SET state='invalidated',error_code='authorization_stale' WHERE installation_id=NEW.installation_id
        AND membership_id=NEW.membership_id AND state NOT IN('planned','applied','dead','cancelled','invalidated');
      UPDATE memory_jobs SET state='dead',claim_expires_at=NULL,last_error_code='authorization_stale' WHERE installation_id=NEW.installation_id
        AND job_id IN(SELECT job_id FROM memory_git_runs WHERE installation_id=NEW.installation_id AND membership_id=NEW.membership_id AND state='invalidated')
        AND state IN('pending','running');
      PERFORM pg_notify('memory_git_cancel','member:' || NEW.installation_id::text || ':' || NEW.membership_id::text);
    END IF; RETURN NEW; END $$;
CREATE TRIGGER memory_git_cancel_member AFTER UPDATE ON memory_scope_memberships FOR EACH ROW EXECUTE FUNCTION memory_git_cancel_member_runs();
INSERT INTO memory_schema_migrations(version) VALUES (41);
COMMIT;

BEGIN;
CREATE FUNCTION memory_git_key_statement_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('memory:git:attestation-keys',0)); RETURN NULL; END $$;
CREATE TRIGGER memory_git_key_statement_gate BEFORE INSERT OR UPDATE OR DELETE ON memory_git_attestation_keys
    FOR EACH STATEMENT EXECUTE FUNCTION memory_git_key_statement_gate();
ALTER TABLE memory_git_request_reservations DROP CONSTRAINT memory_git_request_reservations_operation_check;
ALTER TABLE memory_git_request_reservations ADD CONSTRAINT memory_git_request_reservations_operation_check
    CHECK(operation IN('repository','merge','commit','tree','poll','write_tree','write_commit','write_branch','write_file','write_pull_request','reconcile'));
ALTER TABLE memory_git_outbox ADD CONSTRAINT memory_git_outbox_tenant_id UNIQUE(installation_id,connection_id,outbox_id);
ALTER TABLE memory_git_outbox ADD COLUMN description_hash TEXT CHECK(description_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN expected_commit TEXT CHECK(expected_commit ~ '^[0-9a-f]{40}$');
CREATE TABLE memory_git_outbox_steps(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,outbox_id UUID NOT NULL,step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 511),
    operation TEXT NOT NULL CHECK(operation IN('tree','commit','branch','file','pull_request')),
    state TEXT NOT NULL CHECK(state IN('pending','dispatching','reconciling','completed','conflicted')),
    path TEXT CHECK(octet_length(path)<=512 AND path LIKE '.pocketctl/knowledge/%'),
    expected_head TEXT CHECK(expected_head ~ '^[0-9a-f]{40}$'),expected_blob TEXT CHECK(expected_blob ~ '^[0-9a-f]{40}$'),
    expected_tree TEXT CHECK(expected_tree ~ '^[0-9a-f]{40}$'),expected_commit TEXT CHECK(expected_commit ~ '^[0-9a-f]{40}$'),
    remote_sha TEXT CHECK(remote_sha ~ '^[0-9a-f]{40}$'),remote_tree TEXT CHECK(remote_tree ~ '^[0-9a-f]{40}$'),
    remote_number TEXT CHECK(remote_number ~ '^[1-9][0-9]{0,14}$'),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,connection_id,outbox_id,step),
    FOREIGN KEY(installation_id,connection_id,outbox_id) REFERENCES memory_git_outbox(installation_id,connection_id,outbox_id) ON DELETE CASCADE);
INSERT INTO memory_schema_migrations(version) VALUES (42);
COMMIT;

BEGIN;
CREATE TABLE memory_git_resolution_authors(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,proposal_revision BIGINT NOT NULL CHECK(proposal_revision>0),
    resolver_membership_id UUID NOT NULL,resolver_membership_revision BIGINT NOT NULL CHECK(resolver_membership_revision>0),
  resolver_authorization_epoch BIGINT NOT NULL CHECK(resolver_authorization_epoch>0),
  FOREIGN KEY(installation_id,resolver_membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE,document_hash TEXT NOT NULL CHECK(document_hash ~ '^[0-9a-f]{64}$'),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,proposal_id,proposal_revision),FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_import_proposals(installation_id,connection_id,proposal_id) ON DELETE CASCADE);
CREATE TABLE memory_git_original_authors(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,run_id UUID NOT NULL,
    provider_actor_id TEXT NOT NULL CHECK(char_length(provider_actor_id) BETWEEN 1 AND 256),author_membership_id UUID NOT NULL,author_membership_revision BIGINT NOT NULL CHECK(author_membership_revision>0),
  author_authorization_epoch BIGINT NOT NULL CHECK(author_authorization_epoch>0),
  FOREIGN KEY(installation_id,author_membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE,
    head_commit TEXT NOT NULL CHECK(head_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    tree_sha TEXT NOT NULL CHECK(tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,proposal_id),FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_import_proposals(installation_id,connection_id,proposal_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_runs(installation_id,connection_id,run_id) ON DELETE CASCADE);
ALTER TABLE memory_review_policy_sets ADD CONSTRAINT memory_git_policy_set_identity UNIQUE(installation_id,policy_id);
ALTER TABLE memory_review_policy_versions ADD CONSTRAINT memory_git_policy_version_identity UNIQUE(policy_id,policy_version_id);
ALTER TABLE knowledge_evidence ADD CONSTRAINT memory_git_evidence_version_identity UNIQUE(installation_id,evidence_id,version_id);
CREATE TABLE memory_git_governed_revisions(
    revision_id UUID PRIMARY KEY,installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,
    proposal_revision BIGINT NOT NULL CHECK(proposal_revision>0),base_revision BIGINT NOT NULL CHECK(base_revision>0),
    kind TEXT NOT NULL CHECK(kind IN('claim','rule','wiki','skill')),claim_id UUID,wiki_id UUID,skill_id UUID,
    claim_version_id UUID,wiki_version_id UUID,skill_version_id UUID,
    CHECK(num_nonnulls(claim_id,wiki_id,skill_id)=1),CHECK(num_nonnulls(claim_version_id,wiki_version_id,skill_version_id)=1),
    CHECK((kind IN('claim','rule') AND claim_id IS NOT NULL AND claim_version_id IS NOT NULL) OR
      (kind='wiki' AND wiki_id IS NOT NULL AND wiki_version_id IS NOT NULL) OR (kind='skill' AND skill_id IS NOT NULL AND skill_version_id IS NOT NULL)),
    base_hash TEXT NOT NULL CHECK(base_hash ~ '^[0-9a-f]{64}$'),memory_hash TEXT NOT NULL CHECK(memory_hash ~ '^[0-9a-f]{64}$'),git_hash TEXT NOT NULL CHECK(git_hash ~ '^[0-9a-f]{64}$'),proposed_hash TEXT NOT NULL CHECK(proposed_hash ~ '^[0-9a-f]{64}$'),policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
    review_policy_id UUID NOT NULL,review_policy_version_id UUID NOT NULL,
    parent_installation_id UUID,parent_policy_id UUID,parent_policy_version_id UUID,
    CHECK(num_nonnulls(parent_installation_id,parent_policy_id,parent_policy_version_id) IN(0,3)),
    authorization_epoch BIGINT NOT NULL CHECK(authorization_epoch>0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(installation_id,revision_id),UNIQUE(installation_id,proposal_id,proposal_revision),FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_import_proposals(installation_id,connection_id,proposal_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,proposal_id) REFERENCES memory_git_original_authors(installation_id,proposal_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,claim_id,claim_version_id) REFERENCES knowledge_versions(installation_id,claim_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,wiki_id,wiki_version_id) REFERENCES memory_wiki_versions(installation_id,wiki_id,wiki_version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,skill_id,skill_version_id) REFERENCES memory_skill_versions(installation_id,skill_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,review_policy_id) REFERENCES memory_review_policy_sets(installation_id,policy_id),
    FOREIGN KEY(review_policy_id,review_policy_version_id) REFERENCES memory_review_policy_versions(policy_id,policy_version_id),
    FOREIGN KEY(parent_installation_id,parent_policy_id) REFERENCES memory_review_policy_sets(installation_id,policy_id),
    FOREIGN KEY(parent_policy_id,parent_policy_version_id) REFERENCES memory_review_policy_versions(policy_id,policy_version_id));
CREATE TABLE memory_git_revision_evidence(
    installation_id UUID NOT NULL,revision_id UUID NOT NULL,evidence_id UUID NOT NULL,version_id UUID NOT NULL,evidence_hash TEXT NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY(installation_id,revision_id,evidence_id),
    FOREIGN KEY(installation_id,revision_id) REFERENCES memory_git_governed_revisions(installation_id,revision_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,evidence_id,version_id) REFERENCES knowledge_evidence(installation_id,evidence_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE);
CREATE TABLE memory_git_revision_reviews(
    decision_id UUID PRIMARY KEY,installation_id UUID NOT NULL,revision_id UUID NOT NULL,reviewer_membership_id UUID NOT NULL,reviewer_membership_revision BIGINT NOT NULL CHECK(reviewer_membership_revision>0),
  reviewer_authorization_epoch BIGINT NOT NULL CHECK(reviewer_authorization_epoch>0),
  FOREIGN KEY(installation_id,reviewer_membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK(decision IN('approve','request_changes','reject')),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(installation_id,revision_id,reviewer_membership_id),UNIQUE(installation_id,decision_id),
    FOREIGN KEY(installation_id,revision_id) REFERENCES memory_git_governed_revisions(installation_id,revision_id) ON DELETE CASCADE);
ALTER TABLE memory_git_revision_links ADD CONSTRAINT memory_git_link_identity UNIQUE(installation_id,connection_id,link_id,binding_id);
CREATE TABLE memory_git_import_outcomes(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,proposal_revision BIGINT NOT NULL,
    revision_id UUID,link_id UUID NOT NULL,binding_id UUID NOT NULL,publisher_membership_id UUID NOT NULL,publisher_membership_revision BIGINT NOT NULL CHECK(publisher_membership_revision>0),
  publisher_authorization_epoch BIGINT NOT NULL CHECK(publisher_authorization_epoch>0),
  FOREIGN KEY(installation_id,publisher_membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE,
    outcome TEXT NOT NULL CHECK(outcome IN('published','draft_appended','linked','revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,proposal_id),FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_import_proposals(installation_id,connection_id,proposal_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,revision_id) REFERENCES memory_git_governed_revisions(installation_id,revision_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,connection_id,link_id,binding_id) REFERENCES memory_git_revision_links(installation_id,connection_id,link_id,binding_id) ON DELETE CASCADE);
CREATE TABLE memory_git_confirmed_bases(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,binding_id UUID NOT NULL,export_id UUID NOT NULL,link_id UUID NOT NULL,
    sequence BIGINT GENERATED ALWAYS AS IDENTITY,git_hash TEXT NOT NULL CHECK(git_hash ~ '^[0-9a-f]{64}$'),
    git_document JSONB NOT NULL CHECK(jsonb_typeof(git_document)='object' AND octet_length(git_document::text)<=2097152),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(installation_id,connection_id,binding_id,link_id),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,connection_id,link_id,binding_id) REFERENCES memory_git_revision_links(installation_id,connection_id,link_id,binding_id) ON DELETE CASCADE);
CREATE TABLE memory_git_claim_authority(
    installation_id UUID NOT NULL,claim_id UUID NOT NULL,version_id UUID NOT NULL,revision_id UUID NOT NULL,publisher_membership_id UUID NOT NULL,publisher_membership_revision BIGINT NOT NULL CHECK(publisher_membership_revision>0),
  publisher_authorization_epoch BIGINT NOT NULL CHECK(publisher_authorization_epoch>0),
  FOREIGN KEY(installation_id,publisher_membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE,
    PRIMARY KEY(installation_id,version_id),
    FOREIGN KEY(installation_id,claim_id,version_id) REFERENCES knowledge_versions(installation_id,claim_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,revision_id) REFERENCES memory_git_governed_revisions(installation_id,revision_id) ON DELETE CASCADE);
CREATE TABLE memory_git_claim_authority_decisions(
    installation_id UUID NOT NULL,version_id UUID NOT NULL,decision_id UUID NOT NULL,
    PRIMARY KEY(installation_id,version_id,decision_id),
    FOREIGN KEY(installation_id,version_id) REFERENCES memory_git_claim_authority(installation_id,version_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,decision_id) REFERENCES memory_git_revision_reviews(installation_id,decision_id) ON DELETE CASCADE);
CREATE TRIGGER memory_git_resolution_authors_immutable BEFORE UPDATE ON memory_git_resolution_authors FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_original_authors_immutable BEFORE UPDATE ON memory_git_original_authors FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_governed_revisions_immutable BEFORE UPDATE ON memory_git_governed_revisions FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_revision_evidence_immutable BEFORE UPDATE ON memory_git_revision_evidence FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_revision_reviews_immutable BEFORE UPDATE ON memory_git_revision_reviews FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_import_outcomes_immutable BEFORE UPDATE ON memory_git_import_outcomes FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_confirmed_bases_immutable BEFORE UPDATE ON memory_git_confirmed_bases FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_claim_authority_immutable BEFORE UPDATE ON memory_git_claim_authority FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_claim_authority_decisions_immutable BEFORE UPDATE ON memory_git_claim_authority_decisions FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
INSERT INTO memory_schema_migrations(version) VALUES (43);
COMMIT;

BEGIN;
CREATE TABLE memory_git_tombstones(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,identity_id UUID NOT NULL,kind TEXT NOT NULL CHECK(kind IN('export','claim','rule','wiki','skill')),
    generation BIGINT NOT NULL CHECK(generation>0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(installation_id,connection_id,kind,identity_id));
CREATE TABLE memory_git_lifecycle_epochs(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,transaction_id BIGINT NOT NULL,generation BIGINT NOT NULL,
    PRIMARY KEY(installation_id,connection_id,transaction_id));
CREATE TABLE memory_git_proposal_identities(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,proposal_id UUID NOT NULL,export_id UUID NOT NULL,
    PRIMARY KEY(installation_id,connection_id,proposal_id),UNIQUE(installation_id,proposal_id));
INSERT INTO memory_git_proposal_identities SELECT installation_id,connection_id,proposal_id,export_id FROM memory_git_import_proposals;
CREATE FUNCTION memory_git_keep_proposal_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO memory_git_proposal_identities VALUES(NEW.installation_id,NEW.connection_id,NEW.proposal_id,NEW.export_id);
    RETURN NEW; END $$;
CREATE TRIGGER memory_git_keep_proposal_identity AFTER INSERT ON memory_git_import_proposals FOR EACH ROW EXECUTE FUNCTION memory_git_keep_proposal_identity();
DO $$ DECLARE n TEXT; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='memory_git_original_authors'::regclass AND confrelid='memory_git_import_proposals'::regclass AND contype='f'; EXECUTE format('ALTER TABLE memory_git_original_authors DROP CONSTRAINT %I',n); END $$;
ALTER TABLE memory_git_original_authors ADD FOREIGN KEY(installation_id,connection_id,proposal_id)
      REFERENCES memory_git_proposal_identities(installation_id,connection_id,proposal_id) ON DELETE CASCADE;
DO $$ DECLARE n TEXT; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='memory_git_resolution_authors'::regclass AND confrelid='memory_git_import_proposals'::regclass AND contype='f'; EXECUTE format('ALTER TABLE memory_git_resolution_authors DROP CONSTRAINT %I',n); END $$;
ALTER TABLE memory_git_resolution_authors ADD FOREIGN KEY(installation_id,connection_id,proposal_id)
      REFERENCES memory_git_proposal_identities(installation_id,connection_id,proposal_id) ON DELETE CASCADE;
DO $$ DECLARE n TEXT; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='memory_git_governed_revisions'::regclass AND confrelid='memory_git_import_proposals'::regclass AND contype='f'; EXECUTE format('ALTER TABLE memory_git_governed_revisions DROP CONSTRAINT %I',n); END $$;
ALTER TABLE memory_git_governed_revisions ADD FOREIGN KEY(installation_id,connection_id,proposal_id)
      REFERENCES memory_git_proposal_identities(installation_id,connection_id,proposal_id) ON DELETE CASCADE;
ALTER TABLE memory_git_run_receipts ADD UNIQUE(installation_id,connection_id,run_id);
DO $$ DECLARE n TEXT; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid='memory_git_original_authors'::regclass AND confrelid='memory_git_runs'::regclass AND contype='f'; EXECUTE format('ALTER TABLE memory_git_original_authors DROP CONSTRAINT %I',n); END $$;
ALTER TABLE memory_git_original_authors ADD FOREIGN KEY(installation_id,connection_id,run_id)
    REFERENCES memory_git_run_receipts(installation_id,connection_id,run_id) ON DELETE CASCADE;
CREATE TABLE memory_git_retained_outcomes(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,export_id UUID NOT NULL,
    proposal_revision BIGINT NOT NULL,generation BIGINT NOT NULL,commit_sha TEXT NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    link_id UUID NOT NULL,version_id UUID NOT NULL,asset_id UUID NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN('published','draft_appended','linked','revoked')),
    PRIMARY KEY(installation_id,proposal_id),
    FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_proposal_identities(installation_id,connection_id,proposal_id) ON DELETE CASCADE);
CREATE TABLE memory_git_remote_cleanup(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,export_id UUID NOT NULL,old_run_id UUID NOT NULL,generation BIGINT NOT NULL,
    provider TEXT NOT NULL CHECK(provider IN('github','gitee','gitlab')),provider_repository_id TEXT NOT NULL,
    target_branch TEXT NOT NULL,target_owner TEXT,target_repository TEXT,target_private BOOLEAN,
    remote_branch TEXT NOT NULL,expected_commit TEXT,expected_tree TEXT,description_hash TEXT,remote_pr_id TEXT,
    cleanup_pending BOOLEAN NOT NULL DEFAULT TRUE,recognized_at TIMESTAMPTZ,recognized_run_id UUID,
    PRIMARY KEY(installation_id,connection_id,export_id),
    CHECK(char_length(target_owner)<=256 AND char_length(target_repository)<=256 AND char_length(remote_pr_id)<=64),
    CHECK(expected_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),CHECK(expected_tree ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    CHECK(description_hash ~ '^[0-9a-f]{64}$'));
ALTER TABLE memory_git_outbox ADD COLUMN target_owner TEXT CHECK(char_length(target_owner) BETWEEN 1 AND 256),
    ADD COLUMN target_repository TEXT CHECK(char_length(target_repository) BETWEEN 1 AND 256),ADD COLUMN target_private BOOLEAN;
CREATE TABLE memory_git_retained_steps(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,export_id UUID NOT NULL,outbox_id UUID NOT NULL,
    step INTEGER NOT NULL CHECK(step BETWEEN 0 AND 511),operation TEXT NOT NULL CHECK(operation IN('tree','commit','branch','file','pull_request')),
    state TEXT NOT NULL CHECK(state IN('pending','dispatching','reconciling','completed','conflicted')),
    expected_head TEXT,expected_blob TEXT,expected_tree TEXT,expected_commit TEXT,remote_sha TEXT,remote_tree TEXT,remote_number TEXT,expected_content_blob TEXT,
    PRIMARY KEY(installation_id,connection_id,outbox_id,step),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_remote_cleanup(installation_id,connection_id,export_id) ON DELETE CASCADE,
    CHECK(expected_head ~ '^[0-9a-f]{40}$'),CHECK(expected_blob ~ '^[0-9a-f]{40}$'),CHECK(expected_tree ~ '^[0-9a-f]{40}$'),
    CHECK(expected_commit ~ '^[0-9a-f]{40}$'),CHECK(remote_sha ~ '^[0-9a-f]{40}$'),CHECK(remote_tree ~ '^[0-9a-f]{40}$'),
    CHECK(remote_number ~ '^[1-9][0-9]{0,14}$'),CHECK(expected_content_blob ~ '^[0-9a-f]{40}$'));
ALTER TABLE memory_git_outbox_steps ADD COLUMN expected_content_blob TEXT CHECK(expected_content_blob ~ '^[0-9a-f]{40}$');
ALTER TABLE memory_git_runs ADD COLUMN recovery_export_id UUID,
    ADD FOREIGN KEY(installation_id,connection_id,recovery_export_id) REFERENCES memory_git_remote_cleanup(installation_id,connection_id,export_id);
ALTER TABLE memory_git_runs DROP CONSTRAINT memory_git_runs_trigger_source_check;
ALTER TABLE memory_git_runs ADD CHECK(trigger_source IN('webhook','poll','preview','export','recovery'));
CREATE TABLE memory_git_snapshot_sources(
    source_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,installation_id UUID NOT NULL,connection_id UUID NOT NULL,export_id UUID NOT NULL,
    evidence_id UUID,version_id UUID,episode_id UUID,repo_snapshot_id UUID,source_snapshot_id UUID,graph_version_id UUID,build_run_id UUID,archive_id UUID,
    CHECK(num_nonnulls(evidence_id,version_id,episode_id,repo_snapshot_id,source_snapshot_id,graph_version_id,build_run_id,archive_id)=1),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,evidence_id) REFERENCES knowledge_evidence(installation_id,evidence_id) ON DELETE CASCADE,FOREIGN KEY(installation_id,version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE,FOREIGN KEY(installation_id,episode_id) REFERENCES work_episodes(installation_id,episode_id) ON DELETE CASCADE,FOREIGN KEY(installation_id,repo_snapshot_id) REFERENCES repo_snapshots(installation_id,repo_snapshot_id) ON DELETE CASCADE,FOREIGN KEY(installation_id,source_snapshot_id) REFERENCES memory_source_snapshots(installation_id,snapshot_id) ON DELETE CASCADE,FOREIGN KEY(installation_id,graph_version_id) REFERENCES memory_code_graph_versions(installation_id,graph_version_id) ON DELETE CASCADE,FOREIGN KEY(installation_id,build_run_id) REFERENCES memory_wiki_build_runs(installation_id,run_id) ON DELETE CASCADE,FOREIGN KEY(installation_id,archive_id) REFERENCES memory_skill_archives(installation_id,archive_id) ON DELETE CASCADE);
CREATE INDEX memory_git_source_evidence_id ON memory_git_snapshot_sources(installation_id,evidence_id) WHERE evidence_id IS NOT NULL;
CREATE INDEX memory_git_source_version_id ON memory_git_snapshot_sources(installation_id,version_id) WHERE version_id IS NOT NULL;
CREATE INDEX memory_git_source_episode_id ON memory_git_snapshot_sources(installation_id,episode_id) WHERE episode_id IS NOT NULL;
CREATE INDEX memory_git_source_repo_snapshot_id ON memory_git_snapshot_sources(installation_id,repo_snapshot_id) WHERE repo_snapshot_id IS NOT NULL;
CREATE INDEX memory_git_source_source_snapshot_id ON memory_git_snapshot_sources(installation_id,source_snapshot_id) WHERE source_snapshot_id IS NOT NULL;
CREATE INDEX memory_git_source_graph_version_id ON memory_git_snapshot_sources(installation_id,graph_version_id) WHERE graph_version_id IS NOT NULL;
CREATE INDEX memory_git_source_build_run_id ON memory_git_snapshot_sources(installation_id,build_run_id) WHERE build_run_id IS NOT NULL;
CREATE INDEX memory_git_source_archive_id ON memory_git_snapshot_sources(installation_id,archive_id) WHERE archive_id IS NOT NULL;
CREATE FUNCTION memory_git_capture_sources() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE evidence UUID;version UUID;archive UUID; BEGIN
    FOR evidence IN SELECT (e->>'evidenceId')::uuid FROM jsonb_array_elements(COALESCE(NEW.base_document->'immutable'->'evidence','[]')) e LOOP
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,evidence_id) VALUES(NEW.installation_id,NEW.connection_id,NEW.export_id,evidence);
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,episode_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,episode_id FROM knowledge_evidence WHERE installation_id=NEW.installation_id AND evidence_id=evidence;
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,version_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,version_id FROM knowledge_evidence WHERE installation_id=NEW.installation_id AND evidence_id=evidence;
    END LOOP;
    IF NEW.claim_version_id IS NOT NULL THEN
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,version_id) VALUES(NEW.installation_id,NEW.connection_id,NEW.export_id,NEW.claim_version_id);
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,repo_snapshot_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,repo_snapshot_id FROM knowledge_versions WHERE version_id=NEW.claim_version_id AND repo_snapshot_id IS NOT NULL;
    END IF;
    IF NEW.wiki_version_id IS NOT NULL THEN
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,source_snapshot_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,source_snapshot_id FROM memory_wiki_versions WHERE wiki_version_id=NEW.wiki_version_id;
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,graph_version_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,graph_version_id FROM memory_wiki_versions WHERE wiki_version_id=NEW.wiki_version_id;
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,build_run_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,build_run_id FROM memory_wiki_versions WHERE wiki_version_id=NEW.wiki_version_id AND build_run_id IS NOT NULL;
    END IF;
    IF NEW.skill_version_id IS NOT NULL THEN
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,archive_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,archive_id FROM memory_skill_versions WHERE version_id=NEW.skill_version_id;
      INSERT INTO memory_git_snapshot_sources(installation_id,connection_id,export_id,repo_snapshot_id)
        SELECT NEW.installation_id,NEW.connection_id,NEW.export_id,a.repo_snapshot_id FROM memory_skill_versions v JOIN memory_skill_archives a USING(installation_id,archive_id) WHERE v.version_id=NEW.skill_version_id;
    END IF;
    RETURN NEW; END $$;
CREATE TRIGGER memory_git_capture_sources AFTER INSERT ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_capture_sources();
CREATE TRIGGER memory_git_sources_immutable BEFORE UPDATE ON memory_git_snapshot_sources FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable();
CREATE TRIGGER memory_git_sources_registered BEFORE INSERT ON memory_git_snapshot_sources FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_asset_insert();
CREATE FUNCTION memory_git_retain_export(i UUID,c UUID,e UUID) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO memory_git_retained_outcomes
      SELECT o.installation_id,o.connection_id,o.proposal_id,p.export_id,o.proposal_revision,p.generation,l.commit_sha,l.link_id,l.version_id,l.asset_id,o.outcome
      FROM memory_git_import_outcomes o JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id)
      JOIN memory_git_revision_links l ON l.installation_id=o.installation_id AND l.connection_id=o.connection_id AND l.link_id=o.link_id
      WHERE p.installation_id=i AND p.connection_id=c AND p.export_id=e AND p.state='applied' AND p.revision=o.proposal_revision AND p.head_commit=l.commit_sha
      ON CONFLICT DO NOTHING;
    INSERT INTO memory_git_remote_cleanup(installation_id,connection_id,export_id,old_run_id,generation,provider,provider_repository_id,target_branch,
      target_owner,target_repository,target_private,remote_branch,expected_commit,expected_tree,description_hash,remote_pr_id)
      SELECT DISTINCT ON(b.export_id) b.installation_id,b.connection_id,b.export_id,b.run_id,b.generation,k.provider,k.provider_repository_id,k.target_branch,
        b.target_owner,b.target_repository,b.target_private,COALESCE(b.remote_branch,'pocketctl/export/'||b.export_id),b.expected_commit,b.expected_tree,b.description_hash,b.remote_pr_id
      FROM memory_git_outbox b JOIN memory_git_connections k USING(installation_id,connection_id)
      WHERE b.installation_id=i AND b.connection_id=c AND b.export_id=e
      ORDER BY b.export_id,(b.remote_pr_id IS NOT NULL) DESC,(b.operation='pull_request') DESC ON CONFLICT DO NOTHING;
    INSERT INTO memory_git_retained_steps
      SELECT s.installation_id,s.connection_id,b.export_id,s.outbox_id,s.step,s.operation,s.state,
        s.expected_head,s.expected_blob,s.expected_tree,s.expected_commit,s.remote_sha,s.remote_tree,s.remote_number,s.expected_content_blob
      FROM memory_git_outbox_steps s JOIN memory_git_outbox b USING(installation_id,connection_id,outbox_id)
      WHERE b.installation_id=i AND b.connection_id=c AND b.export_id=e ON CONFLICT DO NOTHING;
    UPDATE memory_git_run_receipts p SET attempts=GREATEST(p.attempts,r.http_attempts),failures=GREATEST(p.failures,r.failure_count),
      state=CASE WHEN r.state IN('cancelled','dead') THEN r.state WHEN p.unfinished THEN 'invalidated' ELSE p.state END,reason_code=CASE WHEN p.unfinished THEN 'source_invalidated' ELSE p.reason_code END
      FROM memory_git_runs r WHERE p.installation_id=r.installation_id AND p.run_id=r.run_id AND r.installation_id=i AND r.connection_id=c AND r.export_id=e;
    UPDATE memory_jobs SET state='dead',claim_expires_at=NULL,last_error_code='source_invalidated'
      WHERE installation_id=i AND state IN('pending','running') AND job_id IN(SELECT job_id FROM memory_git_runs WHERE installation_id=i AND connection_id=c AND export_id=e);
    INSERT INTO memory_git_audit_events(event_id,installation_id,connection_id,export_id,action,outcome,reason_code)
      VALUES(gen_random_uuid(),i,c,e,'invalidate','invalidated','source_invalid');
  END $$;
CREATE FUNCTION memory_git_forget_export() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE g BIGINT; BEGIN
    PERFORM memory_git_retain_export(OLD.installation_id,OLD.connection_id,OLD.export_id);
    INSERT INTO memory_git_tombstones(installation_id,connection_id,identity_id,kind,generation)
      VALUES(OLD.installation_id,OLD.connection_id,OLD.export_id,'export',OLD.generation) ON CONFLICT DO NOTHING;
    INSERT INTO memory_git_lifecycle_epochs(installation_id,connection_id,transaction_id,generation)
      SELECT installation_id,connection_id,txid_current(),generation+1 FROM memory_git_connections WHERE installation_id=OLD.installation_id AND connection_id=OLD.connection_id
      ON CONFLICT DO NOTHING RETURNING generation INTO g;
    IF g IS NOT NULL THEN UPDATE memory_git_connections SET generation=g WHERE installation_id=OLD.installation_id AND connection_id=OLD.connection_id; END IF;
    RETURN OLD; END $$;
CREATE TRIGGER memory_git_forget_export BEFORE DELETE ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION memory_git_forget_export();
CREATE FUNCTION memory_git_invalidate_connection(i UUID,c UUID) RETURNS void LANGUAGE plpgsql AS $$ DECLARE g BIGINT; BEGIN
    INSERT INTO memory_git_lifecycle_epochs(installation_id,connection_id,transaction_id,generation)
      SELECT installation_id,connection_id,txid_current(),generation+1 FROM memory_git_connections WHERE installation_id=i AND connection_id=c
      ON CONFLICT DO NOTHING RETURNING generation INTO g;
    IF g IS NOT NULL THEN UPDATE memory_git_connections SET generation=g WHERE installation_id=i AND connection_id=c; END IF;
    DELETE FROM memory_git_snapshots WHERE installation_id=i AND connection_id=c;
    UPDATE memory_git_run_receipts SET state='invalidated',reason_code='source_invalidated' WHERE installation_id=i AND connection_id=c AND unfinished AND state NOT IN('cancelled','dead');
    UPDATE memory_jobs SET state='dead',claim_expires_at=NULL,last_error_code='source_invalidated' WHERE installation_id=i AND state IN('pending','running')
      AND job_id IN(SELECT job_id FROM memory_git_runs WHERE installation_id=i AND connection_id=c);
    UPDATE memory_git_runs SET state=CASE WHEN state IN('cancelled','dead','invalidated','closed') THEN state ELSE 'invalidated' END,
      dry_run_result=NULL,result=NULL,grant_facts=NULL,error_code='source_invalidated' WHERE installation_id=i AND connection_id=c;
    DELETE FROM memory_git_sync_principals WHERE installation_id=i AND connection_id=c;
  END $$;
CREATE FUNCTION memory_git_dependency_deleted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    -- During parent deletion the snapshot is already invisible; don't recurse.
    IF EXISTS(SELECT 1 FROM memory_git_snapshots WHERE installation_id=OLD.installation_id AND export_id=OLD.export_id) THEN
      PERFORM memory_git_invalidate_connection(OLD.installation_id,OLD.connection_id);
    END IF; RETURN OLD; END $$;
CREATE TRIGGER memory_git_dependency_deleted AFTER DELETE ON memory_git_snapshot_sources FOR EACH ROW EXECUTE FUNCTION memory_git_dependency_deleted();
CREATE FUNCTION memory_git_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE row JSONB;id UUID;c UUID;column_name TEXT; BEGIN
    row=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
    id=(row->>'installation_id')::uuid;column_name=TG_ARGV[0];
    FOR c IN EXECUTE format('SELECT DISTINCT connection_id FROM memory_git_snapshot_sources WHERE installation_id=$1 AND %I=$2',column_name)
      USING id,(row->>TG_ARGV[1])::uuid LOOP PERFORM memory_git_invalidate_connection(id,c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON knowledge_evidence FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('evidence_id','evidence_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('version_id','version_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON work_episodes FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('episode_id','episode_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON repo_snapshots FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('repo_snapshot_id','repo_snapshot_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON memory_source_snapshots FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('source_snapshot_id','snapshot_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON memory_code_graph_versions FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('graph_version_id','graph_version_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON memory_wiki_build_runs FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('build_run_id','run_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON memory_skill_archives FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('archive_id','archive_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE OF excerpt,excerpt_hash,visibility,source_event_id,artifact_id,episode_id ON knowledge_evidence FOR EACH ROW  EXECUTE FUNCTION memory_git_source_changed('evidence_id','evidence_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE OF state,source_digest ON work_episodes FOR EACH ROW WHEN (NEW.state<>'ready' OR NEW.source_digest IS DISTINCT FROM OLD.source_digest) EXECUTE FUNCTION memory_git_source_changed('episode_id','episode_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE OF valid_until,valid_from ON knowledge_versions FOR EACH ROW  EXECUTE FUNCTION memory_git_source_changed('version_id','version_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE OF state ON memory_source_snapshots FOR EACH ROW WHEN (NEW.state NOT IN('active','superseded')) EXECUTE FUNCTION memory_git_source_changed('source_snapshot_id','snapshot_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE OF state ON memory_code_graph_versions FOR EACH ROW WHEN (NEW.state NOT IN('active','superseded')) EXECUTE FUNCTION memory_git_source_changed('graph_version_id','graph_version_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE OF state ON memory_wiki_build_runs FOR EACH ROW WHEN (OLD.state='published' AND NEW.state<>'published') EXECUTE FUNCTION memory_git_source_changed('build_run_id','run_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON memory_code_nodes FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('graph_version_id','graph_version_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE ON memory_code_nodes FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('graph_version_id','graph_version_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON memory_wiki_build_sources FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('build_run_id','run_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE ON memory_wiki_build_sources FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('build_run_id','run_id');
CREATE TRIGGER memory_git_source_delete BEFORE DELETE ON memory_source_snapshot_entries FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('source_snapshot_id','snapshot_id');
CREATE TRIGGER memory_git_source_update BEFORE UPDATE ON memory_source_snapshot_entries FOR EACH ROW EXECUTE FUNCTION memory_git_source_changed('source_snapshot_id','snapshot_id');
CREATE FUNCTION memory_git_wiki_binding_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    IF TG_OP='UPDATE' AND (NEW.installation_id,NEW.wiki_version_id,NEW.section_id,NEW.binding_id,NEW.source_kind,NEW.source_token,NEW.source_snapshot_id,NEW.commit_sha)
      IS NOT DISTINCT FROM (OLD.installation_id,OLD.wiki_version_id,OLD.section_id,OLD.binding_id,OLD.source_kind,OLD.source_token,OLD.source_snapshot_id,OLD.commit_sha)
      THEN RETURN NEW; END IF;
    FOR c IN SELECT DISTINCT connection_id FROM memory_git_snapshot_assets
      WHERE installation_id=OLD.installation_id AND wiki_version_id=OLD.wiki_version_id ORDER BY connection_id
      LOOP PERFORM memory_git_invalidate_connection(OLD.installation_id,c); END LOOP;
    IF TG_OP='UPDATE' AND (NEW.installation_id,NEW.wiki_version_id) IS DISTINCT FROM (OLD.installation_id,OLD.wiki_version_id) THEN
      FOR c IN SELECT DISTINCT connection_id FROM memory_git_snapshot_assets
        WHERE installation_id=NEW.installation_id AND wiki_version_id=NEW.wiki_version_id ORDER BY connection_id
        LOOP PERFORM memory_git_invalidate_connection(NEW.installation_id,c); END LOOP;
    END IF;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
CREATE TRIGGER memory_git_wiki_binding_deleted BEFORE DELETE ON memory_wiki_source_bindings FOR EACH ROW EXECUTE FUNCTION memory_git_wiki_binding_changed();
CREATE TRIGGER memory_git_wiki_binding_changed BEFORE UPDATE OF installation_id,wiki_version_id,section_id,binding_id,source_kind,source_token,source_snapshot_id,commit_sha
    ON memory_wiki_source_bindings FOR EACH ROW EXECUTE FUNCTION memory_git_wiki_binding_changed();
CREATE FUNCTION memory_git_asset_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a UUID;i UUID;b RECORD; BEGIN
    i=OLD.installation_id;a=(to_jsonb(OLD)->>TG_ARGV[0])::uuid;
    FOR b IN SELECT * FROM memory_git_asset_bindings WHERE installation_id=i AND asset_id=a LOOP
      IF TG_OP='DELETE' OR TG_ARGV[1]='terminal' THEN
        INSERT INTO memory_git_tombstones(installation_id,connection_id,identity_id,kind,generation)
          SELECT i,b.connection_id,a,b.kind,generation FROM memory_git_connections WHERE connection_id=b.connection_id ON CONFLICT DO NOTHING;
      END IF;
      PERFORM memory_git_invalidate_connection(i,b.connection_id);
    END LOOP; RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
CREATE TRIGGER memory_git_claim_withdrawn BEFORE UPDATE OF state ON knowledge_claims FOR EACH ROW WHEN (NEW.state<>'active' AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION memory_git_asset_withdrawn('claim_id','terminal');
CREATE TRIGGER memory_git_skill_withdrawn BEFORE UPDATE OF state ON memory_skill_heads FOR EACH ROW WHEN (NEW.state IN('revoked','archived') AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION memory_git_asset_withdrawn('skill_id','terminal');
CREATE TRIGGER memory_git_wiki_lock_changed BEFORE UPDATE OF locked ON memory_wiki_manual_section_heads FOR EACH ROW WHEN (NEW.locked IS DISTINCT FROM OLD.locked) EXECUTE FUNCTION memory_git_asset_withdrawn('wiki_id','projection');
CREATE TRIGGER memory_git_wiki_version_withdrawn BEFORE UPDATE OF state ON memory_wiki_versions FOR EACH ROW WHEN (NEW.state IN('revoked','purged') AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION memory_git_asset_withdrawn('wiki_id','projection');
CREATE TRIGGER memory_git_skill_publication_disabled BEFORE UPDATE OF state ON memory_skill_publication_heads FOR EACH ROW WHEN (NEW.state='disabled' AND NEW.state IS DISTINCT FROM OLD.state) EXECUTE FUNCTION memory_git_asset_withdrawn('skill_id','projection');
CREATE FUNCTION memory_git_skill_version_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    FOR c IN SELECT DISTINCT connection_id FROM memory_git_snapshot_assets WHERE installation_id=NEW.installation_id AND skill_version_id=NEW.version_id LOOP
      PERFORM memory_git_invalidate_connection(NEW.installation_id,c); END LOOP; RETURN NEW; END $$;
CREATE TRIGGER memory_git_skill_version_withdrawn BEFORE INSERT ON memory_skill_version_revocations FOR EACH ROW EXECUTE FUNCTION memory_git_skill_version_withdrawn();
CREATE TRIGGER memory_git_asset_delete BEFORE DELETE ON knowledge_claims FOR EACH ROW EXECUTE FUNCTION memory_git_asset_withdrawn('claim_id','terminal');
CREATE TRIGGER memory_git_asset_delete BEFORE DELETE ON memory_wikis FOR EACH ROW EXECUTE FUNCTION memory_git_asset_withdrawn('wiki_id','terminal');
CREATE TRIGGER memory_git_asset_delete BEFORE DELETE ON memory_skills FOR EACH ROW EXECUTE FUNCTION memory_git_asset_withdrawn('skill_id','terminal');
CREATE FUNCTION memory_git_scope_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE i UUID;c UUID; BEGIN
    i=CASE WHEN TG_OP='DELETE' THEN OLD.installation_id ELSE NEW.installation_id END;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
    FOR c IN SELECT k.connection_id FROM memory_git_connections k JOIN memory_owner_scopes s USING(installation_id)
      WHERE s.installation_id=i OR s.parent_organization_id IN(SELECT owner_scope_id FROM memory_owner_scopes WHERE installation_id=i AND owner_scope_kind='organization')
      ORDER BY k.connection_id LOOP
      PERFORM memory_git_invalidate_connection((SELECT installation_id FROM memory_git_connections WHERE connection_id=c),c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
CREATE TRIGGER memory_git_scope_changed BEFORE UPDATE OF state,authorization_epoch ON memory_owner_scopes FOR EACH ROW EXECUTE FUNCTION memory_git_scope_changed();
CREATE FUNCTION memory_git_scope_tombstoned() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c RECORD; BEGIN
    FOR c IN SELECT k.installation_id,k.connection_id FROM memory_git_connections k JOIN memory_owner_scopes s USING(installation_id)
      WHERE (s.owner_scope_kind=NEW.owner_scope_kind AND s.owner_scope_id=NEW.owner_scope_id AND s.authorization_epoch<=NEW.authorization_epoch)
        OR (NEW.owner_scope_kind='organization' AND s.parent_organization_id=NEW.owner_scope_id)
      ORDER BY k.connection_id LOOP PERFORM memory_git_invalidate_connection(c.installation_id,c.connection_id); END LOOP; RETURN NEW; END $$;
CREATE TRIGGER memory_git_scope_tombstoned BEFORE INSERT OR UPDATE ON memory_scope_tombstones FOR EACH ROW EXECUTE FUNCTION memory_git_scope_tombstoned();
CREATE TRIGGER memory_git_installation_changed BEFORE UPDATE OF local_status,relay_status,config_version ON memory_installations FOR EACH ROW EXECUTE FUNCTION memory_git_scope_changed();
CREATE FUNCTION memory_git_member_dependency_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    IF TG_OP='UPDATE' AND (NEW.state,NEW.membership_revision,NEW.roles,NEW.valid_from,NEW.valid_until) IS NOT DISTINCT FROM (OLD.state,OLD.membership_revision,OLD.roles,OLD.valid_from,OLD.valid_until) THEN RETURN NEW; END IF;
    FOR c IN
      SELECT connection_id FROM memory_git_runs WHERE installation_id=OLD.installation_id AND membership_id=OLD.membership_id AND state NOT IN('closed','invalidated','cancelled','dead')
      UNION SELECT connection_id FROM memory_git_sync_principals WHERE installation_id=OLD.installation_id AND membership_id=OLD.membership_id
      UNION SELECT a.connection_id FROM memory_git_original_authors a JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id)
        WHERE a.installation_id=OLD.installation_id AND a.author_membership_id=OLD.membership_id
      UNION SELECT a.connection_id FROM memory_git_resolution_authors a JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id)
        WHERE a.installation_id=OLD.installation_id AND a.resolver_membership_id=OLD.membership_id
      UNION SELECT p.connection_id FROM memory_git_revision_reviews r JOIN memory_git_governed_revisions g USING(installation_id,revision_id)
        JOIN memory_git_import_proposals p USING(installation_id,connection_id,proposal_id) WHERE r.installation_id=OLD.installation_id AND r.reviewer_membership_id=OLD.membership_id
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN knowledge_evidence e ON e.installation_id=d.installation_id AND e.evidence_id=d.evidence_id
        WHERE d.installation_id=OLD.installation_id AND e.contributor_membership_id=OLD.membership_id
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN memory_authority_records a ON a.installation_id=d.installation_id AND a.version_id=d.version_id
        WHERE d.installation_id=OLD.installation_id AND a.publisher_membership_id=OLD.membership_id
      ORDER BY connection_id
    LOOP PERFORM memory_git_invalidate_connection(OLD.installation_id,c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
CREATE TRIGGER memory_git_member_changed BEFORE UPDATE OF state,membership_revision,roles,valid_from,valid_until ON memory_scope_memberships FOR EACH ROW EXECUTE FUNCTION memory_git_member_dependency_changed();
CREATE TRIGGER memory_git_member_deleted BEFORE DELETE ON memory_scope_memberships FOR EACH ROW EXECUTE FUNCTION memory_git_member_dependency_changed();
CREATE FUNCTION memory_git_repository_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    FOR c IN SELECT connection_id FROM memory_git_connections WHERE installation_id=NEW.installation_id AND repository_id=NEW.repository_id ORDER BY connection_id LOOP
      PERFORM memory_git_invalidate_connection(NEW.installation_id,c); END LOOP; RETURN NEW; END $$;
CREATE TRIGGER memory_git_repository_withdrawn BEFORE INSERT ON memory_repository_tombstones FOR EACH ROW EXECUTE FUNCTION memory_git_repository_withdrawn();
CREATE FUNCTION memory_git_session_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID;i UUID;s TEXT; BEGIN
    i=CASE WHEN TG_OP='DELETE' THEN OLD.installation_id ELSE NEW.installation_id END;
    s=CASE WHEN TG_OP='DELETE' THEN OLD.session_id ELSE NEW.session_id END;
    FOR c IN SELECT DISTINCT d.connection_id FROM memory_git_snapshot_sources d JOIN work_episodes e ON e.installation_id=d.installation_id AND e.episode_id=d.episode_id
      WHERE e.installation_id=i AND e.session_id=s
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN knowledge_evidence e ON e.installation_id=d.installation_id AND e.evidence_id=d.evidence_id
        LEFT JOIN source_events se ON se.installation_id=e.installation_id AND se.source_event_id=e.source_event_id
        LEFT JOIN source_artifacts a ON a.installation_id=e.installation_id AND a.artifact_id=e.artifact_id
        WHERE d.installation_id=i AND (se.session_id=s OR a.session_id=s)
      UNION SELECT a.connection_id FROM memory_git_snapshot_assets a JOIN memory_skill_replay_runs r ON r.installation_id=a.installation_id AND r.version_id=a.skill_version_id
        JOIN memory_skill_replay_cases k ON k.installation_id=r.installation_id AND k.run_id=r.run_id
        WHERE a.installation_id=i AND k.kind='historical_session' AND k.reference_id=s
      LOOP PERFORM memory_git_invalidate_connection(i,c); END LOOP;
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END $$;
CREATE TRIGGER memory_git_session_withdrawn BEFORE INSERT ON memory_session_tombstones FOR EACH ROW EXECUTE FUNCTION memory_git_session_withdrawn();
CREATE TRIGGER memory_git_session_deleted BEFORE UPDATE OF deleted_at ON source_sessions FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION memory_git_session_withdrawn();
CREATE TRIGGER memory_git_session_removed BEFORE DELETE ON source_sessions FOR EACH ROW EXECUTE FUNCTION memory_git_session_withdrawn();
CREATE FUNCTION memory_git_snapshot_tombstoned() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE c UUID; BEGIN
    FOR c IN SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN memory_source_snapshots s
      ON s.installation_id=d.installation_id AND s.snapshot_id=d.source_snapshot_id
      WHERE d.installation_id=NEW.installation_id AND (s.snapshot_id=NEW.snapshot_id OR (s.repository_id=NEW.repository_id AND s.commit_sha=NEW.commit_sha))
      UNION SELECT d.connection_id FROM memory_git_snapshot_sources d JOIN repo_snapshots s
        ON s.installation_id=d.installation_id AND s.repo_snapshot_id=d.repo_snapshot_id
        WHERE d.installation_id=NEW.installation_id AND s.repository_id=NEW.repository_id AND s.commit_sha=NEW.commit_sha
      LOOP PERFORM memory_git_invalidate_connection(NEW.installation_id,c); END LOOP; RETURN NEW; END $$;
CREATE TRIGGER memory_git_snapshot_tombstoned BEFORE INSERT ON memory_source_snapshot_tombstones FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_tombstoned();
CREATE FUNCTION memory_git_key_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r RECORD; BEGIN
    FOR r IN SELECT DISTINCT installation_id,connection_id FROM memory_git_snapshot_keys WHERE key_id=NEW.key_id ORDER BY installation_id,connection_id LOOP
      PERFORM memory_git_invalidate_connection(r.installation_id,r.connection_id); END LOOP; RETURN NEW; END $$;
CREATE TRIGGER memory_git_key_withdrawn AFTER UPDATE OF state ON memory_git_attestation_keys FOR EACH ROW WHEN (NEW.state='revoked' AND OLD.state<>'revoked') EXECUTE FUNCTION memory_git_key_withdrawn();
CREATE FUNCTION memory_git_connection_withdrawn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='DELETE' THEN
      -- The identity is going away; reserve its terminal epoch without an
      -- UPDATE of the row already owned by this DELETE command.
      INSERT INTO memory_git_lifecycle_epochs VALUES(OLD.installation_id,OLD.connection_id,txid_current(),OLD.generation+1) ON CONFLICT DO NOTHING;
      PERFORM memory_git_invalidate_connection(OLD.installation_id,OLD.connection_id); RETURN OLD;
    END IF;
    IF NEW.generation<>OLD.generation OR NEW.state IS DISTINCT FROM OLD.state OR (NEW.sync_mode='off' AND NEW.sync_mode IS DISTINCT FROM OLD.sync_mode) THEN
      INSERT INTO memory_git_lifecycle_epochs VALUES(NEW.installation_id,NEW.connection_id,txid_current(),NEW.generation) ON CONFLICT DO NOTHING;
      -- A snapshot-triggered bump already owns deletion. No recursive DELETE of
      -- its still-visible parent row; the caller invalidates the complete set.
      IF pg_trigger_depth()=1 THEN PERFORM memory_git_invalidate_connection(NEW.installation_id,NEW.connection_id); END IF;
    END IF;RETURN NEW;END $$;
CREATE TRIGGER memory_git_connection_withdrawn AFTER UPDATE OF generation,state,sync_mode ON memory_git_connections FOR EACH ROW EXECUTE FUNCTION memory_git_connection_withdrawn();
CREATE TRIGGER memory_git_connection_deleted BEFORE DELETE ON memory_git_connections FOR EACH ROW EXECUTE FUNCTION memory_git_connection_withdrawn();
CREATE FUNCTION memory_git_connection_identity_changed() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE g BIGINT; BEGIN
    IF (NEW.installation_id,NEW.connection_id,NEW.repository_id,NEW.owner_scope_kind,NEW.owner_scope_id)
      IS DISTINCT FROM (OLD.installation_id,OLD.connection_id,OLD.repository_id,OLD.owner_scope_kind,OLD.owner_scope_id)
      THEN RAISE EXCEPTION 'git_connection_identity_immutable'; END IF;
    IF (NEW.provider,NEW.provider_repository_id,NEW.target_id,NEW.target_branch,NEW.root_path,NEW.credential_ref)
      IS DISTINCT FROM (OLD.provider,OLD.provider_repository_id,OLD.target_id,OLD.target_branch,OLD.root_path,OLD.credential_ref)
      OR NEW.state IS DISTINCT FROM OLD.state OR (NEW.sync_mode='off' AND NEW.sync_mode IS DISTINCT FROM OLD.sync_mode) THEN
      -- Reserve the increment before deletion hooks. The outer row update owns
      -- generation; no trigger attempts to UPDATE this same connection row.
      INSERT INTO memory_git_lifecycle_epochs VALUES(OLD.installation_id,OLD.connection_id,txid_current(),GREATEST(NEW.generation,OLD.generation+1)) ON CONFLICT DO NOTHING;
      SELECT generation INTO g FROM memory_git_lifecycle_epochs WHERE installation_id=OLD.installation_id AND connection_id=OLD.connection_id AND transaction_id=txid_current();
      NEW.generation=GREATEST(NEW.generation,g);
      -- Retain original remote target while OLD is still the visible row.
      PERFORM memory_git_invalidate_connection(OLD.installation_id,OLD.connection_id);
    END IF; RETURN NEW; END $$;
CREATE TRIGGER memory_git_connection_identity_changed BEFORE UPDATE OF installation_id,connection_id,repository_id,owner_scope_kind,owner_scope_id,
    provider,provider_repository_id,target_id,target_branch,root_path,credential_ref,state,sync_mode ON memory_git_connections FOR EACH ROW EXECUTE FUNCTION memory_git_connection_identity_changed();
CREATE FUNCTION memory_git_no_resurrection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF EXISTS(SELECT 1 FROM memory_git_tombstones WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id
      AND (identity_id=NEW.export_id OR (TG_TABLE_NAME='memory_git_snapshot_assets' AND identity_id=COALESCE(to_jsonb(NEW)->>'claim_id',to_jsonb(NEW)->>'wiki_id',to_jsonb(NEW)->>'skill_id')::uuid))) THEN RAISE EXCEPTION 'git_tombstoned'; END IF;
    RETURN NEW; END $$;
CREATE TRIGGER memory_git_no_resurrection BEFORE INSERT ON memory_git_snapshots FOR EACH ROW EXECUTE FUNCTION memory_git_no_resurrection();
CREATE TRIGGER memory_git_no_resurrection BEFORE INSERT ON memory_git_snapshot_assets FOR EACH ROW EXECUTE FUNCTION memory_git_no_resurrection();
ALTER TABLE memory_wikis ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK(state IN('active','revoked'));
ALTER TABLE memory_wiki_versions DROP CONSTRAINT memory_wiki_versions_state_check;
ALTER TABLE memory_wiki_versions ADD CHECK(state IN('active','superseded','purged','revoked'));
ALTER TABLE memory_wiki_heads ALTER COLUMN active_version_id DROP NOT NULL;
CREATE TRIGGER memory_git_wiki_withdrawn BEFORE UPDATE OF state ON memory_wikis FOR EACH ROW WHEN (NEW.state='revoked' AND OLD.state<>'revoked') EXECUTE FUNCTION memory_git_asset_withdrawn('wiki_id','terminal');
CREATE FUNCTION memory_wiki_revoke_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF EXISTS(SELECT 1 FROM memory_wikis WHERE installation_id=NEW.installation_id AND wiki_id=NEW.wiki_id AND state='revoked')
      AND ((TG_TABLE_NAME='memory_wiki_versions' AND to_jsonb(NEW)->>'state'='active') OR (TG_TABLE_NAME='memory_wiki_build_runs' AND to_jsonb(NEW)->>'state' IN('queued','running','validating','candidate','published'))
        OR (TG_TABLE_NAME='memory_wiki_heads' AND (to_jsonb(NEW)->>'active_version_id') IS NOT NULL)) THEN RAISE EXCEPTION 'wiki_revoked'; END IF;
    RETURN NEW; END $$;
CREATE TRIGGER memory_wiki_revoke_fence BEFORE INSERT OR UPDATE ON memory_wiki_versions FOR EACH ROW EXECUTE FUNCTION memory_wiki_revoke_fence();
CREATE TRIGGER memory_wiki_revoke_fence BEFORE INSERT OR UPDATE ON memory_wiki_heads FOR EACH ROW EXECUTE FUNCTION memory_wiki_revoke_fence();
CREATE TRIGGER memory_wiki_revoke_fence BEFORE INSERT OR UPDATE ON memory_wiki_build_runs FOR EACH ROW EXECUTE FUNCTION memory_wiki_revoke_fence();
CREATE FUNCTION memory_wiki_terminal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.state='revoked' AND NEW.state<>'revoked' THEN RAISE EXCEPTION 'wiki_revoked'; END IF;RETURN NEW;END $$;
CREATE TRIGGER memory_wiki_terminal BEFORE UPDATE OF state ON memory_wikis FOR EACH ROW EXECUTE FUNCTION memory_wiki_terminal();
DO $$ DECLARE c RECORD; BEGIN
    FOR c IN SELECT DISTINCT installation_id,connection_id FROM memory_git_snapshots ORDER BY installation_id,connection_id LOOP
      PERFORM memory_git_invalidate_connection(c.installation_id,c.connection_id);
    END LOOP; END $$;
INSERT INTO memory_schema_migrations(version) VALUES (44);
COMMIT;

BEGIN;
CREATE TABLE memory_git_proposal_runs(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,proposal_id UUID NOT NULL,run_id UUID NOT NULL,
    PRIMARY KEY(installation_id,connection_id,proposal_id),
    FOREIGN KEY(installation_id,connection_id,proposal_id) REFERENCES memory_git_proposal_identities(installation_id,connection_id,proposal_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,connection_id,run_id) REFERENCES memory_git_run_receipts(installation_id,connection_id,run_id) ON DELETE CASCADE);
INSERT INTO memory_git_proposal_runs SELECT p.installation_id,p.connection_id,p.proposal_id,m.run_id
    FROM memory_git_import_proposals p JOIN memory_git_merge_receipts m
      ON m.installation_id=p.installation_id AND m.connection_id=p.connection_id AND m.generation=p.generation AND m.commit_sha=p.head_commit AND m.run_id=p.run_id;
INSERT INTO memory_git_proposal_runs SELECT o.installation_id,o.connection_id,o.proposal_id,m.run_id
    FROM memory_git_retained_outcomes o JOIN memory_git_merge_receipts m
      ON m.installation_id=o.installation_id AND m.connection_id=o.connection_id AND m.generation=o.generation AND m.commit_sha=o.commit_sha
    ON CONFLICT DO NOTHING;
CREATE FUNCTION memory_git_validate_proposal_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'git_proposal_run_immutable'; END IF;
    IF NOT EXISTS(SELECT 1 FROM memory_git_import_proposals p JOIN memory_git_merge_receipts m
      ON m.installation_id=p.installation_id AND m.connection_id=p.connection_id AND m.generation=p.generation AND m.commit_sha=p.head_commit AND m.run_id=p.run_id
      WHERE p.installation_id=NEW.installation_id AND p.connection_id=NEW.connection_id AND p.proposal_id=NEW.proposal_id AND m.run_id=NEW.run_id)
    AND NOT EXISTS(SELECT 1 FROM memory_git_retained_outcomes o JOIN memory_git_merge_receipts m
      ON m.installation_id=o.installation_id AND m.connection_id=o.connection_id AND m.generation=o.generation AND m.commit_sha=o.commit_sha
      WHERE o.installation_id=NEW.installation_id AND o.connection_id=NEW.connection_id AND o.proposal_id=NEW.proposal_id AND m.run_id=NEW.run_id)
    THEN RAISE EXCEPTION 'git_proposal_run_invalid'; END IF; RETURN NEW; END $$;
CREATE TRIGGER memory_git_validate_proposal_run BEFORE INSERT OR UPDATE ON memory_git_proposal_runs FOR EACH ROW EXECUTE FUNCTION memory_git_validate_proposal_run();
CREATE FUNCTION memory_git_bind_proposal_run() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE saved UUID; BEGIN
    SELECT run_id INTO saved FROM memory_git_proposal_runs WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id AND proposal_id=NEW.proposal_id;
    IF saved IS NOT NULL AND saved IS DISTINCT FROM NEW.run_id THEN RAISE EXCEPTION 'git_proposal_run_immutable'; END IF;
    IF NEW.run_id IS NOT NULL AND saved IS NULL THEN
      INSERT INTO memory_git_proposal_runs VALUES(NEW.installation_id,NEW.connection_id,NEW.proposal_id,NEW.run_id);
    END IF; RETURN NEW; END $$;
CREATE TRIGGER memory_git_z_bind_proposal_run AFTER INSERT OR UPDATE OF run_id ON memory_git_import_proposals FOR EACH ROW EXECUTE FUNCTION memory_git_bind_proposal_run();
INSERT INTO memory_schema_migrations(version) VALUES (45);
COMMIT;

BEGIN;
ALTER TABLE memory_git_request_reservations
    ADD COLUMN duration_seconds DOUBLE PRECISION CHECK(duration_seconds>=0 AND duration_seconds<'Infinity'::float8),
    ADD COLUMN request_limit INTEGER CHECK(request_limit BETWEEN 1 AND 128),
    ADD COLUMN byte_limit BIGINT CHECK(byte_limit>0);
CREATE TABLE memory_git_projection_invalidations(
    installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
    connection_id UUID NOT NULL,export_id UUID NOT NULL,started_at TIMESTAMPTZ NOT NULL,finished_at TIMESTAMPTZ,
    duration_seconds DOUBLE PRECISION CHECK(duration_seconds>=0 AND duration_seconds<'Infinity'::float8),
    PRIMARY KEY(installation_id,connection_id,export_id));
CREATE FUNCTION memory_git_measure_invalidation_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO memory_git_projection_invalidations(installation_id,connection_id,export_id,started_at)
      SELECT OLD.installation_id,OLD.connection_id,OLD.export_id,clock_timestamp()
      WHERE EXISTS(SELECT 1 FROM memory_installations WHERE installation_id=OLD.installation_id) ON CONFLICT DO NOTHING;
    RETURN OLD; END $$;
CREATE TRIGGER memory_git_00_measure_invalidation BEFORE DELETE ON memory_git_snapshots
    FOR EACH ROW EXECUTE FUNCTION memory_git_measure_invalidation_start();
CREATE FUNCTION memory_git_measure_invalidation_finish() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE finished TIMESTAMPTZ:=clock_timestamp(); BEGIN
    UPDATE memory_git_projection_invalidations SET finished_at=finished,
      duration_seconds=CASE WHEN finished>=started_at THEN EXTRACT(EPOCH FROM (finished-started_at)) ELSE NULL END
      WHERE installation_id=OLD.installation_id AND connection_id=OLD.connection_id AND export_id=OLD.export_id;
    RETURN OLD; END $$;
CREATE TRIGGER memory_git_01_measure_invalidation AFTER DELETE ON memory_git_snapshots
    FOR EACH ROW EXECUTE FUNCTION memory_git_measure_invalidation_finish();
INSERT INTO memory_schema_migrations(version) VALUES (46);
COMMIT;

BEGIN;
CREATE INDEX IF NOT EXISTS memory_provider_budget_reservations_daily_idx
         ON memory_provider_budget_reservations (budget_key, provider_kind, created_at);
INSERT INTO memory_schema_migrations(version) VALUES (47);
COMMIT;

BEGIN;
CREATE TABLE knowledge_evidence_capsules (
         capsule_id          UUID PRIMARY KEY,
         installation_id     UUID NOT NULL
           REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         version_id          UUID NOT NULL,
         retention_basis     TEXT NOT NULL CHECK (retention_basis = 'user_accepted'),
         accepted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         repository_id       UUID,
         repo_snapshot_id    UUID,
         branch              TEXT,
         source_content_hash BYTEA NOT NULL,
         created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (installation_id, capsule_id),
         UNIQUE (installation_id, version_id),
         FOREIGN KEY (installation_id, version_id)
           REFERENCES knowledge_versions(installation_id, version_id) ON DELETE CASCADE
       );
ALTER TABLE knowledge_evidence ADD COLUMN capsule_id UUID;
ALTER TABLE knowledge_evidence ALTER COLUMN episode_id DROP NOT NULL;
ALTER TABLE knowledge_evidence DROP CONSTRAINT IF EXISTS knowledge_evidence_evidence_kind_check;
ALTER TABLE knowledge_evidence DROP CONSTRAINT IF EXISTS knowledge_evidence_check;
ALTER TABLE knowledge_evidence
         ADD CONSTRAINT knowledge_evidence_capsule_fk
         FOREIGN KEY (installation_id, capsule_id)
         REFERENCES knowledge_evidence_capsules(installation_id, capsule_id) ON DELETE CASCADE;
INSERT INTO knowledge_evidence_capsules
         (capsule_id, installation_id, version_id, retention_basis, accepted_at,
          repository_id, repo_snapshot_id, branch, source_content_hash)
       SELECT gen_random_uuid(), v.installation_id, v.version_id, 'user_accepted',
              v.created_at, v.repository_id, v.repo_snapshot_id, v.branch,
              sha256(convert_to(string_agg(encode(e.excerpt_hash, 'hex'), ':' ORDER BY e.ordinal), 'utf8'))
       FROM knowledge_versions v
       JOIN knowledge_claims c
         ON c.installation_id = v.installation_id AND c.claim_id = v.claim_id
       JOIN knowledge_evidence e
         ON e.installation_id = v.installation_id AND e.version_id = v.version_id
       WHERE c.owner_scope_kind = 'personal'
         AND v.authority IN ('user_accepted', 'user_corrected')
       GROUP BY v.installation_id, v.version_id, v.created_at,
                v.repository_id, v.repo_snapshot_id, v.branch
       ON CONFLICT (installation_id, version_id) DO NOTHING;
UPDATE knowledge_evidence e
       SET capsule_id = c.capsule_id,
           episode_id = NULL,
           source_event_id = NULL,
           artifact_id = NULL,
           evidence_kind = 'accepted_excerpt',
           source_evidence_hash = COALESCE(e.source_evidence_hash, encode(e.excerpt_hash, 'hex')),
           locator = e.locator
             - 'session_id' - 'sessionId' - 'episode_id' - 'episodeId'
             - 'source_event_id' - 'sourceEventId' - 'artifact_id' - 'artifactId'
       FROM knowledge_evidence_capsules c
       WHERE c.installation_id = e.installation_id AND c.version_id = e.version_id;
ALTER TABLE knowledge_evidence
         ADD CONSTRAINT knowledge_evidence_evidence_kind_check CHECK (evidence_kind IN
           ('event','artifact','episode','accepted_excerpt'));
ALTER TABLE knowledge_evidence
         ADD CONSTRAINT knowledge_evidence_check CHECK (
           (evidence_kind = 'accepted_excerpt' AND capsule_id IS NOT NULL
             AND episode_id IS NULL AND source_event_id IS NULL AND artifact_id IS NULL) OR
           (capsule_id IS NULL AND episode_id IS NOT NULL AND (
             (evidence_kind = 'event' AND source_event_id IS NOT NULL) OR
             (evidence_kind = 'artifact' AND artifact_id IS NOT NULL) OR
             (evidence_kind = 'episode' AND source_event_id IS NULL AND artifact_id IS NULL)
           ))
         );
CREATE INDEX knowledge_evidence_capsules_installation_version_idx
         ON knowledge_evidence_capsules (installation_id, version_id);
ALTER TABLE memory_skill_archive_sources
         DROP CONSTRAINT IF EXISTS memory_skill_archive_sources_evidence_kind_check;
ALTER TABLE memory_skill_archive_sources
         DROP CONSTRAINT IF EXISTS memory_skill_archive_sources_check;
ALTER TABLE memory_skill_archive_sources
         DISABLE TRIGGER memory_skill_source_no_update;
UPDATE memory_skill_archive_sources archive_source
       SET evidence_kind = 'accepted_excerpt',
           source_event_id = NULL,
           artifact_id = NULL
       FROM knowledge_evidence evidence
       WHERE evidence.installation_id = archive_source.installation_id
         AND evidence.evidence_id = archive_source.evidence_id
         AND evidence.evidence_kind = 'accepted_excerpt';
ALTER TABLE memory_skill_archive_sources
         ENABLE TRIGGER memory_skill_source_no_update;
ALTER TABLE memory_skill_archive_sources
         ADD CONSTRAINT memory_skill_archive_sources_evidence_kind_check CHECK
           (evidence_kind IN ('event','artifact','episode','accepted_excerpt'));
ALTER TABLE memory_skill_archive_sources
         ADD CONSTRAINT memory_skill_archive_sources_source_check CHECK
           ((evidence_kind='event' AND source_event_id IS NOT NULL AND artifact_id IS NULL)
            OR (evidence_kind='artifact' AND artifact_id IS NOT NULL)
            OR (evidence_kind IN ('episode','accepted_excerpt')
                AND source_event_id IS NULL AND artifact_id IS NULL));
INSERT INTO memory_schema_migrations(version) VALUES (48);
COMMIT;

BEGIN;
ALTER TABLE source_events DROP CONSTRAINT source_events_origin_check;
ALTER TABLE source_events ADD CONSTRAINT source_events_origin_check
         CHECK (origin IN ('feed','snapshot','team'));
ALTER TABLE source_events
         ADD COLUMN source_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE memory_promotion_evidence
         ALTER COLUMN sanitized_locator TYPE JSONB
         USING CASE
           WHEN sanitized_locator IS NULL THEN NULL
           ELSE sanitized_locator::jsonb
         END;
CREATE INDEX source_events_team_source_idx
         ON source_events (installation_id, canonical_event_key)
         WHERE origin = 'team';
INSERT INTO memory_schema_migrations(version) VALUES (49);
COMMIT;

BEGIN;
ALTER TABLE memory_context_packs
         ADD COLUMN selected_references JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE memory_context_packs
         ADD CONSTRAINT memory_context_packs_selected_references_array
         CHECK (jsonb_typeof(selected_references) = 'array');
INSERT INTO memory_schema_migrations(version) VALUES (50);
COMMIT;
