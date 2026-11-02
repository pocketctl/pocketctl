/** Separate user attempts retain the original extraction evidence and configuration. */
export const EXTRACTION_RECOVERY_MIGRATION = {version:77,statements:[
 `ALTER TABLE memory_extraction_runs ADD COLUMN retry_key UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'`,
 `ALTER TABLE memory_extraction_runs DROP CONSTRAINT memory_extraction_runs_policy_bound_key`,
 `ALTER TABLE memory_extraction_runs ADD CONSTRAINT memory_extraction_runs_policy_bound_key UNIQUE(installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,effective_policy_hash,retry_key)`,
]}
