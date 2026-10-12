/** Existing intervals stay untouched. Time edits invalidate frozen consumers. */
export const CLAIM_VERSION_INTERVAL_MIGRATION={version:55,statements:[
 `CREATE TRIGGER knowledge_versions_revision_interval_update AFTER UPDATE OF effective_from,effective_until ON knowledge_versions
  FOR EACH ROW WHEN (OLD.effective_from IS DISTINCT FROM NEW.effective_from OR OLD.effective_until IS DISTINCT FROM NEW.effective_until)
  EXECUTE FUNCTION memory_bump_consumption_generation()`,
]} as const
