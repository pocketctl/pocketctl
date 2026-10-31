import {GOVERNANCE_INCREMENTAL_MIGRATION} from '../migrations/governance-v2/incremental-migration.js'

/** Additive retention fences. Historical content is not reclaimed by schema startup. */
export const DATA_RETENTION_MIGRATION = {
  version: 72,
  statements: [
    `CREATE TABLE memory_retention_control (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
      change_gc_floor BIGINT NOT NULL DEFAULT 0 CHECK(change_gc_floor>=0),
      generation BIGINT NOT NULL DEFAULT 1 CHECK(generation>0)
    )`,
    `INSERT INTO memory_retention_control(singleton) VALUES(TRUE)`,
    `CREATE TABLE memory_source_retention_receipts (
      installation_id UUID NOT NULL REFERENCES memory_installations(installation_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,session_id TEXT NOT NULL,episode_id UUID NOT NULL,
      source_digest BYTEA NOT NULL,compiler_version TEXT NOT NULL,
      extraction_completed_at TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL CHECK(state IN('reclaiming','reclaimed')),
      reclaimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),finished_at TIMESTAMPTZ,
      policy_version TEXT NOT NULL DEFAULT 'source-body-v1',
      late_events BIGINT NOT NULL DEFAULT 0 CHECK(late_events>=0),
      PRIMARY KEY(installation_id,turn_id),
      CHECK((state='reclaimed')=(finished_at IS NOT NULL))
    )`,
    `CREATE INDEX memory_source_retention_session_idx ON memory_source_retention_receipts(installation_id,session_id)`,
    ...['source_events','source_artifacts','work_episodes','memory_candidates','memory_snapshot_events'].map(table =>
      `ALTER TABLE ${table} ADD COLUMN body_reclaimed_at TIMESTAMPTZ`),
    `ALTER TABLE work_episodes ADD COLUMN retained_content_hash TEXT`,
    `ALTER TABLE memory_candidates ADD COLUMN retained_content_hash TEXT`,
    `CREATE INDEX memory_source_body_retention_idx ON source_events(installation_id,turn_id,source_event_id) WHERE body_reclaimed_at IS NULL`,
    `CREATE INDEX memory_artifact_body_retention_idx ON source_artifacts(installation_id,turn_id,artifact_id) WHERE body_reclaimed_at IS NULL`,
    `CREATE INDEX memory_candidate_body_retention_idx ON memory_candidates(installation_id,episode_id,candidate_id) WHERE body_reclaimed_at IS NULL`,
    `CREATE INDEX memory_snapshot_body_retention_idx ON memory_snapshot_events(installation_id,(COALESCE(NULLIF(payload->>'turn_id',''),NULLIF(payload->>'source_turn_id',''))),relay_event_id) WHERE body_reclaimed_at IS NULL`,
    `CREATE FUNCTION memory_retention_source_metadata(value JSONB) RETURNS JSONB LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE retained JSONB;
      BEGIN
        SELECT COALESCE(jsonb_object_agg(key,v),'{}'::jsonb) INTO retained FROM jsonb_each(value) AS e(key,v)
        WHERE key=ANY(ARRAY['repository_id','repo_snapshot_id','branch','commit_sha','worktree_identity',
          'session_id','turn_id','source_turn_id','event_id','message_id','part_id','revision','call_id','event_type',
          'status','team_source','accepted_delivery','source_class','source_kind','source_version']);
        IF pg_column_size(retained)>32768 THEN RAISE EXCEPTION 'retention_metadata_too_large'; END IF;
        RETURN retained;
      END $$`,
    // Replays are fenced in the database too: every source ingress uses this
    // guard, including snapshots and older writers. Original hashes survive.
    `CREATE FUNCTION memory_retention_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE receipt memory_source_retention_receipts%ROWTYPE; key TEXT; previous_reclaimed TIMESTAMPTZ;
      BEGIN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||NEW.installation_id,0));
        IF TG_OP='UPDATE' THEN previous_reclaimed:=OLD.body_reclaimed_at; END IF;
        IF TG_TABLE_NAME='memory_snapshot_events' THEN
          key:=COALESCE(NULLIF(NEW.payload->>'turn_id',''),NULLIF(NEW.payload->>'source_turn_id',''));
        ELSE key:=NEW.turn_id; END IF;
        SELECT * INTO receipt FROM memory_source_retention_receipts
          WHERE installation_id=NEW.installation_id AND turn_id=key;
        IF FOUND OR (TG_OP='UPDATE' AND OLD.body_reclaimed_at IS NOT NULL) THEN
          IF TG_TABLE_NAME='source_artifacts' THEN
            NEW.details:='{}'::jsonb;
          ELSE NEW.payload:=memory_retention_source_metadata(NEW.payload); END IF;
          NEW.body_reclaimed_at:=COALESCE(receipt.reclaimed_at,previous_reclaimed,clock_timestamp());
          IF TG_OP='UPDATE' AND TG_TABLE_NAME<>'source_artifacts' THEN
            IF NEW.payload_hash IS DISTINCT FROM OLD.payload_hash THEN RAISE EXCEPTION 'retained_source_hash_changed'; END IF;
          END IF;
        END IF;
        RETURN NEW;
      END $$`,
    ...['source_events','source_artifacts','memory_snapshot_events'].map(table =>
      `CREATE TRIGGER memory_retention_source_guard BEFORE INSERT OR UPDATE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION memory_retention_source_guard()`),
    `CREATE FUNCTION memory_retention_episode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='UPDATE' AND OLD.body_reclaimed_at IS NOT NULL THEN
          IF NEW.body_reclaimed_at IS DISTINCT FROM OLD.body_reclaimed_at OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
            OR NEW.document IS DISTINCT FROM OLD.document OR NEW.evidence_manifest IS DISTINCT FROM OLD.evidence_manifest
            OR NEW.retained_content_hash IS DISTINCT FROM OLD.retained_content_hash OR NEW.summary IS DISTINCT FROM OLD.summary THEN
            RAISE EXCEPTION 'source_body_reclaimed';
          END IF;
        ELSIF EXISTS(SELECT 1 FROM memory_source_retention_receipts r WHERE r.installation_id=NEW.installation_id
          AND r.turn_id=NEW.turn_id) AND NEW.body_reclaimed_at IS NULL THEN
          RAISE EXCEPTION 'source_body_reclaimed';
        END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_retention_episode_guard BEFORE INSERT OR UPDATE ON work_episodes
      FOR EACH ROW EXECUTE FUNCTION memory_retention_episode_guard()`,
    `CREATE FUNCTION memory_retention_reference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE value JSONB:=to_jsonb(NEW); owner UUID:=(value->>'installation_id')::uuid;
      BEGIN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('purge:installation:'||owner,0));
        IF EXISTS(SELECT 1 FROM memory_source_retention_receipts r WHERE r.installation_id=owner AND (
          r.episode_id::text=value->>'episode_id' OR EXISTS(SELECT 1 FROM source_events s
            WHERE s.installation_id=owner AND s.turn_id=r.turn_id AND s.source_event_id::text=value->>'source_event_id')
          OR EXISTS(SELECT 1 FROM source_artifacts a WHERE a.installation_id=owner AND a.turn_id=r.turn_id
            AND a.artifact_id::text=value->>'artifact_id'))) THEN RAISE EXCEPTION 'source_body_reclaimed'; END IF;
        RETURN NEW;
      END $$`,
    ...['knowledge_evidence','memory_skill_archives','memory_skill_task_runs','memory_skill_archive_sources'].map(table =>
      `CREATE TRIGGER memory_retention_reference_guard BEFORE INSERT OR UPDATE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION memory_retention_reference_guard()`),
    ...['memory_candidates','memory_extraction_runs'].map(table =>
      `CREATE TRIGGER memory_retention_reference_guard BEFORE INSERT ON ${table}
       FOR EACH ROW EXECUTE FUNCTION memory_retention_reference_guard()`),
    // This is a strictly destructive privacy operation, also required while
    // restored installations remain on hold. Admission and authority writes
    // still use the original writer fence without exceptions.
    GOVERNANCE_INCREMENTAL_MIGRATION.statements.find(sql=>sql.startsWith('CREATE OR REPLACE FUNCTION memory_governance_fence_writer'))!
      .replace('IF old_record=new_record THEN RETURN NEW; END IF;', `IF old_record=new_record THEN RETURN NEW; END IF;
       IF TG_TABLE_NAME='memory_candidates' AND old_record->>'body_reclaimed_at' IS NULL
        AND new_record->>'body_reclaimed_at' IS NOT NULL AND new_record->>'statement'='[content reclaimed]'
        AND new_record->'structured_content'='{}'::jsonb AND new_record->'evidence_handles'='[]'::jsonb
        AND (new_record->>'revision')::bigint=(old_record->>'revision')::bigint+1
        AND new_record->>'retained_content_hash'=encode(sha256(convert_to(jsonb_build_object(
          'statement',old_record->'statement','structured_content',old_record->'structured_content',
          'evidence_handles',old_record->'evidence_handles')::text,'UTF8')),'hex')
        AND (new_record->>'status'=old_record->>'status' OR (new_record->>'status'='expired'
          AND old_record->>'status' IN('validated','conflict') AND (old_record->>'review_expires_at')::timestamptz<=clock_timestamp()))
        AND (new_record->'validation'=old_record->'validation' OR (old_record->>'status' IN('validated','conflict')
          AND new_record->'validation'=(old_record->'validation'||'{"expiry_reason":"review_ttl_elapsed"}'::jsonb)))
        AND (old_record-ARRAY['statement','structured_content','evidence_handles','body_reclaimed_at','retained_content_hash','revision','status','validation'])=
            (new_record-ARRAY['statement','structured_content','evidence_handles','body_reclaimed_at','retained_content_hash','revision','status','validation'])
        AND EXISTS(SELECT 1 FROM memory_source_retention_receipts r WHERE r.installation_id=(new_record->>'installation_id')::uuid
          AND r.episode_id=(new_record->>'episode_id')::uuid) THEN RETURN NEW; END IF;`),
    `CREATE FUNCTION memory_retention_candidate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.body_reclaimed_at IS NOT NULL AND (NEW.body_reclaimed_at IS DISTINCT FROM OLD.body_reclaimed_at
          OR NEW.statement IS DISTINCT FROM OLD.statement OR NEW.structured_content IS DISTINCT FROM OLD.structured_content
          OR NEW.evidence_handles IS DISTINCT FROM OLD.evidence_handles OR NEW.retained_content_hash IS DISTINCT FROM OLD.retained_content_hash)
          THEN RAISE EXCEPTION 'source_body_reclaimed'; END IF;
        RETURN NEW;
      END $$`,
    `CREATE TRIGGER memory_retention_candidate_guard BEFORE UPDATE ON memory_candidates
      FOR EACH ROW EXECUTE FUNCTION memory_retention_candidate_guard()`,
    `ALTER TABLE memory_governance_migration_runs
      ADD COLUMN scope_ids UUID[] NOT NULL DEFAULT '{}',
      ADD COLUMN start_watermark BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN migration_kind TEXT NOT NULL DEFAULT 'governance_v2',
      ADD COLUMN sealed_at TIMESTAMPTZ,
      ADD COLUMN abandoned_at TIMESTAMPTZ,
      ADD COLUMN details_reclaimed_at TIMESTAMPTZ`,
    `UPDATE memory_governance_migration_runs SET
      scope_ids=ARRAY(SELECT jsonb_array_elements_text(manifest->'installationIds')::uuid),
      start_watermark=COALESCE((manifest->>'startWatermark')::bigint,0)`,
    `SET CONSTRAINTS ALL IMMEDIATE`,
    `CREATE INDEX memory_migration_unsealed_scopes_idx ON memory_governance_migration_runs USING GIN(scope_ids)
      WHERE sealed_at IS NULL AND abandoned_at IS NULL`,
    `CREATE TABLE memory_governance_migration_summaries (
      run_id UUID PRIMARY KEY,migration_kind TEXT NOT NULL,scope_ids UUID[] NOT NULL,
      schema_version INTEGER NOT NULL,environment_fingerprint TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,completed_at TIMESTAMPTZ NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN('complete','abandoned')),
      action_counts JSONB NOT NULL,verification JSONB NOT NULL,
      details_reclaimed_at TIMESTAMPTZ
    )`,
    `CREATE FUNCTION memory_retention_migration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE run memory_governance_migration_runs%ROWTYPE;
      BEGIN
        IF TG_TABLE_NAME='memory_governance_migration_runs' THEN
          IF TG_OP='INSERT' THEN
            NEW.scope_ids:=ARRAY(SELECT jsonb_array_elements_text(NEW.manifest->'installationIds')::uuid);
            NEW.start_watermark:=COALESCE((NEW.manifest->>'startWatermark')::bigint,0);
          ELSIF OLD.sealed_at IS NOT NULL OR OLD.abandoned_at IS NOT NULL THEN
            IF NEW.manifest IS DISTINCT FROM OLD.manifest AND NOT (
              NEW.manifest='{}'::jsonb AND NEW.details_reclaimed_at IS NOT NULL AND
              EXISTS(SELECT 1 FROM memory_governance_migration_summaries WHERE run_id=OLD.run_id)) THEN
              RAISE EXCEPTION 'migration_run_sealed';
            END IF;
            IF (to_jsonb(NEW)-ARRAY['manifest','details_reclaimed_at']) IS DISTINCT FROM
               (to_jsonb(OLD)-ARRAY['manifest','details_reclaimed_at']) THEN RAISE EXCEPTION 'migration_run_sealed'; END IF;
          ELSIF NEW.manifest IS DISTINCT FROM OLD.manifest AND
             (NEW.manifest->'installationIds' IS DISTINCT FROM OLD.manifest->'installationIds'
              OR NEW.manifest->'startWatermark' IS DISTINCT FROM OLD.manifest->'startWatermark') THEN
            RAISE EXCEPTION 'migration_scope_changed';
          END IF;
        ELSE
          SELECT * INTO run FROM memory_governance_migration_runs WHERE run_id=NEW.run_id FOR SHARE;
          IF run.sealed_at IS NOT NULL OR run.abandoned_at IS NOT NULL OR run.details_reclaimed_at IS NOT NULL THEN
            RAISE EXCEPTION 'migration_run_sealed';
          END IF;
        END IF;
        RETURN NEW;
      END $$`,
    ...['memory_governance_migration_runs','memory_governance_migration_actions','memory_governance_migration_checkpoints'].map(table =>
      `CREATE TRIGGER memory_retention_migration_guard BEFORE INSERT OR UPDATE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION memory_retention_migration_guard()`),
  ],
}
