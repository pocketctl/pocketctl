export const LIFECYCLE_ASSESSMENT_MIGRATION={version:83,statements:[
 `CREATE TABLE memory_lifecycle_observation_windows(
  installation_id UUID PRIMARY KEY REFERENCES memory_installations ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN('unknown','observed')),started_at TIMESTAMPTZ,last_heartbeat_at TIMESTAMPTZ,
  capability_since_at TIMESTAMPTZ,last_native_delivery_at TIMESTAMPTZ,last_limitation_at TIMESTAMPTZ,
  max_gap_ms INTEGER NOT NULL DEFAULT 300000 CHECK(max_gap_ms BETWEEN 60000 AND 300000),
  settings_hash TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
 `CREATE TABLE memory_lifecycle_assessment_runs(
  installation_id UUID NOT NULL,run_id UUID NOT NULL DEFAULT gen_random_uuid(),claim_id UUID NOT NULL,version_id UUID NOT NULL,
  lifecycle_revision BIGINT NOT NULL,policy_revision BIGINT NOT NULL,model_hash TEXT NOT NULL,input_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,observation_started_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK(state IN('running','completed','blocked','provider_result_unknown','stale')),
  assessment TEXT CHECK(assessment IN('low','retain','unknown')),reason_code TEXT,
  claim_epoch BIGINT NOT NULL DEFAULT 1,claim_expires_at TIMESTAMPTZ, retry_at TIMESTAMPTZ,
  input_tokens BIGINT NOT NULL DEFAULT 0,output_tokens BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),completed_at TIMESTAMPTZ,
  PRIMARY KEY(installation_id,run_id),UNIQUE(installation_id,claim_id,version_id,lifecycle_revision,policy_revision,model_hash,input_hash),
  FOREIGN KEY(installation_id,claim_id) REFERENCES knowledge_claims(installation_id,claim_id) ON DELETE CASCADE,
  FOREIGN KEY(installation_id,version_id) REFERENCES knowledge_versions(installation_id,version_id) ON DELETE CASCADE)`,
 `CREATE FUNCTION memory_reset_lifecycle_observation() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE owner UUID;BEGIN owner:=CASE WHEN TG_OP='DELETE' THEN OLD.installation_id ELSE NEW.installation_id END;
  UPDATE memory_lifecycle_observation_windows SET state='unknown',started_at=NULL,last_heartbeat_at=NULL,capability_since_at=NULL,last_limitation_at=clock_timestamp(),updated_at=clock_timestamp() WHERE installation_id=owner;
  UPDATE memory_claim_lifecycle SET observation_state='unknown',observation_started_at=NULL WHERE installation_id=owner AND(observation_state<>'unknown' OR observation_started_at IS NOT NULL);
  RETURN NULL;END $$`,
 `CREATE TRIGGER memory_context_observation_reset AFTER INSERT OR UPDATE OR DELETE ON memory_context_settings FOR EACH ROW EXECUTE FUNCTION memory_reset_lifecycle_observation()`,
 `CREATE TRIGGER memory_policy_observation_reset AFTER UPDATE OF consume_mode ON memory_curation_policies FOR EACH ROW
  WHEN(OLD.consume_mode IS DISTINCT FROM NEW.consume_mode) EXECUTE FUNCTION memory_reset_lifecycle_observation()`,
 `CREATE FUNCTION memory_reset_lifecycle_assessment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE memory_claim_lifecycle SET value_assessment='unknown',revision=revision+1
  WHERE installation_id=NEW.installation_id AND claim_id=NEW.claim_id;RETURN NULL;END $$`,
 `CREATE TRIGGER memory_head_assessment_reset AFTER UPDATE OF current_version_id ON knowledge_claims FOR EACH ROW
  WHEN(OLD.current_version_id IS DISTINCT FROM NEW.current_version_id) EXECUTE FUNCTION memory_reset_lifecycle_assessment()`,
 `CREATE FUNCTION memory_reset_policy_assessment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE memory_claim_lifecycle SET value_assessment='unknown',revision=revision+1 WHERE installation_id=NEW.installation_id;
  RETURN NULL;END $$`,
 `CREATE TRIGGER memory_policy_assessment_reset AFTER UPDATE OF revision ON memory_curation_policies FOR EACH ROW
  WHEN(OLD.revision IS DISTINCT FROM NEW.revision) EXECUTE FUNCTION memory_reset_policy_assessment()`,
 `CREATE FUNCTION memory_invalidate_lifecycle_observation(owner UUID) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
  UPDATE memory_lifecycle_observation_windows SET state='unknown',started_at=NULL,last_heartbeat_at=NULL,capability_since_at=NULL,last_limitation_at=clock_timestamp(),updated_at=clock_timestamp() WHERE installation_id=owner;
  UPDATE memory_claim_lifecycle SET observation_state='unknown',observation_started_at=NULL WHERE installation_id=owner AND(observation_state<>'unknown' OR observation_started_at IS NOT NULL);
 END $$`,
 `CREATE FUNCTION memory_context_observation_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_TABLE_NAME='memory_context_injections' THEN
   IF NEW.state='delivered' AND NEW.adapter IN('codex-app-server','opencode-server','claude-print-resume') AND EXISTS(
    SELECT 1 FROM memory_context_packs p JOIN memory_curation_policies policy ON policy.installation_id=p.installation_id
    LEFT JOIN memory_retrieval_trajectories t ON t.trajectory_id=p.trajectory_id
    WHERE p.installation_id=NEW.installation_id AND p.pack_id=NEW.pack_id AND p.mode='enabled' AND p.state='ready' AND p.error_code IS NULL
     AND policy.consume_mode='enabled' AND(t.trajectory_id IS NULL OR(t.result_state IN('completed','empty') AND cardinality(t.degraded_components)=0))) THEN
    IF EXISTS(SELECT 1 FROM memory_lifecycle_observation_windows WHERE installation_id=NEW.installation_id
      AND(last_native_delivery_at IS NULL OR last_native_delivery_at<clock_timestamp()-interval '24 hours'
       OR(last_heartbeat_at IS NOT NULL AND last_heartbeat_at<clock_timestamp()-(max_gap_ms*interval '1 millisecond')))) THEN
     PERFORM memory_invalidate_lifecycle_observation(NEW.installation_id);
    END IF;
    INSERT INTO memory_lifecycle_observation_windows(installation_id,state,settings_hash,capability_since_at,last_native_delivery_at)
    VALUES(NEW.installation_id,'unknown','',clock_timestamp(),clock_timestamp())
    ON CONFLICT(installation_id) DO UPDATE SET capability_since_at=COALESCE(memory_lifecycle_observation_windows.capability_since_at,clock_timestamp()),last_native_delivery_at=EXCLUDED.last_native_delivery_at;
   ELSIF NEW.state IN('delivered','skipped','delivery_failed','expired') THEN PERFORM memory_invalidate_lifecycle_observation(NEW.installation_id); END IF;
  ELSIF TG_TABLE_NAME='memory_context_packs' THEN
   IF NEW.mode='shadow' OR NEW.state IN('shadow','failed') OR NEW.error_code IS NOT NULL THEN PERFORM memory_invalidate_lifecycle_observation(NEW.installation_id);END IF;
  ELSIF NEW.result_state IN('degraded','retrieval_failed') OR cardinality(NEW.degraded_components)>0 THEN PERFORM memory_invalidate_lifecycle_observation(NEW.installation_id);
  END IF;RETURN NULL;END $$`,
 `CREATE TRIGGER memory_injection_observation AFTER INSERT OR UPDATE OF state ON memory_context_injections FOR EACH ROW EXECUTE FUNCTION memory_context_observation_outcome()`,
 `CREATE TRIGGER memory_pack_observation AFTER INSERT OR UPDATE OF mode,state,error_code ON memory_context_packs FOR EACH ROW EXECUTE FUNCTION memory_context_observation_outcome()`,
 `CREATE TRIGGER memory_retrieval_observation AFTER INSERT OR UPDATE OF result_state,degraded_components ON memory_retrieval_trajectories FOR EACH ROW EXECUTE FUNCTION memory_context_observation_outcome()`,
]}
