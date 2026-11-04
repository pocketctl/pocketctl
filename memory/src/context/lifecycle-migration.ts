import {USAGE_MIGRATION_STATEMENTS} from './usage-aggregation.js'
export const LIFECYCLE_CONTEXT_MIGRATION={version:82,statements:[
 `CREATE TABLE memory_session_scene_frames(installation_id UUID NOT NULL REFERENCES memory_installations ON DELETE CASCADE,session_id TEXT NOT NULL,binding TEXT NOT NULL CHECK(binding~'^[a-f0-9]{64}$'),PRIMARY KEY(installation_id,session_id))`,
 ...['memory_curation_policies','memory_spaces','memory_space_bindings','memory_logical_claims'].map(t=>`CREATE TRIGGER ${t}_context_changed AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION memory_bump_consumption_generation()`),
 ...USAGE_MIGRATION_STATEMENTS,
]}
