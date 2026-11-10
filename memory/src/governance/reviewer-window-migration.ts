/** Recheck counted human reviewers at the physical transaction boundary.
 * Native roles/revisions are locked separately; local validity dates keep
 * advancing even after an inner service SAVEPOINT has been released.
 * Historical authority imports carry no live candidate TTL stamp and retain
 * their original provenance instead of retroactively requiring current votes. */
export const REVIEWER_WINDOW_MIGRATION={version:99,statements:[
 `CREATE FUNCTION memory_check_publication_reviewer_windows() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF NULLIF(current_setting('pocketctl.candidate_ttl',true),'') IS NULL THEN RETURN NULL;END IF;
  IF EXISTS(SELECT 1 FROM memory_review_decisions d
    LEFT JOIN memory_scope_memberships m ON m.installation_id=NEW.installation_id AND m.membership_id=d.membership_id
    WHERE d.decision_id=ANY(NEW.counted_decision_ids) AND (
      (m.valid_from IS NOT NULL AND m.valid_from>clock_timestamp()) OR (m.valid_until IS NOT NULL AND m.valid_until<=clock_timestamp())
      OR (TG_TABLE_SCHEMA<>'memory' AND (m.membership_id IS NULL OR m.state<>'active')))) THEN
   RAISE EXCEPTION 'reviewer_validity_expired' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
 END $$`,
 `REVOKE ALL ON FUNCTION memory_check_publication_reviewer_windows() FROM PUBLIC`,
 `CREATE CONSTRAINT TRIGGER memory_publication_reviewer_windows AFTER INSERT OR UPDATE ON memory_authority_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION memory_check_publication_reviewer_windows()`,
]} as const
