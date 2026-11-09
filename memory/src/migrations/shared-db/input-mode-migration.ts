/** Persist the generation at run start; an old snapshot cannot finish after
 * pause/resume, even if the visible mode name has returned to legacy-feed. */
export const SOURCE_INPUT_MODE_MIGRATION={version:89,statements:[
 `ALTER TABLE memory_snapshot_runs ADD COLUMN source_mode_generation BIGINT CHECK(source_mode_generation>0)`,
]} as const
