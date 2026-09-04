/** ADR-0007 foundation only. Runtime scheduling/publication is not registered. */
export const SKILL_ARCHIVE_MIGRATION = {
  version: 31,
  statements: [
    `CREATE TABLE memory_skill_archives (
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
    )`,
    `CREATE INDEX memory_skill_archives_source_idx
      ON memory_skill_archives (installation_id, episode_id)`,
    `CREATE INDEX memory_skill_archives_repository_idx
      ON memory_skill_archives (installation_id, repository_id, candidate_key, generation DESC)`,
    `CREATE TABLE memory_skill_archive_sources (
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
    )`,
    `CREATE FUNCTION memory_skill_archive_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'skill_archive_immutable'; END
    $$`,
    `CREATE TRIGGER memory_skill_archive_no_update BEFORE UPDATE ON memory_skill_archives
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_immutable()`,
    `CREATE TRIGGER memory_skill_source_no_update BEFORE UPDATE ON memory_skill_archive_sources
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_immutable()`,
    `CREATE FUNCTION memory_skill_archive_check_source() RETURNS trigger LANGUAGE plpgsql AS $$
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
    $$`,
    `CREATE TRIGGER memory_skill_archive_source_guard BEFORE INSERT ON memory_skill_archives
      FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_check_source()`,
    `CREATE FUNCTION memory_skill_source_check_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
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
    $$`,
    `CREATE TRIGGER memory_skill_source_manifest_guard BEFORE INSERT ON memory_skill_archive_sources
      FOR EACH ROW EXECUTE FUNCTION memory_skill_source_check_manifest()`,
    `CREATE FUNCTION memory_skill_archive_check_complete() RETURNS trigger LANGUAGE plpgsql AS $$
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
    $$`,
    `CREATE CONSTRAINT TRIGGER memory_skill_archive_sources_complete AFTER INSERT ON memory_skill_archives
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_skill_archive_check_complete()`,
    `CREATE FUNCTION memory_skill_source_delete_archive() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        DELETE FROM memory_skill_archives WHERE installation_id=OLD.installation_id AND archive_id=OLD.archive_id;
        RETURN NULL;
      END
    $$`,
    // AFTER is deliberate: cascade from parent deletion has already removed
    // the parent, so deleting another source cannot recurse into it again.
    `CREATE TRIGGER memory_skill_source_delete_parent AFTER DELETE ON memory_skill_archive_sources
      FOR EACH ROW EXECUTE FUNCTION memory_skill_source_delete_archive()`,
    `CREATE FUNCTION memory_skill_episode_invalidate_archives() RETURNS trigger LANGUAGE plpgsql AS $$
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
    $$`,
    `CREATE TRIGGER memory_skill_episode_invalidated AFTER UPDATE OF state, outcome,
      repository_id, repo_snapshot_id, source_digest, evidence_manifest ON work_episodes
      FOR EACH ROW EXECUTE FUNCTION memory_skill_episode_invalidate_archives()`,
  ],
} as const
