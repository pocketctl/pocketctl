/** Additive queue/authorization evidence. No private keys, tokens or webhook bodies. */
export const GIT_QUEUE_MIGRATION={version:41,statements:[
  `ALTER TABLE memory_jobs DROP CONSTRAINT memory_jobs_job_type_check`,
  `ALTER TABLE memory_jobs ADD CONSTRAINT memory_jobs_job_type_check CHECK(job_type IN
    ('project_feed','compile_episode','snapshot_reconcile','session_purge','installation_purge','report_status','report_usage',
    'extract_candidates','index_claim_version','rebuild_claim_index','expire_claims','recompile_extraction_policy',
    'compile_context_shadow','record_context_delivery','invalidate_context_packs','expire_promotion_candidates','index_shared_claim',
    'invalidate_scope_authorization','transfer_scope_claims','parse_code_snapshot','build_wiki','extract_skill_candidate',
    'git_ingest','git_export','git_reconcile'))`,
  `CREATE TABLE memory_git_attestation_keys(
    key_id TEXT PRIMARY KEY CHECK(char_length(key_id) BETWEEN 1 AND 128),
    public_key_spki BYTEA NOT NULL CHECK(octet_length(public_key_spki) BETWEEN 1 AND 256),
    state TEXT NOT NULL CHECK(state IN('active','retired','revoked')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE FUNCTION memory_git_key_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.key_id<>OLD.key_id OR NEW.public_key_spki<>OLD.public_key_spki OR NEW.created_at<>OLD.created_at
      OR (OLD.state='revoked' AND NEW.state<>'revoked') OR (OLD.state='retired' AND NEW.state='active')
      THEN RAISE EXCEPTION 'git_key_immutable'; END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_key_transition BEFORE UPDATE ON memory_git_attestation_keys FOR EACH ROW EXECUTE FUNCTION memory_git_key_transition()`,
  `CREATE TABLE memory_git_snapshot_keys(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,export_id UUID NOT NULL,key_id TEXT NOT NULL,
    PRIMARY KEY(installation_id,connection_id,export_id),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
    FOREIGN KEY(key_id) REFERENCES memory_git_attestation_keys(key_id) ON DELETE RESTRICT)`,
  `CREATE INDEX memory_git_snapshot_signing_key ON memory_git_snapshot_keys(key_id)`,
  `CREATE TRIGGER memory_git_snapshot_keys_immutable BEFORE UPDATE ON memory_git_snapshot_keys FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_immutable()`,
  `CREATE TRIGGER memory_git_snapshot_keys_created BEFORE INSERT ON memory_git_snapshot_keys FOR EACH ROW EXECUTE FUNCTION memory_git_snapshot_asset_insert()`,
  `ALTER TABLE memory_git_connections ADD COLUMN next_poll_at TIMESTAMPTZ`,
  `CREATE TABLE memory_git_sync_principals(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,export_id UUID NOT NULL,generation BIGINT NOT NULL,
    membership_id UUID NOT NULL,grant_facts JSONB NOT NULL CHECK(jsonb_typeof(grant_facts)='object' AND octet_length(grant_facts::text)<=65536),
    authorization_stamp JSONB NOT NULL CHECK(jsonb_typeof(authorization_stamp)='object' AND octet_length(authorization_stamp::text)<=4096),
    PRIMARY KEY(installation_id,connection_id,export_id),
    FOREIGN KEY(installation_id,connection_id,export_id) REFERENCES memory_git_snapshots(installation_id,connection_id,export_id) ON DELETE CASCADE,
    FOREIGN KEY(installation_id,membership_id) REFERENCES memory_scope_memberships(installation_id,membership_id) ON DELETE CASCADE)`,
  `ALTER TABLE memory_git_runs ADD COLUMN grant_facts JSONB CHECK(jsonb_typeof(grant_facts)='object' AND octet_length(grant_facts::text)<=65536),
    ADD COLUMN change_number TEXT CHECK(change_number ~ '^[1-9][0-9]{0,14}$'),
    ADD COLUMN trigger_source TEXT CHECK(trigger_source IN('webhook','poll','preview','export')),
    ADD COLUMN merge_commit TEXT CHECK(merge_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    ADD COLUMN tree_sha TEXT CHECK(tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    ADD COLUMN provider_actor_id TEXT CHECK(char_length(provider_actor_id) BETWEEN 1 AND 256)`,
  // No content dependency: durable denominators and dedupe survive snapshot/run purges and job retention.
  `CREATE TABLE memory_git_run_receipts(
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
    FOREIGN KEY(installation_id,canonical_run_id) REFERENCES memory_git_run_receipts(installation_id,run_id))`,
  `CREATE TABLE memory_git_merge_receipts(
    installation_id UUID NOT NULL,connection_id UUID NOT NULL,generation BIGINT NOT NULL,commit_sha TEXT NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    run_id UUID NOT NULL,tree_sha TEXT NOT NULL CHECK(tree_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
    PRIMARY KEY(installation_id,connection_id,generation,commit_sha),
    FOREIGN KEY(installation_id,run_id) REFERENCES memory_git_run_receipts(installation_id,run_id) ON DELETE CASCADE)`,
  `CREATE TABLE memory_git_request_reservations(
    reservation_id UUID PRIMARY KEY,installation_id UUID NOT NULL,run_id UUID NOT NULL,attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 128),
    job_id UUID NOT NULL,claim_epoch BIGINT NOT NULL,operation TEXT NOT NULL CHECK(operation IN('merge','commit','tree','poll')),
    state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN('reserved','responded','failed','aborted')),counts_failure BOOLEAN NOT NULL DEFAULT FALSE,
    response_bytes BIGINT NOT NULL DEFAULT 0 CHECK(response_bytes>=0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(installation_id,run_id,attempt),
    FOREIGN KEY(installation_id,run_id) REFERENCES memory_git_run_receipts(installation_id,run_id) ON DELETE CASCADE)`,
  `CREATE FUNCTION memory_git_cancel_connection_runs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF (NEW.generation,NEW.state,NEW.sync_mode) IS DISTINCT FROM (OLD.generation,OLD.state,OLD.sync_mode) THEN
      UPDATE memory_git_run_receipts SET state='invalidated',reason_code='connection_changed',updated_at=NOW()
        WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id AND unfinished;
      UPDATE memory_git_runs SET state='invalidated',error_code='connection_changed' WHERE installation_id=NEW.installation_id
        AND connection_id=NEW.connection_id AND state NOT IN('planned','applied','dead','cancelled','invalidated');
      UPDATE memory_jobs SET state='dead',claim_expires_at=NULL,last_error_code='connection_changed' WHERE installation_id=NEW.installation_id
        AND job_id IN(SELECT job_id FROM memory_git_runs WHERE installation_id=NEW.installation_id AND connection_id=NEW.connection_id AND state='invalidated')
        AND state IN('pending','running');
      PERFORM pg_notify('memory_git_cancel',NEW.connection_id::text);
    END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_cancel_connection AFTER UPDATE ON memory_git_connections FOR EACH ROW EXECUTE FUNCTION memory_git_cancel_connection_runs()`,
  `CREATE FUNCTION memory_git_cancel_member_runs() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
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
    END IF; RETURN NEW; END $$`,
  `CREATE TRIGGER memory_git_cancel_member AFTER UPDATE ON memory_scope_memberships FOR EACH ROW EXECUTE FUNCTION memory_git_cancel_member_runs()`,
] } as const
