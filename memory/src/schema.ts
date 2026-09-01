import type pg from 'pg'

/**
 * Versioned, idempotent migrations for the independent Memory database.
 * Every statement inside a version runs in one transaction; a startup
 * advisory lock stops the API and Worker from migrating concurrently.
 * The SQL below is frozen by docs/plans/2026-08-23-pocketctl-memory-phase-0.md
 * section 6 — do not reshape it without updating that contract.
 */

const MIGRATION_LOCK_KEY = 57_100_019_883_100_021

interface Migration {
  version: number
  statements: readonly string[]
}

export const MEMORY_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `
      CREATE TABLE IF NOT EXISTS memory_schema_migrations (
        version       INTEGER PRIMARY KEY,
        applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `
      CREATE TABLE IF NOT EXISTS memory_provider_state (
        provider_id          TEXT PRIMARY KEY CHECK (provider_id = 'pocketctl-memory'),
        installation_cursor  TEXT,
        last_discovery_at    TIMESTAMPTZ,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `
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
      )`,
      `
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
      )`,
      `
      CREATE INDEX IF NOT EXISTS idx_memory_feed_inbox_pending
        ON memory_feed_inbox (installation_id, feed_id)
        WHERE projection_state = 'pending'`,
      `
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
      )`,
      `
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
      )`,
      `
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
      )`,
      `
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
      )`,
      `
      CREATE INDEX IF NOT EXISTS idx_source_events_session_time
        ON source_events (installation_id, session_id, occurred_at, source_event_id)`,
      `
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
      )`,
      `
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
      )`,
      `
      CREATE TABLE IF NOT EXISTS repositories (
        repository_id       UUID PRIMARY KEY,
        installation_id     UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        repository_key      TEXT NOT NULL,
        canonical_remote    TEXT,
        first_observed_at   TIMESTAMPTZ NOT NULL,
        last_observed_at    TIMESTAMPTZ NOT NULL,
        UNIQUE (installation_id, repository_key)
      )`,
      `
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
      )`,
      `
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
      )`,
      `
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
        UNIQUE NULLS NOT DISTINCT (installation_id, job_type, idempotency_key)
      )`,
      `
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_claim
        ON memory_jobs (priority, available_at, created_at)
        WHERE state = 'pending'`,
      `
      CREATE TABLE IF NOT EXISTS memory_dead_letters (
        job_id            UUID PRIMARY KEY,
        installation_id   UUID,
        job_type           TEXT NOT NULL,
        attempts           INTEGER NOT NULL,
        error_code         TEXT NOT NULL,
        payload_hash       BYTEA NOT NULL,
        dead_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `
      CREATE TABLE IF NOT EXISTS memory_session_tombstones (
        installation_id  UUID NOT NULL,
        session_id        TEXT NOT NULL,
        reason            TEXT NOT NULL,
        source_feed_id    BIGINT,
        purged_at         TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (installation_id, session_id)
      )`,
      `
      CREATE TABLE IF NOT EXISTS memory_purge_receipts (
        request_id        UUID PRIMARY KEY,
        installation_id  UUID NOT NULL,
        reason            TEXT NOT NULL,
        receipt           TEXT NOT NULL,
        local_committed_at TIMESTAMPTZ NOT NULL,
        relay_acked_at    TIMESTAMPTZ
      )`,
      `
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
      )`,
    ],
  },
  {
    // v2: repo_snapshots dedup key must not contain observed_at — the column
    // defaults to NOW() on every insert, so the old four-column unique key
    // made ON CONFLICT unreachable and the table grew with every observation.
    version: 2,
    statements: [
      `
      DELETE FROM repo_snapshots older
      USING repo_snapshots newer
      WHERE older.installation_id = newer.installation_id
        AND older.repository_id = newer.repository_id
        AND older.commit_sha = newer.commit_sha
        AND (older.observed_at, older.repo_snapshot_id)
          < (newer.observed_at, newer.repo_snapshot_id)`,
      `
      ALTER TABLE repo_snapshots
        DROP CONSTRAINT IF EXISTS repo_snapshots_installation_id_repository_id_commit_sha_observed_at_key`,
      `
      ALTER TABLE repo_snapshots
        ADD CONSTRAINT repo_snapshots_installation_id_repository_id_commit_sha_key
        UNIQUE (installation_id, repository_id, commit_sha)`,
    ],
  },
  {
    // v3: keep the relay-side event timestamp. v1 stored only the local
    // landing time, so snapshot rebuilds would order and date turns by when
    // the reconcile pulled them rather than when the events occurred.
    version: 3,
    statements: [
      `
      ALTER TABLE memory_snapshot_events ADD COLUMN occurred_at TIMESTAMPTZ`,
      `
      UPDATE memory_snapshot_events SET occurred_at = created_at WHERE occurred_at IS NULL`,
    ],
  },
  {
    // v4: v2's DROP CONSTRAINT never matched — PostgreSQL truncated the
    // auto-generated 73-char constraint name to 63 chars, so the statement
    // silently no-ops and the obsolete four-column unique survives. Drop it
    // by catalog lookup on the actual stored name instead.
    version: 4,
    statements: [
      `
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
      END $$`,
    ],
  },
  {
    // v5: enforce "one running generation per installation" at the database
    // level — startRun's comment promised it but nothing constrained it; two
    // concurrent reconciles would otherwise interleave their rebuilds. Any
    // pre-v5 duplicate running rows (possible via dual starts before this
    // index) are failed first so the index creation cannot trip on them.
    version: 5,
    statements: [
      `
      UPDATE memory_snapshot_runs r
      SET state = 'failed', error_code = 'superseded_running', completed_at = NOW()
      WHERE r.state = 'running'
        AND r.run_id <> (
          SELECT r2.run_id FROM memory_snapshot_runs r2
          WHERE r2.installation_id = r.installation_id AND r2.state = 'running'
          ORDER BY r2.started_at DESC, r2.generation DESC
          LIMIT 1
        )`,
      `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_snapshot_runs_one_running
        ON memory_snapshot_runs (installation_id)
        WHERE state = 'running'`,
    ],
  },
  {
    // v6: distinguish a completed local snapshot rebuild from a Relay ACK.
    // A completed local run can still have a pending/running/dead job when
    // its Relay ACK failed. Only backfill rows without such evidence; retrying
    // jobs must remain distinguishable for ACK-only recovery.
    version: 6,
    statements: [
      `
      ALTER TABLE memory_snapshot_runs ADD COLUMN relay_acked_at TIMESTAMPTZ`,
      `
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
        )`,
    ],
  },
  {
    // v7: Phase 1 personal recall ledger — frozen by
    // docs/plans/2026-08-24-pocketctl-memory-phase-1.md section 6. Adds the
    // candidate/review ledger, evidence, search projections, feedback,
    // idempotency and tombstones, plus the composite isolation uniques that
    // make every cross-table reference installation-scoped.
    version: 7,
    statements: [
      `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
      `
      ALTER TABLE work_episodes
        ADD COLUMN repository_id UUID,
        ADD COLUMN repo_snapshot_id UUID,
        ADD COLUMN branch TEXT,
        ADD COLUMN source_digest BYTEA,
        ADD COLUMN document JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN evidence_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN document_compiler_version TEXT,
        ADD COLUMN compiled_at TIMESTAMPTZ`,
      `
      ALTER TABLE source_events
        ADD CONSTRAINT source_events_installation_event_unique
        UNIQUE (installation_id, source_event_id)`,
      `
      ALTER TABLE source_artifacts
        ADD CONSTRAINT source_artifacts_installation_artifact_unique
        UNIQUE (installation_id, artifact_id)`,
      `
      ALTER TABLE repositories
        ADD CONSTRAINT repositories_installation_repository_unique
        UNIQUE (installation_id, repository_id)`,
      `
      ALTER TABLE repo_snapshots
        ADD CONSTRAINT repo_snapshots_installation_snapshot_unique
        UNIQUE (installation_id, repo_snapshot_id)`,
      `
      ALTER TABLE work_episodes
        ADD CONSTRAINT work_episodes_installation_episode_unique
        UNIQUE (installation_id, episode_id)`,
      `
      ALTER TABLE work_episodes
        ADD CONSTRAINT work_episodes_repository_fk
          FOREIGN KEY (installation_id, repository_id)
          REFERENCES repositories(installation_id, repository_id),
        ADD CONSTRAINT work_episodes_snapshot_fk
          FOREIGN KEY (installation_id, repo_snapshot_id)
          REFERENCES repo_snapshots(installation_id, repo_snapshot_id)`,
      `
      ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check`,
      `
      ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check
        CHECK (job_type IN
        ('project_feed','compile_episode','snapshot_reconcile','session_purge',
         'installation_purge','report_status','report_usage',
         'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims'))`,
      `
      CREATE TABLE memory_feature_settings (
        installation_id UUID PRIMARY KEY
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        extraction_mode TEXT NOT NULL DEFAULT 'off'
          CHECK (extraction_mode IN ('off','shadow','enabled')),
        embedding_mode TEXT NOT NULL DEFAULT 'off'
          CHECK (embedding_mode IN ('off','shadow','enabled')),
        revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
      `
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
      )`,
      `
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
      )`,
      `
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
      )`,
      `
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
          ON DELETE SET NULL (source_candidate_id),
        FOREIGN KEY (installation_id, repository_id)
          REFERENCES repositories(installation_id, repository_id),
        FOREIGN KEY (installation_id, repo_snapshot_id)
          REFERENCES repo_snapshots(installation_id, repo_snapshot_id)
      )`,
      `
      ALTER TABLE memory_candidates
        ADD CONSTRAINT memory_candidates_duplicate_claim_fk
        FOREIGN KEY (installation_id, duplicate_of_claim_id)
        REFERENCES knowledge_claims(installation_id, claim_id)
        ON DELETE SET NULL (duplicate_of_claim_id)`,
      `
      ALTER TABLE knowledge_claims
        ADD CONSTRAINT knowledge_claims_current_version_fk
        FOREIGN KEY (installation_id, current_version_id)
        REFERENCES knowledge_versions(installation_id, version_id)
        DEFERRABLE INITIALLY DEFERRED`,
      `
      ALTER TABLE knowledge_claims
        ADD CONSTRAINT knowledge_claims_superseded_by_fk
        FOREIGN KEY (installation_id, superseded_by_claim_id)
        REFERENCES knowledge_claims(installation_id, claim_id)
        ON DELETE SET NULL (superseded_by_claim_id)`,
      `
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
      )`,
      `
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
      )`,
      `
      CREATE INDEX claim_search_documents_fts
        ON claim_search_documents USING GIN (search_vector)`,
      `
      CREATE INDEX claim_search_documents_trgm
        ON claim_search_documents USING GIN (document gin_trgm_ops)`,
      `
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
          ON DELETE SET NULL (candidate_id),
        FOREIGN KEY (installation_id, claim_id)
          REFERENCES knowledge_claims(installation_id, claim_id)
          ON DELETE SET NULL (claim_id),
        FOREIGN KEY (installation_id, version_id)
          REFERENCES knowledge_versions(installation_id, version_id)
          ON DELETE SET NULL (version_id)
      )`,
      `
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
      )`,
      `
      CREATE TABLE knowledge_tombstones (
        installation_id UUID NOT NULL
          REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
        key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 64),
        identity_hmac BYTEA NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('privacy_delete','source_purge')),
        deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (installation_id, key_id, identity_hmac)
      )`,
    ],
  },
  {
    version: 8,
    statements: [
      `ALTER TABLE memory_candidates
         ADD COLUMN evidence_handles JSONB NOT NULL DEFAULT '[]'::jsonb,
         ADD CONSTRAINT memory_candidates_evidence_handles_array
           CHECK (jsonb_typeof(evidence_handles) = 'array')`,
    ],
  },
  {
    version: 9,
    statements: [
      `ALTER TABLE memory_feature_settings
         ADD COLUMN extraction_consent_fingerprint TEXT,
         ADD COLUMN embedding_consent_fingerprint TEXT`,
    ],
  },
  {
    version: 10,
    statements: [
      `ALTER TABLE claim_search_documents
         ADD COLUMN embedding_fingerprint TEXT`,
    ],
  },
  {
    version: 11,
    statements: [
      `ALTER TABLE memory_usage_outbox
         ADD COLUMN dead_lettered_at TIMESTAMPTZ,
         ADD COLUMN last_error_code TEXT`,
      `ALTER TABLE memory_usage_outbox
         ADD CONSTRAINT memory_usage_outbox_last_error_code_bounded
         CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 128)`,
    ],
  },
  {
    // v12: preserve the reviewed Candidate freshness independently from the
    // Version applicability window. Existing Versions use their validity
    // start when present, otherwise their immutable creation time.
    version: 12,
    statements: [
      `ALTER TABLE knowledge_versions ADD COLUMN freshness_at TIMESTAMPTZ`,
      `UPDATE knowledge_versions
         SET freshness_at = COALESCE(valid_from, created_at)
         WHERE freshness_at IS NULL`,
      `ALTER TABLE knowledge_versions
         ALTER COLUMN freshness_at SET DEFAULT NOW(),
         ALTER COLUMN freshness_at SET NOT NULL`,
    ],
  },
  {
    // v13 (Phase 2 plan section 9): versioned policies, shared generation
    // provenance, context settings/loadouts, retrieval trajectory, context
    // packs/injections/feedback. Migrations 1-12 stay frozen.
    version: 13,
    statements: [
      `ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check`,
      `ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check
         CHECK (job_type IN
         ('project_feed','compile_episode','snapshot_reconcile','session_purge',
          'installation_purge','report_status','report_usage',
          'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims',
          'recompile_extraction_policy','compile_context_shadow',
          'record_context_delivery','invalidate_context_packs'))`,
      `ALTER TABLE repositories
         ADD CONSTRAINT uq_repositories_installation_repository
         UNIQUE (installation_id, repository_id)`,
      `ALTER TABLE knowledge_claims
         ADD CONSTRAINT uq_knowledge_claims_installation_claim
         UNIQUE (installation_id, claim_id)`,
      `ALTER TABLE knowledge_versions
         ADD CONSTRAINT uq_knowledge_versions_installation_version
         UNIQUE (installation_id, version_id)`,
      `ALTER TABLE knowledge_evidence
         ADD CONSTRAINT uq_knowledge_evidence_installation_evidence
         UNIQUE (installation_id, evidence_id)`,
      `CREATE TABLE memory_policy_sets (
         policy_id UUID PRIMARY KEY,
         installation_id UUID REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         policy_kind TEXT NOT NULL CHECK (policy_kind IN ('extraction','context','ranking')),
         layer TEXT NOT NULL CHECK (layer IN ('system','organization','team','repository','user')),
         scope_key TEXT NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE NULLS NOT DISTINCT (installation_id, policy_kind, layer, scope_key)
       )`,
      `CREATE TABLE memory_policy_versions (
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
       )`,
      `CREATE TABLE memory_policy_heads (
         policy_id UUID PRIMARY KEY REFERENCES memory_policy_sets(policy_id) ON DELETE CASCADE,
         active_version_id UUID NOT NULL,
         revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         FOREIGN KEY (policy_id, active_version_id)
           REFERENCES memory_policy_versions(policy_id, policy_version_id)
       )`,
      `CREATE TABLE memory_generation_runs (
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
       )`,
      `CREATE TABLE memory_generation_run_policies (
         run_id UUID NOT NULL REFERENCES memory_generation_runs(run_id) ON DELETE CASCADE,
         ordinal SMALLINT NOT NULL,
         policy_version_id UUID NOT NULL REFERENCES memory_policy_versions(policy_version_id),
         PRIMARY KEY (run_id, ordinal),
         UNIQUE (run_id, policy_version_id)
       )`,
      `ALTER TABLE memory_extraction_runs ADD COLUMN generation_run_id UUID`,
      `INSERT INTO memory_generation_runs
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
       FROM ranked_legacy_runs er`,
      `UPDATE memory_extraction_runs er
       SET generation_run_id = er.run_id
       WHERE er.generation_run_id IS NULL`,
      `CREATE UNIQUE INDEX uq_generation_runs_active
         ON memory_generation_runs
           (installation_id, operation, subject_kind, subject_key_hash, input_digest, effective_policy_hash)
         WHERE state IN ('queued','running','succeeded','quarantined')`,
      `CREATE UNIQUE INDEX uq_extraction_runs_generation_run
         ON memory_extraction_runs(generation_run_id)
         WHERE generation_run_id IS NOT NULL`,
      `CREATE TABLE memory_context_settings (
         setting_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         scope_kind TEXT NOT NULL CHECK (scope_kind IN ('installation','repository','session')),
         scope_key TEXT NOT NULL,
         agent TEXT,
         mode TEXT NOT NULL CHECK (mode IN ('off','shadow','enabled')),
         max_tokens INTEGER CHECK (max_tokens BETWEEN 1 AND 2000),
         revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE NULLS NOT DISTINCT (installation_id, scope_kind, scope_key, agent)
       )`,
      `CREATE TABLE memory_context_loadouts (
         loadout_id UUID PRIMARY KEY,
         installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         repository_id UUID,
         agent TEXT,
         revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE NULLS NOT DISTINCT (installation_id, repository_id, agent),
         UNIQUE (loadout_id, installation_id),
         FOREIGN KEY (installation_id, repository_id)
           REFERENCES repositories(installation_id, repository_id)
       )`,
      `CREATE TABLE memory_context_loadout_items (
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
         UNIQUE NULLS NOT DISTINCT (loadout_id, asset_kind, claim_id, external_asset_ref),
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
       )`,
      `CREATE TABLE memory_retrieval_trajectories (
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
       )`,
      `CREATE TABLE memory_retrieval_stages (
         trajectory_id UUID NOT NULL REFERENCES memory_retrieval_trajectories(trajectory_id) ON DELETE CASCADE,
         ordinal SMALLINT NOT NULL,
         stage TEXT NOT NULL,
         outcome TEXT NOT NULL,
         candidate_count INTEGER NOT NULL DEFAULT 0,
         duration_ms INTEGER NOT NULL DEFAULT 0,
         degraded_reason TEXT,
         PRIMARY KEY (trajectory_id, ordinal)
       )`,
      `CREATE TABLE memory_retrieval_candidates (
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
       )`,
      `CREATE TABLE memory_context_packs (
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
       )`,
      `CREATE UNIQUE INDEX uq_context_packs_active
         ON memory_context_packs
           (installation_id, session_id, client_request_id, effective_policy_hash, input_digest)
         WHERE state <> 'invalidated'`,
      `CREATE TABLE memory_context_pack_items (
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
       )`,
      `CREATE TABLE memory_context_pack_evidence (
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
       )`,
      `CREATE TABLE memory_context_injections (
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
       )`,
      `CREATE UNIQUE INDEX uq_context_admission_active
         ON memory_context_injections(installation_id, session_id, client_request_id)
         WHERE state IN ('prepared','admitted')`,
      `CREATE TABLE memory_context_feedback (
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
       )`,
    ],
  },
  {
    // v14 (plan section 6.1): the extraction run uniqueness must include the
    // effective policy hash so a policy change creates a new run instead of
    // colliding with the pre-policy key.
    version: 14,
    statements: [
      `ALTER TABLE memory_extraction_runs
         ADD COLUMN IF NOT EXISTS effective_policy_hash BYTEA
         NOT NULL DEFAULT decode(md5('phase1:no-policy'), 'hex')`,
      `ALTER TABLE memory_extraction_runs
         DROP CONSTRAINT IF EXISTS
         memory_extraction_runs_installation_id_episode_id_episode_s_key`,
      `ALTER TABLE memory_extraction_runs
         ADD CONSTRAINT memory_extraction_runs_policy_bound_key
         UNIQUE (installation_id, episode_id, episode_source_digest,
                 extractor_version, model_config_hash, effective_policy_hash)`,
    ],
  },
  {
    // Admission must compare the ready pack against the exact repository and
    // effective settings snapshot compiled for that request.
    version: 15,
    statements: [
      `ALTER TABLE memory_context_packs
         ADD COLUMN IF NOT EXISTS repository_id UUID`,
      `ALTER TABLE memory_context_packs
         ADD COLUMN IF NOT EXISTS settings_fingerprint BYTEA`,
      `ALTER TABLE memory_context_packs
         ADD COLUMN IF NOT EXISTS loadout_fingerprint BYTEA`,
      `ALTER TABLE memory_context_packs
         ADD CONSTRAINT memory_context_packs_repository_fk
         FOREIGN KEY (installation_id, repository_id)
         REFERENCES repositories(installation_id, repository_id)`,
    ],
  },
  {
    // Link the immutable pack to its content-free retrieval audit so the
    // management surface can explain selected and dropped candidates.
    version: 16,
    statements: [
      `ALTER TABLE memory_context_packs
         ADD COLUMN IF NOT EXISTS trajectory_id UUID
         REFERENCES memory_retrieval_trajectories(trajectory_id) ON DELETE SET NULL`,
    ],
  },
  {
    // Retrieval prefilter indexes. PostgreSQL does not automatically index
    // referencing FK columns; without these, the evidence/applicability fence
    // can devolve into repeated scans as a personal corpus approaches 10k
    // active versions.
    version: 17,
    statements: [
      `CREATE INDEX IF NOT EXISTS knowledge_claims_active_installation_idx
         ON knowledge_claims (installation_id, claim_id)
         WHERE state = 'active'`,
      `CREATE INDEX IF NOT EXISTS knowledge_versions_applicability_idx
         ON knowledge_versions (installation_id, claim_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS knowledge_evidence_installation_version_idx
         ON knowledge_evidence (installation_id, version_id)`,
    ],
  },
  {
    // Episode Packet v3 can inherit an explicit repository fact from the
    // same session's lifecycle event. Re-run only old repository-less ready
    // episodes for which that trusted, pre-terminal fact is still resolvable;
    // never infer repository identity from cwd or another session.
    version: 18,
    statements: [
      `INSERT INTO memory_jobs
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
       WHERE memory_jobs.state IN ('completed', 'dead')`,
    ],
  },
  {
    // ADR-0005 Phase 3 scope mirror (§7.2): Relay-owned control facts —
    // owner scope, memberships, tombstones — replicated from the v2
    // scope-control feed. Existing installations backfill as personal scopes.
    version: 19,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_owner_scopes (
         installation_id     UUID PRIMARY KEY REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         owner_scope_kind    TEXT NOT NULL CHECK (owner_scope_kind IN ('personal', 'team', 'organization')),
         owner_scope_id      UUID NOT NULL,
         parent_organization_id UUID,
         state               TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'dissolving', 'dissolved')),
         authorization_epoch BIGINT NOT NULL DEFAULT 1 CHECK (authorization_epoch > 0),
         last_feed_id        BIGINT NOT NULL DEFAULT 0,
         updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS memory_owner_scopes_shared_scope_idx
         ON memory_owner_scopes (owner_scope_kind, owner_scope_id)
         WHERE owner_scope_kind IN ('team', 'organization')`,
      `CREATE TABLE IF NOT EXISTS memory_scope_memberships (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_scope_tombstones (
         owner_scope_kind    TEXT NOT NULL CHECK (owner_scope_kind IN ('team', 'organization')),
         owner_scope_id      UUID NOT NULL,
         authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch > 0),
         reason              TEXT NOT NULL,
         tombstoned_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (owner_scope_kind, owner_scope_id)
       )`,
      `INSERT INTO memory_owner_scopes (installation_id, owner_scope_kind, owner_scope_id)
       SELECT installation_id, 'personal', installation_id FROM memory_installations
       ON CONFLICT (installation_id) DO NOTHING`,
    ],
  },
  {
    // ADR-0005 Phase 3 governance ledger (§7.2): review policy versions with
    // CAS heads, promotion candidates with immutable revisions and evidence
    // copies, review decisions, authority provenance, content-free governance
    // audit, and team-dissolution transfer runs.
    version: 20,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_review_policy_sets (
         policy_id          UUID PRIMARY KEY,
         installation_id    UUID NOT NULL UNIQUE REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE TABLE IF NOT EXISTS memory_review_policy_versions (
         policy_version_id  UUID PRIMARY KEY,
         policy_id          UUID NOT NULL REFERENCES memory_review_policy_sets(policy_id) ON DELETE CASCADE,
         version_number     BIGINT NOT NULL CHECK (version_number > 0),
         document           JSONB NOT NULL,
         content_hash       TEXT NOT NULL,
         created_by_membership_id UUID,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (policy_id, version_number)
       )`,
      `CREATE TABLE IF NOT EXISTS memory_review_policy_heads (
         policy_id          UUID PRIMARY KEY REFERENCES memory_review_policy_sets(policy_id) ON DELETE CASCADE,
         active_version_id  UUID NOT NULL REFERENCES memory_review_policy_versions(policy_version_id),
         revision           BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
         updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
      `CREATE TABLE IF NOT EXISTS memory_promotion_candidates (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_promotion_candidates_target_state_idx
         ON memory_promotion_candidates (target_installation_id, state, created_at)`,
      `CREATE TABLE IF NOT EXISTS memory_promotion_candidate_versions (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_promotion_evidence (
         candidate_revision_id UUID NOT NULL REFERENCES memory_promotion_candidate_versions(candidate_revision_id) ON DELETE CASCADE,
         ordinal            INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
         evidence_kind      TEXT NOT NULL,
         excerpt            TEXT NOT NULL CHECK (char_length(excerpt) BETWEEN 1 AND 4000),
         excerpt_hash       TEXT NOT NULL,
         sanitized_locator  TEXT,
         source_evidence_hash TEXT NOT NULL,
         occurred_at        TIMESTAMPTZ,
         PRIMARY KEY (candidate_revision_id, ordinal)
       )`,
      `CREATE TABLE IF NOT EXISTS memory_review_decisions (
         decision_id        UUID PRIMARY KEY,
         candidate_revision_id UUID NOT NULL REFERENCES memory_promotion_candidate_versions(candidate_revision_id) ON DELETE CASCADE,
         membership_id      UUID NOT NULL,
         membership_revision BIGINT NOT NULL CHECK (membership_revision > 0),
         decision           TEXT NOT NULL CHECK (decision IN ('approve','request_changes','reject')),
         reason_code        TEXT,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         UNIQUE (candidate_revision_id, membership_id)
       )`,
      `CREATE TABLE IF NOT EXISTS memory_authority_records (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_governance_events (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_governance_events_page_idx
         ON memory_governance_events (installation_id, created_at DESC, event_id)`,
      `CREATE TABLE IF NOT EXISTS memory_transfer_runs (
         transfer_id        UUID PRIMARY KEY,
         source_installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         target_installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         state              TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed','failed')),
         source_revision    BIGINT,
         created_by_membership_id UUID,
         created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         completed_at       TIMESTAMPTZ,
         CHECK (source_installation_id <> target_installation_id)
       )`,
      `ALTER TABLE knowledge_claims
         ADD COLUMN IF NOT EXISTS owner_scope_kind TEXT NOT NULL DEFAULT 'personal'`,
      `ALTER TABLE knowledge_claims
         ADD COLUMN IF NOT EXISTS owner_scope_id UUID`,
      `ALTER TABLE knowledge_claims
         ADD COLUMN IF NOT EXISTS conflict_group_id UUID`,
      `ALTER TABLE knowledge_claims
         ADD COLUMN IF NOT EXISTS conflict_variant INTEGER NOT NULL DEFAULT 0`,
      `UPDATE knowledge_claims SET owner_scope_id = installation_id WHERE owner_scope_id IS NULL`,
      `CREATE OR REPLACE FUNCTION knowledge_claim_personal_scope() RETURNS trigger AS $fn$
         BEGIN
           IF NEW.owner_scope_kind = 'personal' AND NEW.owner_scope_id IS NULL THEN
             NEW.owner_scope_id := NEW.installation_id;
           END IF;
           RETURN NEW;
         END;
         $fn$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS trg_knowledge_claims_owner_scope ON knowledge_claims`,
      `CREATE TRIGGER trg_knowledge_claims_owner_scope
         BEFORE INSERT OR UPDATE ON knowledge_claims
         FOR EACH ROW EXECUTE FUNCTION knowledge_claim_personal_scope()`,
      `ALTER TABLE knowledge_versions
         ADD COLUMN IF NOT EXISTS source_promotion_candidate_id UUID`,
      `ALTER TABLE knowledge_evidence
         ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'personal'`,
      `ALTER TABLE knowledge_evidence DROP CONSTRAINT IF EXISTS knowledge_evidence_visibility_check`,
      `ALTER TABLE knowledge_evidence
         ADD CONSTRAINT knowledge_evidence_visibility_check CHECK (visibility IN ('personal','shared'))`,
      `ALTER TABLE knowledge_evidence
         ADD COLUMN IF NOT EXISTS source_evidence_hash TEXT`,
      `ALTER TABLE knowledge_evidence
         ADD COLUMN IF NOT EXISTS contributor_membership_id UUID`,
      `ALTER TABLE knowledge_versions DROP CONSTRAINT IF EXISTS knowledge_versions_authority_check`,
      `ALTER TABLE knowledge_versions
         ADD CONSTRAINT knowledge_versions_authority_check CHECK (authority IN
           ('user_accepted','user_corrected','team_reviewed','team_published',
            'organization_reviewed','organization_published'))`,
      `ALTER TABLE memory_jobs DROP CONSTRAINT IF EXISTS memory_jobs_job_type_check`,
      `ALTER TABLE memory_jobs
         ADD CONSTRAINT memory_jobs_job_type_check CHECK (job_type IN
           ('project_feed','compile_episode','snapshot_reconcile','session_purge',
            'installation_purge','report_status','report_usage',
            'extract_candidates','index_claim_version','rebuild_claim_index',
            'expire_claims','recompile_extraction_policy',
            'compile_context_shadow','record_context_delivery','invalidate_context_packs',
            'expire_promotion_candidates','index_shared_claim',
            'invalidate_scope_authorization','transfer_scope_claims'))`,
    ],
  },
  {
    // ADR-P3-08 conflict-aware Claim identity. The strict identity
    // uniqueness becomes variant-aware: parallel variants of one conflict
    // group coexist (distinct conflict_variant), canonical personal rows
    // stay variant 0, and superseded/revoked rows free their slot. All
    // pre-existing rows are preserved as canonical variant 0.
    version: 21,
    statements: [
      `ALTER TABLE knowledge_claims
         DROP CONSTRAINT IF EXISTS uq_knowledge_claims_installation_claim`,
      `ALTER TABLE knowledge_claims
         DROP CONSTRAINT IF EXISTS knowledge_claims_installation_id_claim_type_scope_key_norma_key`,
      `CREATE UNIQUE INDEX IF NOT EXISTS knowledge_claims_active_identity_variant_idx
         ON knowledge_claims (installation_id, claim_type, scope_key, normalized_key, conflict_variant)
         WHERE state = 'active'`,
      `CREATE INDEX IF NOT EXISTS knowledge_claims_conflict_group_idx
         ON knowledge_claims (installation_id, conflict_group_id)
         WHERE conflict_group_id IS NOT NULL`,
    ],
  },
  {
    // Phase 3 review hardening: a Team may have only one transfer run. The
    // constraint, rather than a SELECT-then-INSERT check, closes concurrent
    // transfer races across API processes.
    version: 22,
    statements: [
      `CREATE UNIQUE INDEX IF NOT EXISTS memory_transfer_runs_source_once_idx
         ON memory_transfer_runs (source_installation_id)`,
    ],
  },
  {
    // A Team candidate is governed by two independently mutable policy heads:
    // its own and its parent Organization's. Fence both on immutable proposal
    // revisions and retain the complete policy provenance after publication.
    version: 23,
    statements: [
      `ALTER TABLE memory_promotion_candidate_versions
         ADD COLUMN IF NOT EXISTS parent_review_policy_version_id UUID
         REFERENCES memory_review_policy_versions(policy_version_id) ON DELETE RESTRICT`,
      `ALTER TABLE memory_authority_records
         ADD COLUMN IF NOT EXISTS parent_review_policy_version_id UUID
         REFERENCES memory_review_policy_versions(policy_version_id) ON DELETE RESTRICT`,
    ],
  },
  {
    // Provider spend is fenced before dispatch. Reserved rows survive worker
    // crashes and restarts; only trustworthy provider usage settles them.
    version: 24,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_provider_budget_reservations (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_provider_budget_reservations_key_kind_idx
         ON memory_provider_budget_reservations (budget_key, provider_kind)`,
    ],
  },
  {
    // Phase 4 source ingestion (ADR-0006 §2): immutable, content-addressed
    // committed snapshots. Every child row is installation-bound through a
    // composite foreign key so cross-installation references are impossible,
    // and blobs deduplicate only inside one installation.
    version: 25,
    statements: [
      `DO $$
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
       END $$`,
      `CREATE TABLE IF NOT EXISTS memory_source_snapshots (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_source_snapshots_repo_state_idx
         ON memory_source_snapshots (installation_id, repository_id, state)`,
      `CREATE TABLE IF NOT EXISTS memory_source_blobs (
         installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         blob_hash        TEXT NOT NULL CHECK (blob_hash ~ '^[0-9a-f]{64}$'),
         byte_count       BIGINT NOT NULL CHECK (byte_count >= 0),
         utf8_content     TEXT NOT NULL,
         created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, blob_hash)
       )`,
      `CREATE TABLE IF NOT EXISTS memory_source_snapshot_entries (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_source_snapshot_entries_blob_idx
         ON memory_source_snapshot_entries (installation_id, blob_hash)`,
      `CREATE TABLE IF NOT EXISTS memory_source_snapshot_tombstones (
         installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         snapshot_id      UUID NOT NULL,
         repository_id    UUID NOT NULL,
         commit_sha       TEXT NOT NULL,
         reason_code      TEXT NOT NULL,
         tombstoned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, snapshot_id)
       )`,
      `CREATE TABLE IF NOT EXISTS memory_repository_tombstones (
         installation_id  UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
         repository_id    UUID NOT NULL,
         reason_code      TEXT NOT NULL,
         tombstoned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (installation_id, repository_id)
       )`,
    ],
  },
  {
    // Phase 4 CodeGraph versions (ADR-0006 §4): immutable per-parser-version
    // graph rows scoped to one snapshot, with one active head per repository.
    version: 26,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_code_graph_versions (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_code_graph_versions_repo_state_idx
         ON memory_code_graph_versions (installation_id, repository_id, state)`,
      `CREATE TABLE IF NOT EXISTS memory_code_graph_heads (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_code_nodes (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_code_nodes_path_idx
         ON memory_code_nodes (graph_version_id, path)`,
      `CREATE TABLE IF NOT EXISTS memory_code_edges (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_code_edges_from_idx
         ON memory_code_edges (graph_version_id, from_node_id, kind)`,
      `CREATE INDEX IF NOT EXISTS memory_code_edges_to_idx
         ON memory_code_edges (graph_version_id, to_node_id, kind)`,
    ],
  },
  {
    // Phase 4 Living Wiki ledger (ADR-0006 §5-§7): serial builds per Wiki,
    // immutable versions with one active head, frozen manual authority, and
    // content-free audit.
    version: 27,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_wikis (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_build_runs (
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
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS memory_wiki_build_runs_one_active_idx
         ON memory_wiki_build_runs (wiki_id)
         WHERE state IN ('queued','running','validating')`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_versions (
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
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS memory_wiki_versions_one_active_idx
         ON memory_wiki_versions (installation_id, wiki_id)
         WHERE state = 'active'`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_heads (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_pages (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_sections (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_wiki_sections_key_idx
         ON memory_wiki_sections (wiki_version_id, section_key)`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_source_bindings (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_wiki_source_bindings_section_idx
         ON memory_wiki_source_bindings (wiki_version_id, section_id)`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_manual_section_versions (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_manual_section_heads (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_stale_marks (
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
       )`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_audit_events (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_wiki_audit_events_wiki_idx
         ON memory_wiki_audit_events (installation_id, wiki_id, created_at)`,
    ],
  },
  {
    // Phase 4 parsing job (plan §7 Task 4): finalize enqueues exactly one
    // fenced parse job per snapshot generation. The allowlist CHECK grows
    // additively, mirroring the migration 5 pattern.
    version: 28,
    statements: [
      `ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check`,
      `ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check
        CHECK (job_type IN
        ('project_feed','compile_episode','snapshot_reconcile','session_purge',
         'installation_purge','report_status','report_usage',
         'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims',
         'recompile_extraction_policy','compile_context_shadow','record_context_delivery',
         'invalidate_context_packs','expire_promotion_candidates','index_shared_claim',
         'invalidate_scope_authorization','transfer_scope_claims','parse_code_snapshot'))`,
    ],
  },
  {
    // Phase 4 Wiki build execution ledger (plan §7 Tasks 8-9): build jobs
    // receive normal generation provenance and capture the exact immutable
    // source registry plus validated candidate before publication.
    version: 29,
    statements: [
      `ALTER TABLE memory_generation_runs
         DROP CONSTRAINT IF EXISTS memory_generation_runs_operation_check`,
      `ALTER TABLE memory_generation_runs
         ADD CONSTRAINT memory_generation_runs_operation_check CHECK (operation IN
           ('extract_candidates','compile_context','compress_context_shadow','build_wiki'))`,
      `ALTER TABLE memory_jobs DROP CONSTRAINT IF EXISTS memory_jobs_job_type_check`,
      `ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check
        CHECK (job_type IN
        ('project_feed','compile_episode','snapshot_reconcile','session_purge',
         'installation_purge','report_status','report_usage',
         'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims',
         'recompile_extraction_policy','compile_context_shadow','record_context_delivery',
         'invalidate_context_packs','expire_promotion_candidates','index_shared_claim',
         'invalidate_scope_authorization','transfer_scope_claims','parse_code_snapshot',
         'build_wiki'))`,
      `ALTER TABLE memory_wiki_build_runs
         ADD COLUMN IF NOT EXISTS generation_run_id UUID UNIQUE
           REFERENCES memory_generation_runs(run_id) ON DELETE SET NULL`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_build_sources (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_wiki_build_sources_ref_idx
         ON memory_wiki_build_sources (installation_id, source_kind, source_ref_id)`,
      `CREATE TABLE IF NOT EXISTS memory_wiki_build_candidates (
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
       )`,
    ],
  },
  {
    // Phase 4 Minimum Product Contract: every denied shared mutation has a
    // durable, content-free record. Deliberately omit request/resource data,
    // grants, user identities, paths, symbols, and Wiki text.
    version: 30,
    statements: [
      `CREATE TABLE IF NOT EXISTS memory_phase4_authorization_audit_events (
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
       )`,
      `CREATE INDEX IF NOT EXISTS memory_phase4_authorization_audit_events_installation_idx
         ON memory_phase4_authorization_audit_events (installation_id, created_at)`,
    ],
  },
]

/** Apply every pending migration exactly once under a startup lock. */
export async function applyMemorySchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS memory_schema_migrations (
          version       INTEGER PRIMARY KEY,
          applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      const applied = await client.query<{ version: number }>(
        'SELECT version FROM memory_schema_migrations',
      )
      const done = new Set(applied.rows.map(row => Number(row.version)))
      for (const migration of MEMORY_MIGRATIONS) {
        if (done.has(migration.version)) continue
        await client.query('BEGIN')
        try {
          for (const statement of migration.statements) {
            await client.query(statement)
          }
          await client.query(
            'INSERT INTO memory_schema_migrations (version) VALUES ($1)',
            [migration.version],
          )
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
    }
  } finally {
    client.release()
  }
}
