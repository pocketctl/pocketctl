import {SHARED_GRANT_FUNCTIONS} from '../migrations/shared-db/grant-contract.js'

export const CURATION_EXECUTION_MIGRATION={version:79,statements:[
 `ALTER TABLE memory_task_bundles ADD COLUMN bundle_kind TEXT NOT NULL DEFAULT 'intake' CHECK(bundle_kind IN('intake','task')),
 ADD COLUMN parent_bundle_id UUID,ADD COLUMN parent_revision BIGINT,ADD COLUMN spans JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(spans)='array'),
 ADD COLUMN topic_descriptor TEXT NOT NULL DEFAULT '' CHECK(length(topic_descriptor)<=512),
 ADD FOREIGN KEY(installation_id,parent_bundle_id) REFERENCES memory_task_bundles(installation_id,bundle_id) ON DELETE CASCADE`,
 `ALTER TABLE memory_curation_runs ADD COLUMN authorization_epoch BIGINT NOT NULL DEFAULT 1 CHECK(authorization_epoch>0),
 ADD COLUMN result JSONB,ADD COLUMN parent_run_id UUID,
 ADD FOREIGN KEY(installation_id,parent_run_id) REFERENCES memory_curation_runs(installation_id,run_id) ON DELETE CASCADE`,
 `CREATE TABLE memory_logical_tombstones(installation_id UUID NOT NULL REFERENCES memory_installations ON DELETE CASCADE,
 logical_key TEXT NOT NULL CHECK(logical_key~'^[a-f0-9]{64}$'),deleted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(installation_id,logical_key))`,
 `ALTER TABLE knowledge_versions DROP CONSTRAINT knowledge_versions_authority_check`,
 `ALTER TABLE knowledge_versions ADD CONSTRAINT knowledge_versions_authority_check CHECK(authority IN('user_accepted','user_corrected','team_reviewed','team_published','organization_reviewed','organization_published','automation_accepted','machine_concluded'))`,
 `ALTER TABLE knowledge_evidence_capsules DROP CONSTRAINT knowledge_evidence_capsules_retention_basis_check`,
 `ALTER TABLE knowledge_evidence_capsules ADD CONSTRAINT knowledge_evidence_capsules_retention_basis_check CHECK(retention_basis IN('user_accepted','automation_conclusion'))`,
 `CREATE FUNCTION memory_require_curation_authority() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.authority='machine_concluded' AND NOT EXISTS(
 SELECT 1 FROM memory_curation_decisions d JOIN memory_curation_runs r USING(installation_id,run_id)
 JOIN memory_task_bundles b ON b.installation_id=r.installation_id AND b.bundle_id=r.bundle_id
 JOIN memory_curation_policies p ON p.installation_id=r.installation_id
 JOIN memory_owner_scopes o ON o.installation_id=r.installation_id
 WHERE d.installation_id=NEW.installation_id AND d.version_id=NEW.version_id AND d.state='committed'
 AND r.mode='enabled' AND p.mode='enabled' AND r.policy_revision=p.revision
 AND o.owner_scope_kind='personal' AND o.state='active' AND o.authorization_epoch=r.authorization_epoch
 AND r.bundle_revision=b.revision AND r.source_digest=b.source_digest AND b.body_state='present')
 THEN RAISE EXCEPTION 'curation_authority_required' USING ERRCODE='55000';END IF;RETURN NULL;END $$`,
 `CREATE CONSTRAINT TRIGGER memory_curation_authority_required AFTER INSERT OR UPDATE OF authority ON knowledge_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_require_curation_authority()`,
 `CREATE TABLE memory_claim_usage (
 installation_id UUID NOT NULL,claim_id UUID NOT NULL,signal_key TEXT NOT NULL CHECK(length(signal_key) BETWEEN 1 AND 256),
 signal TEXT NOT NULL CHECK(signal IN('retrieved','delivered','agent_reported_used','user_confirmed','outcome_verified')),
 occurred_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(installation_id,claim_id,signal,signal_key),
 FOREIGN KEY(installation_id,claim_id) REFERENCES knowledge_claims(installation_id,claim_id) ON DELETE CASCADE)`,
]}

export const CURATION_NATIVE_AUTHORITY_MIGRATION={version:102,statements:[
 // Fresh shared installs receive this same definition from the shared contract.
 `DO $curation_grant_migration$ BEGIN
 IF current_schema()<>'memory' THEN RETURN;END IF;
 IF to_regprocedure('shared.memory_current_grant_states(uuid[],uuid[])') IS NOT NULL THEN
  EXECUTE $grant_definition$${SHARED_GRANT_FUNCTIONS[0]}$grant_definition$;
 END IF;
 EXECUTE $trigger_definition$
 CREATE OR REPLACE FUNCTION memory.memory_require_curation_authority() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,memory,shared AS $curation_authority$
 DECLARE epoch BIGINT;
 BEGIN
 IF NEW.authority<>'machine_concluded' THEN RETURN NULL;END IF;
 IF NOT shared.lock_memory_grant_authority(ARRAY[NEW.installation_id],ARRAY[]::uuid[]) THEN
  RAISE EXCEPTION 'curation_authority_required' USING ERRCODE='55000';
 END IF;
 SELECT (current.state->>'authorization_epoch')::bigint INTO epoch
 FROM shared.memory_current_grant_states(ARRAY[NEW.installation_id],ARRAY[]::uuid[]) current
 JOIN memory_installations i ON i.installation_id=current.installation_id
 JOIN memory_curation_policies p ON p.installation_id=i.installation_id
 WHERE i.local_status NOT IN('purging','purged','integrity_error')
  AND current.state @> '{"owner_scope_kind":"personal","status":"active","owner_exists":true,"provider_enabled":true,"curation_input_allowed":true}'::jsonb
 FOR SHARE OF i,p NOWAIT;
 IF NOT EXISTS(
  SELECT 1 FROM memory_curation_decisions d JOIN memory_curation_runs r USING(installation_id,run_id)
  JOIN memory_task_bundles b ON b.installation_id=r.installation_id AND b.bundle_id=r.bundle_id
  JOIN memory_curation_policies p ON p.installation_id=r.installation_id
  WHERE d.installation_id=NEW.installation_id AND d.version_id=NEW.version_id AND d.state='committed'
   AND r.mode='enabled' AND p.mode='enabled' AND r.policy_revision=p.revision AND r.authorization_epoch=epoch
   AND r.bundle_revision=b.revision AND r.source_digest=b.source_digest AND b.body_state='present')
 THEN RAISE EXCEPTION 'curation_authority_required' USING ERRCODE='55000';END IF;
 RETURN NULL;
 END $curation_authority$
 $trigger_definition$;
 END $curation_grant_migration$`,
]}
