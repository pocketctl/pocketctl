// A NULL protocol denotes a historical run. Usage or an expired legacy lease
// is never proof that an old request can safely be sent again.
export const CURATION_CHECKPOINT_MIGRATION = { version: 110, statements: [
  `ALTER TABLE memory_curation_runs ADD COLUMN checkpoint_protocol smallint CHECK(checkpoint_protocol=1),
    ADD COLUMN reconciliation_code text, ADD COLUMN reconciled_at timestamptz,
    ADD COLUMN stage_job_epoch bigint, ADD COLUMN stage_run_epoch bigint,
    ADD COLUMN recovery_processor text, ADD COLUMN recovery_started_at timestamptz,
    ADD COLUMN recovery_at timestamptz, ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0`,
  `CREATE INDEX memory_curation_recovery_due ON memory_curation_runs(recovery_at,installation_id,run_id)
    WHERE recovery_at IS NOT NULL`,
  `CREATE TABLE memory_curation_provider_circuits (
    installation_id uuid NOT NULL REFERENCES memory_installations ON DELETE CASCADE, model_config_hash text NOT NULL,
    failures smallint NOT NULL CHECK(failures BETWEEN 1 AND 3), probe_after timestamptz, probe_call_id uuid,
    PRIMARY KEY(installation_id,model_config_hash))`,
  `CREATE TABLE memory_curation_calls (
    installation_id uuid NOT NULL, run_id uuid NOT NULL, window_index integer NOT NULL CHECK(window_index>=0),
    call_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE, input_digest text NOT NULL, request_digest text,
    state text NOT NULL DEFAULT 'intended' CHECK(state IN ('intended','possible','unknown','saved','withdrawn','conflict')),
    dispatch_epoch bigint, budget_reservation_id uuid, usage jsonb, response jsonb, response_digest text, conflicting_digest text,
    bindings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(installation_id,run_id,window_index),
    FOREIGN KEY(installation_id,run_id) REFERENCES memory_curation_runs ON DELETE CASCADE,
    CHECK ((state='saved')=(response IS NOT NULL)))`,
  `CREATE INDEX memory_uncertain_call_age ON memory_curation_calls(installation_id,updated_at DESC,call_id)
    WHERE state IN('possible','unknown','conflict')`,
  `CREATE INDEX memory_uncertain_legacy_runs ON memory_curation_runs(installation_id,started_at DESC,run_id)
    WHERE checkpoint_protocol IS NULL AND (state='provider_result_unknown' OR reconciliation_code='external_result_unconfirmed')`,
  `CREATE TABLE memory_curation_items (
    installation_id uuid NOT NULL, run_id uuid NOT NULL, item_key text NOT NULL,
    window_calls uuid[] NOT NULL, task_id uuid, space_id uuid, state text NOT NULL CHECK(state IN ('published','binding_pending')),
    observed_revision bigint, observed_space_state text, observed_space_revision bigint, child_run_id uuid, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(installation_id,run_id,item_key), FOREIGN KEY(installation_id,run_id) REFERENCES memory_curation_runs ON DELETE CASCADE)`,
  `CREATE FUNCTION memory_withdraw_curation_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE memory_curation_calls c SET state='withdrawn',response=NULL,bindings='{}',updated_at=clock_timestamp()
      FROM memory_curation_runs r WHERE r.installation_id=NEW.installation_id AND c.installation_id=r.installation_id
        AND c.run_id=r.run_id AND r.bundle_id=NEW.bundle_id AND c.state<>'withdrawn';
      RETURN NULL;
    END $$`,
  `CREATE TRIGGER memory_withdraw_curation_checkpoint AFTER UPDATE OF revision,body_state ON memory_task_bundles
    FOR EACH ROW WHEN (NEW.revision<>OLD.revision OR NEW.body_state<>OLD.body_state)
    EXECUTE FUNCTION memory_withdraw_curation_checkpoint()`,
  `CREATE FUNCTION memory_purge_curation_call_bodies() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE memory_curation_calls c SET state='withdrawn',response=NULL,bindings='{}',updated_at=clock_timestamp()
      FROM memory_curation_runs r JOIN memory_task_bundles b USING(installation_id,bundle_id)
      WHERE c.installation_id=NEW.installation_id AND r.installation_id=c.installation_id AND r.run_id=c.run_id
        AND c.state NOT IN ('intended','withdrawn') AND (TG_TABLE_NAME<>'memory_session_tombstones' OR b.session_id=to_jsonb(NEW)->>'session_id');
      RETURN NULL;
    END $$`,
  `CREATE TRIGGER memory_session_purge_curation_calls AFTER INSERT ON memory_session_tombstones
    FOR EACH ROW EXECUTE FUNCTION memory_purge_curation_call_bodies()`,
  `CREATE TRIGGER memory_owner_purge_curation_calls AFTER UPDATE OF state,authorization_epoch ON memory_owner_scopes
    FOR EACH ROW WHEN (OLD.state<>NEW.state OR OLD.authorization_epoch<>NEW.authorization_epoch)
    EXECUTE FUNCTION memory_purge_curation_call_bodies()`,
  `CREATE TRIGGER memory_policy_purge_curation_calls AFTER UPDATE OF mode,revision ON memory_curation_policies
    FOR EACH ROW WHEN (OLD.mode<>NEW.mode OR OLD.revision<>NEW.revision)
    EXECUTE FUNCTION memory_purge_curation_call_bodies()`,
  `REVOKE ALL ON memory_curation_calls,memory_curation_items,memory_curation_provider_circuits FROM PUBLIC`
] }
