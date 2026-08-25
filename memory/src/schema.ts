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
