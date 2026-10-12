/** Same authorization domain only; no cross-reader cache table. */
export const SOURCE_LINEAGE_MIGRATION={version:64,statements:[
 `ALTER TABLE memory_extraction_runs DROP CONSTRAINT memory_extraction_runs_policy_bound_key`,
 `ALTER TABLE memory_extraction_runs ADD CONSTRAINT memory_extraction_runs_policy_bound_key UNIQUE(installation_id,episode_id,episode_source_digest,extractor_version,prompt_version,model_config_hash,effective_policy_hash)`
]} as const
